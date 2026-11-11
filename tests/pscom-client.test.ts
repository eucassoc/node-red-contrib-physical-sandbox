// Signing in to PS.com, saving a record in two ways and opening one: tests for src/core/pscom-client.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Moved, Offline, PsComClient, Refused, SignIn, Taken, tokenFileIn } from '../src/core/pscom-client.js';
import { FakePsCom } from './helpers/fake-pscom.js';

const appRecord = JSON.parse(readFileSync(new URL('./fixtures/app-record-v3.json', import.meta.url), 'utf8'));

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ps-client-'));
const record = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 3,
  equipment: { site: { id: 'local' }, devices: [{ id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }] },
  traces: {}, ...extra,
});

async function setup(opts: { signedIn?: boolean; isLocalMachine?: (name: string) => boolean } = {}) {
  const fake = await new FakePsCom().start();
  const tokenFile = tokenFileIn(tmp());
  const client = new PsComClient({ base: fake.base, tokenFile, pollMs: 0, isLocalMachine: opts.isLocalMachine });
  if (opts.signedIn !== false) {
    await client.loginStart();
    assert.equal(await client.loginPoll(), 'approved');
  }
  return { fake, client, tokenFile };
}

test('the token file sits in <userDir>/physical-sandbox/', () => {
  assert.equal(tokenFileIn('/u'), join('/u', 'physical-sandbox', 'ps-com-token.json'));
});

test('signing in: a code to enter at /vr, pending until approved, then the token is kept 0600 with the handle', async () => {
  const fake = await new FakePsCom().start();
  try {
    fake.approveAfter = 2;
    const tokenFile = tokenFileIn(tmp());
    const client = new PsComClient({ base: fake.base + '/', tokenFile, pollMs: 0 });
    assert.deepEqual(client.status(), { signedIn: false, handle: null });
    assert.deepEqual(await client.loginStart(), { userCode: '123456', url: `${fake.base}/vr` });
    assert.equal(await client.loginPoll(), 'pending');
    assert.equal(await client.loginPoll(), 'pending');
    assert.equal(await client.loginPoll(), 'approved');
    const kept = JSON.parse(readFileSync(tokenFile, 'utf8'));
    assert.equal(kept.base, fake.base);
    assert.equal(kept.token, 'tok-1');
    assert.equal(kept.handle, 'ada');
    assert.ok(Date.parse(kept.expiresAt) > Date.now() + 3000 * 1000);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.deepEqual(client.status(), { signedIn: true, handle: 'ada' });
    // the approval is consumed once; with no login under way a poll says what the file says
    assert.equal(await client.loginPoll(), 'approved');
    assert.equal(fake.calls.filter((c) => c.path === '/api/vr/poll').length, 3);
  } finally { await fake.stop(); }
});

test('signing in: an expired code answers expired and keeps nothing', async () => {
  const fake = await new FakePsCom().start();
  try {
    fake.expireCodes = true;
    const tokenFile = tokenFileIn(tmp());
    const client = new PsComClient({ base: fake.base, tokenFile, pollMs: 0 });
    await client.loginStart();
    assert.equal(await client.loginPoll(), 'expired');
    assert.deepEqual(client.status(), { signedIn: false, handle: null });
    assert.throws(() => statSync(tokenFile));
  } finally { await fake.stop(); }
});

test('signing in: gives up after 600 s without asking again', async () => {
  const fake = await new FakePsCom().start();
  try {
    fake.approveAfter = 1000;
    let now = 1_000_000;
    const client = new PsComClient({ base: fake.base, tokenFile: tokenFileIn(tmp()), pollMs: 0, now: () => now });
    await client.loginStart();
    assert.equal(await client.loginPoll(), 'pending');
    now += 600_000;
    assert.equal(await client.loginPoll(), 'expired');
    assert.equal(fake.calls.filter((c) => c.path === '/api/vr/poll').length, 1);
  } finally { await fake.stop(); }
});

test('signing in: never two polls at once; sooner than 3 s apart answers pending without a request', async () => {
  const fake = await new FakePsCom().start();
  try {
    fake.approveAfter = 1;
    fake.pollDelayMs = 30;
    let now = 0;
    const client = new PsComClient({ base: fake.base, tokenFile: tokenFileIn(tmp()), now: () => now });
    const polls = () => fake.calls.filter((c) => c.path === '/api/vr/poll').length;
    await client.loginStart();
    now = 2999; // too soon after the start
    const started = Date.now();
    assert.equal(await client.loginPoll(), 'pending');
    assert.ok(Date.now() - started < 1000, 'answered at once, without waiting');
    assert.equal(polls(), 0);
    now = 3000;
    const [a, b] = [client.loginPoll(), client.loginPoll()];
    assert.equal(a, b);
    assert.equal(await a, 'pending');
    assert.equal(polls(), 1);
    assert.equal(fake.maxPollsInFlight, 1);
    now = 5999; // too soon after that poll
    assert.equal(await client.loginPoll(), 'pending');
    assert.equal(polls(), 1);
    now = 6000;
    assert.equal(await client.loginPoll(), 'approved');
    assert.equal(polls(), 2);
  } finally { await fake.stop(); }
});

test('status comes from the token file only: another base, an expired token or a bad file is signed out', async () => {
  const dir = tmp();
  const tokenFile = tokenFileIn(dir);
  const calls: string[] = [];
  const fetchImpl = async (url: string) => { calls.push(url); throw new Error('no network'); };
  const client = new PsComClient({ base: 'https://ps.test', tokenFile, fetchImpl });
  const write = (kept: unknown) => { writeFileSync(tokenFile, JSON.stringify(kept)); };
  const later = new Date(Date.now() + 3600_000).toISOString();
  mkdirSync(join(dir, 'physical-sandbox'), { recursive: true });
  write({ base: 'https://ps.test', token: 't', expiresAt: later, handle: 'bob' });
  assert.deepEqual(client.status(), { signedIn: true, handle: 'bob' });
  write({ base: 'https://ps.test', token: 't', expiresAt: later });
  assert.deepEqual(client.status(), { signedIn: true, handle: null });
  write({ base: 'https://other.test', token: 't', expiresAt: later, handle: 'bob' });
  assert.deepEqual(client.status(), { signedIn: false, handle: null });
  write({ base: 'https://ps.test', token: 't', expiresAt: new Date(Date.now() - 1000).toISOString(), handle: 'bob' });
  assert.deepEqual(client.status(), { signedIn: false, handle: null });
  writeFileSync(tokenFile, 'not json');
  assert.deepEqual(client.status(), { signedIn: false, handle: null });
  assert.deepEqual(calls, []);
});

test('save as new: version 1 under the signed-in handle; a bare name gets the handle', async () => {
  const { fake, client } = await setup();
  try {
    assert.deepEqual(await client.saveRecord('ada/walk', record(), 'new'), { ref: 'ada/walk', version: '1', unchanged: false });
    assert.deepEqual(await client.saveRecord('run', record(), 'new'), { ref: 'ada/run', version: '1', unchanged: false });
    const put = fake.calls.find((c) => c.method === 'PUT')!;
    assert.equal(put.path, '/api/catalog/ada/walk/record?new=1&visibility=private');
    assert.equal(put.auth, 'Bearer tok-1');
    assert.deepEqual(fake.record('ada', 'walk', '1'), record());
  } finally { await fake.stop(); }
});

test('save as new over an existing name is Taken', async () => {
  const { fake, client } = await setup();
  try {
    fake.seed('ada', 'walk', '1', record());
    await assert.rejects(client.saveRecord('ada/walk', record({ name: 'x' }), 'new'), Taken);
  } finally { await fake.stop(); }
});

test('save over: the next version from the base; the same bytes are unchanged; another latest is Moved', async () => {
  const { fake, client } = await setup();
  try {
    fake.seed('ada', 'walk', '1', record());
    assert.deepEqual(await client.saveRecord('ada/walk', record({ name: 'b' }), 'over', '1'), { ref: 'ada/walk', version: '2', unchanged: false });
    assert.ok(fake.calls.some((c) => c.path === '/api/catalog/ada/walk/record?base=1&visibility=private'));
    // the same bytes as the latest: no version, even from an old base
    assert.deepEqual(await client.saveRecord('ada/walk', record({ name: 'b' }), 'over', '1'), { ref: 'ada/walk', version: '2', unchanged: true });
    const err = await client.saveRecord('ada/walk', record({ name: 'c' }), 'over', '1').catch((e) => e);
    assert.ok(err instanceof Moved);
    assert.equal(err.latest, '2');
  } finally { await fake.stop(); }
});

test('saving signed out is SignIn without a request; a token the server refuses is forgotten', async () => {
  const { fake, client, tokenFile } = await setup({ signedIn: false });
  try {
    await assert.rejects(client.saveRecord('walk', record(), 'new'), SignIn);
    assert.equal(fake.calls.length, 0);
    await client.loginStart();
    await client.loginPoll();
    fake.token = 'tok-2'; // the kept token is no longer good
    await assert.rejects(client.saveRecord('walk', record(), 'new'), SignIn);
    assert.deepEqual(client.status(), { signedIn: false, handle: null });
    assert.throws(() => statSync(tokenFile));
  } finally { await fake.stop(); }
});

test('PS.com unreachable is Offline; 5xx and other refusals are Refused with code and status', async () => {
  const { fake, client } = await setup();
  fake.failRecord = [503, { error: 'busy' }];
  let err = await client.saveRecord('walk', record(), 'new').catch((e) => e);
  assert.ok(err instanceof Refused);
  assert.equal(err.code, 'busy');
  assert.equal(err.status, 503);
  fake.failRecord = [429, { error: 'limit' }];
  err = await client.saveRecord('walk', record(), 'new').catch((e) => e);
  assert.deepEqual([err instanceof Refused, err.code, err.status], [true, 'limit', 429]);
  fake.failRecord = [413, {}];
  err = await client.saveRecord('walk', record(), 'new').catch((e) => e);
  assert.deepEqual([err instanceof Refused, err.code, err.status], [true, 'HTTP 413', 413]);
  await fake.stop();
  await assert.rejects(client.saveRecord('walk', record(), 'new'), Offline);
});

test('a record naming a robot only this machine has is refused before any request', async () => {
  const { fake, client } = await setup({ isLocalMachine: (name) => name === 'myarm' });
  try {
    const before = fake.calls.length;
    const local = record();
    (local.equipment.devices[0] as any).product = 'myarm';
    const err = await client.saveRecord('walk', local, 'new').catch((e) => e);
    assert.ok(err instanceof Refused);
    assert.equal(err.code, 'local-machine');
    assert.equal(err.message, '手元のロボット myarm は PS.com にありません。psbx push でロボットを上げてから保存してください');
    assert.equal(fake.calls.length, before);
  } finally { await fake.stop(); }
});

test('a record the PS.com app wrote (bare ids such as so101, scout) is sent unchanged', async () => {
  const { fake, client } = await setup({ isLocalMachine: (name) => name === 'myarm' });
  try {
    const products = appRecord.equipment.devices.map((d: any) => d.product);
    assert.ok(products.includes('so101') && products.includes('scout'));
    assert.deepEqual(await client.saveRecord('app', appRecord, 'new'), { ref: 'ada/app', version: '1', unchanged: false });
    assert.deepEqual(fake.record('ada', 'app', '1'), appRecord);
  } finally { await fake.stop(); }
});

test('opening a record: the version asked for, the latest at open time, and whether it is mine', async () => {
  const { fake, client } = await setup();
  try {
    fake.seed('ada', 'walk', '1', record({ name: 'one' }));
    fake.seed('ada', 'walk', '2', record({ name: 'two' }));
    fake.seed('bob', 'dance', '3', record({ name: 'bob' }), { visibility: 'public' });
    fake.seed('bob', 'secret', '1', record(), { visibility: 'private' });
    let opened = await client.openRecord('ada/walk:1');
    assert.deepEqual([opened.record.name, opened.version, opened.latest, opened.own], ['one', '1', '2', true]);
    opened = await client.openRecord('ada/walk');
    assert.deepEqual([opened.record.name, opened.version, opened.latest, opened.own], ['two', '2', '2', true]);
    opened = await client.openRecord('bob/dance');
    assert.deepEqual([opened.record.name, opened.version, opened.latest, opened.own], ['bob', '3', '3', false]);
    const err = await client.openRecord('bob/secret').catch((e) => e);
    assert.deepEqual([err instanceof Refused, err.status], [true, 404]);
  } finally { await fake.stop(); }
});

test('opening a public record signed out is not mine; an item that is not a record is refused', async () => {
  const { fake, client } = await setup({ signedIn: false });
  try {
    fake.seed('ada', 'walk', '1', record(), { visibility: 'public' });
    fake.seed('ada', 'arm', '1', {}, { visibility: 'public', kind: 'machine' });
    const opened = await client.openRecord('ada/walk');
    assert.equal(opened.own, false);
    assert.ok(fake.calls.every((c) => c.auth === undefined));
    const err = await client.openRecord('ada/arm').catch((e) => e);
    assert.deepEqual([err instanceof Refused, err.code], [true, 'not-a-record']);
  } finally { await fake.stop(); }
});
