// Robots from three places: tests for src/core/machines.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMachines, resolveBundle, serveBundleFile } from '../src/core/machines.js';
import { forgetBundles } from '../src/pscom/catalog-client.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ps-machines-'));
const BASE = 'https://ps.test';

const bundleJson = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  id, displayName: `${id} name`, rootLink: 'base',
  links: { base: { visuals: [{ mesh: 'assets/base.bin', texture: 'assets/base.png', origin: {} }] } }, joints: [], ...extra,
});

function makeBundle(dir: string, id: string): void {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'bundle.json'), bundleJson(id));
  writeFileSync(join(dir, 'assets', 'base.bin'), 'mesh');
  writeFileSync(join(dir, 'assets', 'base.png'), 'png');
  writeFileSync(join(dir, 'assets', 'secret.bin'), 'not named by the bundle');
}

type Call = { url: string; auth?: string };
function fakeFetch(calls: Call[] = [], over: Record<string, any> = {}) {
  return async (url: string, init?: any) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const u = new URL(url);
    if (u.pathname === '/api/catalog/search') {
      const kind = u.searchParams.get('kind');
      if (u.searchParams.get('owner') === 'me' && !init?.headers?.Authorization) return { ok: false, status: 401, json: async () => ({}) };
      const items = u.searchParams.get('owner') === 'me'
        ? [{ handle: 'me', name: 'mine', latest_version: '2', display: { ja: '自分の', en: 'Mine' }, kind }]
        : kind === 'machine'
          ? [{ handle: 'physical-sandbox', name: 'so101', latest_version: '1', display: { ja: 'SO-101', en: 'SO-101' }, kind }]
          : [{ handle: 'physical-sandbox', name: 'crate', latest_version: '1', display: { en: 'Crate' }, kind }];
      return { ok: true, status: 200, json: async () => ({ items }) };
    }
    if (u.pathname.endsWith('/manifest')) return { ok: true, status: 200, json: async () => ({ bundle: 'bundle.json', kind: 'machine' }) };
    return over.other ?? { ok: false, status: 404, json: async () => ({}) };
  };
}

function opts(over: Record<string, any> = {}) {
  return { catalogBase: BASE, fetchImpl: fakeFetch(), cacheRoot: tmp(), localDirs: [] as string[], ...over };
}

test('lists the catalog, the psbx cache and local folders, each tagged with its source', async () => {
  const cacheRoot = tmp();
  makeBundle(join(cacheRoot, 'catalog', 'physical-sandbox', 'g1', '3'), 'g1');
  writeFileSync(join(cacheRoot, 'catalog', 'physical-sandbox', 'g1', '3', 'manifest.json'), JSON.stringify({ kind: 'machine', display: { ja: 'G1 日本語' } }));
  const localDir = tmp();
  makeBundle(join(localDir, 'myarm'), 'myarm');
  makeBundle(localDir, 'ignored-id'); // the folder itself also holds a bundle
  const { machines, offline } = await listMachines(opts({ cacheRoot, localDirs: [localDir] }));
  assert.equal(offline, false);
  assert.deepEqual(machines.map((m) => [m.ref, m.source, m.kind]), [
    ['physical-sandbox/so101:1', 'catalog', 'machine'],
    ['physical-sandbox/crate:1', 'catalog', 'object'],
    ['physical-sandbox/g1:3', 'cache', 'machine'],
    [localDir.split('/').pop(), 'local', 'machine'],
    ['myarm', 'local', 'machine'],
  ]);
  assert.equal(machines[0].label, 'SO-101');
  assert.equal(machines[1].label, 'Crate');
  assert.equal(machines[2].label, 'G1 日本語');
  assert.equal(machines[4].label, 'myarm name');
});

test('signed in, the catalog also lists the account\'s own robots with the bearer token', async () => {
  const calls: Call[] = [];
  const { machines } = await listMachines(opts({ fetchImpl: fakeFetch(calls), token: 'tok' }));
  assert.ok(machines.some((m) => m.ref === 'me/mine:2' && m.source === 'catalog'));
  assert.ok(calls.some((c) => c.url.includes('owner=me') && c.auth === 'Bearer tok'));
  assert.ok(calls.every((c) => c.url.includes('limit=500')));
});

test('signed out sends no owner=me request, and a 401 on it is ignored', async () => {
  const calls: Call[] = [];
  const { machines, offline } = await listMachines(opts({ fetchImpl: fakeFetch(calls) }));
  assert.ok(!calls.some((c) => c.url.includes('owner=me')));
  assert.equal(offline, false);
  assert.equal(machines.length, 2);
});

test('a network failure leaves the catalog part empty and sets offline, local robots still listed', async () => {
  const localDir = tmp();
  makeBundle(join(localDir, 'myarm'), 'myarm');
  const { machines, offline } = await listMachines(opts({
    localDirs: [localDir], fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  }));
  assert.equal(offline, true);
  assert.deepEqual(machines.map((m) => m.source), ['local']);
});

test('a bare product name resolves to a local bundle before anything else', async () => {
  const localDir = tmp();
  makeBundle(join(localDir, 'so101'), 'so101');
  const calls: Call[] = [];
  const r = await resolveBundle('so101', opts({ localDirs: [localDir], fetchImpl: fakeFetch(calls) }));
  assert.equal(r.bundleUrl, '/physical-sandbox/bundles/local/0/so101/bundle.json');
  assert.equal(r.meshUrl('assets/base.bin'), '/physical-sandbox/bundles/local/0/so101/assets/base.bin');
  assert.equal(calls.length, 0);
});

test('a bare name with no local folder falls to the cache\'s physical-sandbox latest, never the catalog', async () => {
  const cacheRoot = tmp();
  makeBundle(join(cacheRoot, 'catalog', 'physical-sandbox', 'so101', '2'), 'so101');
  writeFileSync(join(cacheRoot, 'catalog', 'physical-sandbox', 'so101', 'latest'), '2\n');
  const calls: Call[] = [];
  const r = await resolveBundle('so101', opts({ cacheRoot, fetchImpl: fakeFetch(calls) }));
  assert.equal(r.bundleUrl, '/physical-sandbox/bundles/cache/physical-sandbox/so101/2/bundle.json');
  await assert.rejects(resolveBundle('nowhere', opts({ cacheRoot, fetchImpl: fakeFetch(calls) })));
  assert.equal(calls.length, 0);
});

test('handle/name:version uses the cache when it holds that version, else the catalog', async () => {
  const cacheRoot = tmp();
  makeBundle(join(cacheRoot, 'catalog', 'physical-sandbox', 'g1', '3'), 'g1');
  const cached = await resolveBundle('physical-sandbox/g1:3', opts({ cacheRoot }));
  assert.equal(cached.bundleUrl, '/physical-sandbox/bundles/cache/physical-sandbox/g1/3/bundle.json');
  forgetBundles();
  const calls: Call[] = [];
  const remote = await resolveBundle('physical-sandbox/g1:4', opts({ cacheRoot, fetchImpl: fakeFetch(calls) }));
  assert.equal(remote.bundleUrl, `${BASE}/api/catalog/physical-sandbox/g1/4/files/bundle.json`);
  assert.equal(remote.meshUrl('assets/base.bin'), `${BASE}/api/catalog/physical-sandbox/g1/4/files/assets/base.bin`);
});

test('serveBundleFile serves bundle.json and the assets it names, local and cache', () => {
  const localDir = tmp(); const cacheRoot = tmp();
  makeBundle(join(localDir, 'arm'), 'arm');
  makeBundle(localDir, 'self');
  makeBundle(join(cacheRoot, 'catalog', 'h1', 'n1', '1'), 'n1');
  const roots = { cacheRoot, localDirs: [localDir] };
  assert.match(serveBundleFile('local', '0/arm/bundle.json', roots)!, /arm\/bundle\.json$/);
  assert.match(serveBundleFile('local', '0/arm/assets/base.bin', roots)!, /arm\/assets\/base\.bin$/);
  assert.match(serveBundleFile('local', '0/arm/assets/base.png', roots)!, /base\.png$/);
  assert.match(serveBundleFile('local', '0/@/bundle.json', roots)!, /bundle\.json$/);
  assert.match(serveBundleFile('cache', 'h1/n1/1/assets/base.bin', roots)!, /base\.bin$/);
});

test('serveBundleFile refuses files the bundle does not name and non-assets', () => {
  const localDir = tmp();
  makeBundle(join(localDir, 'arm'), 'arm');
  writeFileSync(join(localDir, 'arm', 'notes.txt'), 'x');
  const roots = { cacheRoot: tmp(), localDirs: [localDir] };
  assert.equal(serveBundleFile('local', '0/arm/assets/secret.bin', roots), null);
  assert.equal(serveBundleFile('local', '0/arm/notes.txt', roots), null);
  assert.equal(serveBundleFile('local', '0/arm/assets', roots), null);
  assert.equal(serveBundleFile('local', '1/arm/bundle.json', roots), null);
  assert.equal(serveBundleFile('elsewhere', '0/arm/bundle.json', roots), null);
});

test('serveBundleFile refuses .., absolute paths, backslashes and NUL', () => {
  const outer = tmp();
  const localDir = join(outer, 'robots');
  makeBundle(join(localDir, 'arm'), 'arm');
  writeFileSync(join(outer, 'outside.txt'), 'secret');
  const roots = { cacheRoot: tmp(), localDirs: [localDir] };
  for (const p of [
    '0/arm/../../outside.txt', '0/../outside.txt', '0/arm/assets/../../../outside.txt', '/etc/passwd',
    '0/arm//assets/base.bin', '0/arm/assets\\base.bin', '0/arm/assets/base.bin\0', '0/%2e%2e/bundle.json',
    '0/arm/./bundle.json', '',
  ]) assert.equal(serveBundleFile('local', p, roots), null, JSON.stringify(p));
  assert.equal(serveBundleFile('cache', '../../x/y/z', roots), null);
});

test('a bundle.json that names a path outside assets/ or with .. is not honoured', () => {
  const outer = tmp();
  const localDir = join(outer, 'robots');
  mkdirSync(join(localDir, 'evil'), { recursive: true });
  writeFileSync(join(outer, 'outside.txt'), 'secret');
  writeFileSync(join(localDir, 'evil', 'bundle.json'), JSON.stringify({
    id: 'evil', links: { a: { visuals: [{ mesh: 'assets/../../../outside.txt' }, { mesh: '/etc/passwd' }, { mesh: 'bundle.json' }] } },
  }));
  const roots = { cacheRoot: tmp(), localDirs: [localDir] };
  assert.equal(serveBundleFile('local', '0/evil/assets/../../../outside.txt', roots), null);
  assert.equal(serveBundleFile('local', '0/evil/assets/%2e%2e', roots), null);
});

test('serveBundleFile refuses a symlink that leads out of the folder', () => {
  const outer = tmp();
  const localDir = join(outer, 'robots');
  makeBundle(join(localDir, 'arm'), 'arm');
  writeFileSync(join(outer, 'outside.bin'), 'secret');
  // a named mesh replaced by a link to a file outside
  symlinkSync(join(outer, 'outside.bin'), join(localDir, 'arm', 'assets', 'linked.bin'));
  writeFileSync(join(localDir, 'arm', 'bundle.json'), bundleJson('arm', {
    links: { base: { visuals: [{ mesh: 'assets/linked.bin' }, { mesh: 'assets/base.bin' }] } },
  }));
  // an assets folder that is a link out
  mkdirSync(join(outer, 'elsewhere', 'assets'), { recursive: true });
  writeFileSync(join(outer, 'elsewhere', 'assets', 'base.bin'), 'secret');
  mkdirSync(join(localDir, 'tricky'));
  writeFileSync(join(localDir, 'tricky', 'bundle.json'), bundleJson('tricky'));
  symlinkSync(join(outer, 'elsewhere', 'assets'), join(localDir, 'tricky', 'assets'));
  // a bundle folder that is a link out of the root, and a bundle.json that is one
  mkdirSync(join(outer, 'stray'));
  makeBundle(join(outer, 'stray'), 'stray');
  symlinkSync(join(outer, 'stray'), join(localDir, 'stray'));
  mkdirSync(join(localDir, 'linkedjson'));
  symlinkSync(join(outer, 'stray', 'bundle.json'), join(localDir, 'linkedjson', 'bundle.json'));
  const roots = { cacheRoot: tmp(), localDirs: [localDir] };
  assert.equal(serveBundleFile('local', '0/arm/assets/linked.bin', roots), null);
  assert.ok(serveBundleFile('local', '0/arm/assets/base.bin', roots));
  assert.equal(serveBundleFile('local', '0/tricky/assets/base.bin', roots), null);
  assert.equal(serveBundleFile('local', '0/stray/bundle.json', roots), null);
  assert.equal(serveBundleFile('local', '0/linkedjson/bundle.json', roots), null);
});
