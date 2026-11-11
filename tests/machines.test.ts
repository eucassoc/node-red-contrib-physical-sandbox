// Robots from three places: tests for src/core/machines.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCatalogBundleFile, listMachines, meshUrlOf, resolveBundle, serveBundleFile } from '../src/core/machines.js';

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
  assert.equal(meshUrlOf(r, 'assets/base.bin'), '/physical-sandbox/bundles/local/0/so101/assets/base.bin');
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
  const calls: Call[] = [];
  const remote = await resolveBundle('physical-sandbox/g1:4', opts({ cacheRoot, fetchImpl: fakeFetch(calls) }));
  assert.deepEqual(remote, {
    source: 'catalog', bundleUrl: '/physical-sandbox/bundles/catalog/physical-sandbox/g1/4/bundle.json',
    meshBase: '/physical-sandbox/bundles/catalog/physical-sandbox/g1/4/',
  });
  assert.equal(meshUrlOf(remote, 'assets/base.bin'), '/physical-sandbox/bundles/catalog/physical-sandbox/g1/4/assets/base.bin');
  assert.throws(() => meshUrlOf(remote, '../x'));
  JSON.stringify(remote); // plain data, nothing to lose on the way to the browser
});

/** A catalog with one private robot (404 without the token) and one public one. */
function catalogWithPrivate(calls: Call[] = []) {
  const files: Record<string, string> = {
    'alice/secret/1/bundle.json': bundleJson('secret'), 'alice/secret/1/assets/base.bin': 'private mesh',
    'alice/secret/1/assets/base.png': 'png', 'alice/secret/1/assets/other.bin': 'not named',
  };
  return async (url: string, init?: any) => {
    const auth = init?.headers?.Authorization;
    calls.push({ url, auth });
    const path = new URL(url).pathname.replace('/api/catalog/', '');
    if (auth !== 'Bearer tok') return { ok: false, status: 404, json: async () => ({}) };
    if (path === 'alice/secret/1/manifest') return { ok: true, status: 200, json: async () => ({ bundle: 'bundle.json' }) };
    const m = /^(.*)\/files\/(.*)$/.exec(path);
    const body = m ? files[`${m[1]}/${m[2]}`] : undefined;
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body), arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
}

test('a private catalog robot resolves and serves through Node-RED with the token, and not without', async () => {
  const calls: Call[] = [];
  const o = opts({ fetchImpl: catalogWithPrivate(calls), token: 'tok' });
  const r = await resolveBundle('alice/secret:1', o);
  assert.equal(r.source, 'catalog');
  assert.equal(r.bundleUrl, '/physical-sandbox/bundles/catalog/alice/secret/1/bundle.json');
  const file = { catalogBase: BASE, fetchImpl: o.fetchImpl, token: 'tok' };
  const bundle = await fetchCatalogBundleFile('alice/secret/1', 'bundle.json', file);
  assert.equal(bundle!.contentType, 'application/json');
  assert.equal(JSON.parse(bundle!.bytes.toString()).id, 'secret');
  const mesh = await fetchCatalogBundleFile('alice/secret/1', 'assets/base.bin', file);
  assert.equal(mesh!.bytes.toString(), 'private mesh');
  assert.equal(mesh!.contentType, 'application/octet-stream');
  assert.equal((await fetchCatalogBundleFile('alice/secret/1', 'assets/base.png', file))!.contentType, 'image/png');
  assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
  // without the token the catalog says 404
  await assert.rejects(resolveBundle('alice/secret:1', opts({ fetchImpl: catalogWithPrivate() })));
  assert.equal(await fetchCatalogBundleFile('alice/secret/1', 'bundle.json', { ...file, token: undefined }), null);
});

test('fetchCatalogBundleFile applies the same allowlist and path checks', async () => {
  const file = { catalogBase: BASE, fetchImpl: catalogWithPrivate(), token: 'tok' };
  for (const p of ['assets/other.bin', 'manifest.json', 'assets/../bundle.json', '../x', '/etc/passwd', 'assets\\base.bin', 'assets//base.bin', 'assets/base.bin\0', '']) {
    assert.equal(await fetchCatalogBundleFile('alice/secret/1', p, file), null, JSON.stringify(p));
  }
  assert.equal(await fetchCatalogBundleFile('alice/secret/../1', 'bundle.json', file), null);
  assert.equal(await fetchCatalogBundleFile('alice/secret', 'bundle.json', file), null);
});

test('the same bare name in a local folder and in the cache: local wins', async () => {
  const localDir = tmp(); const cacheRoot = tmp();
  makeBundle(join(localDir, 'so101'), 'so101');
  makeBundle(join(cacheRoot, 'catalog', 'physical-sandbox', 'so101', '2'), 'so101');
  writeFileSync(join(cacheRoot, 'catalog', 'physical-sandbox', 'so101', 'latest'), '2');
  const r = await resolveBundle('so101', opts({ cacheRoot, localDirs: [localDir] }));
  assert.equal(r.source, 'local');
});

test('names starting with a dot (psbx partial downloads) are not listed', async () => {
  const localDir = tmp(); const cacheRoot = tmp();
  makeBundle(join(localDir, '.hidden'), 'hidden');
  makeBundle(join(cacheRoot, 'catalog', 'physical-sandbox', 'g1', '.4.partial-123'), 'g1');
  makeBundle(join(cacheRoot, 'catalog', 'physical-sandbox', 'g1', '3'), 'g1');
  const { machines } = await listMachines(opts({ cacheRoot, localDirs: [localDir] }));
  assert.deepEqual(machines.filter((m) => m.source !== 'catalog').map((m) => m.ref), ['physical-sandbox/g1:3']);
});

test('a stalled catalog does not hold up the other rows beyond the timeout', async () => {
  const localDir = tmp();
  makeBundle(join(localDir, 'myarm'), 'myarm');
  const stalled = (_url: string, init?: any) => new Promise<any>((_, reject) => {
    const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's own timer does not hold the loop
    init?.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('aborted')); });
  });
  const started = Date.now();
  const { machines, offline } = await listMachines(opts({ localDirs: [localDir], fetchImpl: stalled, timeoutMs: 50 }));
  assert.ok(Date.now() - started < 2000);
  assert.equal(offline, true);
  assert.deepEqual(machines.map((m) => m.ref), ['myarm']);
});

test('the catalog queries run in parallel', async () => {
  let open = 0; let peak = 0;
  const slow = async (url: string, init?: any) => {
    open++; peak = Math.max(peak, open);
    await new Promise((r) => setTimeout(r, 20));
    open--;
    return fakeFetch()(url, init);
  };
  await listMachines(opts({ fetchImpl: slow, token: 'tok' }));
  assert.equal(peak, 4);
});

test('serveBundleFile against the cache source refuses absolute paths and symlinks out', () => {
  const outer = tmp();
  const cacheRoot = join(outer, 'cache');
  makeBundle(join(cacheRoot, 'catalog', 'h1', 'n1', '1'), 'n1');
  writeFileSync(join(outer, 'outside.bin'), 'secret');
  const v1 = join(cacheRoot, 'catalog', 'h1', 'n1', '1');
  symlinkSync(join(outer, 'outside.bin'), join(v1, 'assets', 'linked.bin'));
  writeFileSync(join(v1, 'bundle.json'), bundleJson('n1', { links: { base: { visuals: [{ mesh: 'assets/linked.bin' }, { mesh: 'assets/base.bin' }] } } }));
  mkdirSync(join(outer, 'stray'));
  makeBundle(join(outer, 'stray'), 'stray');
  symlinkSync(join(outer, 'stray'), join(cacheRoot, 'catalog', 'h1', 'n1', '2'));
  const roots = { cacheRoot, localDirs: [] as string[] };
  assert.ok(serveBundleFile('cache', 'h1/n1/1/assets/base.bin', roots));
  for (const p of ['/etc/passwd', '/h1/n1/1/bundle.json', join(outer, 'outside.bin'), 'h1/n1/1/assets/linked.bin', 'h1/n1/2/bundle.json', 'h1/n1/../../../outside.bin'])
    assert.equal(serveBundleFile('cache', p, roots), null, p);
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

test('only meshes (.bin) and pictures (.png, .jpg, .jpeg, .webp) under assets/ are served, from a folder or the catalog', async () => {
  const root = tmp();
  const dir = join(root, 'arm');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const named = ['assets/m.bin', 'assets/t.png', 'assets/t.jpg', 'assets/t.JPEG', 'assets/t.webp', 'assets/p.html', 'assets/s.js', 'assets/v.svg', 'assets/n'];
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify({ id: 'arm', links: { base: { visuals: named.map((mesh) => ({ mesh })) } } }));
  for (const rel of named) writeFileSync(join(dir, rel), 'x');
  const roots = { cacheRoot: tmp(), localDirs: [root] };
  for (const rel of named.slice(0, 5)) assert.ok(serveBundleFile('local', `0/arm/${rel}`, roots), rel);
  for (const rel of named.slice(5)) assert.equal(serveBundleFile('local', `0/arm/${rel}`, roots), null, rel);

  const catalogFetch = async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/manifest')) return { ok: true, status: 200, json: async () => ({ bundle: 'bundle.json' }) };
    const body = path.endsWith('/bundle.json') ? JSON.stringify({ links: { base: { visuals: named.map((mesh) => ({ mesh })) } } }) : 'x';
    return { ok: true, status: 200, json: async () => JSON.parse(body), arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  const got = await fetchCatalogBundleFile('ada/arm/1', 'assets/t.webp', { catalogBase: BASE, fetchImpl: catalogFetch as any });
  assert.equal(got?.contentType, 'image/webp');
  assert.equal(await fetchCatalogBundleFile('ada/arm/1', 'assets/p.html', { catalogBase: BASE, fetchImpl: catalogFetch as any }), null);
});
