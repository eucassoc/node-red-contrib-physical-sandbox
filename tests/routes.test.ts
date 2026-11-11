// The plugin's routes on the admin app. Tests for src/plugin/routes.ts (with the hub behind them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createHub } from '../src/plugin/hub.js';
import { registerRoutes, safeName, WORDS } from '../src/plugin/routes.js';
import { WORDS as PANE_WORDS } from '../src/pane/words.js';
import { readSettings } from '../src/plugin/settings.js';
import { pending } from '../src/core/unsent.js';
import { intrinsicsFromFov, extrinsicsFromPose, projectPoint } from '../src/pscom/camera-model.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';
import { FakePsCom } from './helpers/fake-pscom.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ps-routes-'));
const UNREACHABLE = 'http://127.0.0.1:9';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

function makeBundle(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify({
    id, displayName: `${id} name`, rootLink: 'base',
    links: { base: { visuals: [{ mesh: 'assets/base.bin', origin: {} }] } }, joints: [], ...extra,
  }));
  writeFileSync(join(dir, 'assets', 'base.bin'), `mesh of ${id}`);
}

/** The catalog side of PS.com, counting what is asked; with `hold`, every answer waits for it. */
function catalogFetch(calls: string[] = [], hold?: () => Promise<void>) {
  return async (url: string) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (hold) await hold();
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer });
    if (u.pathname === '/api/catalog/search') {
      const kind = u.searchParams.get('kind');
      return json({ items: kind === 'machine' ? [{ handle: 'physical-sandbox', name: 'so101', latest_version: '1', display: { ja: 'SO-101' }, kind }] : [] });
    }
    if (u.pathname.endsWith('/manifest')) return json({ bundle: 'bundle.json', kind: 'machine' });
    if (u.pathname.endsWith('/files/bundle.json')) return json({ id: 'so101', links: { base: { visuals: [{ mesh: 'assets/a.bin' }, { mesh: 'assets/b.bin' }] } } });
    if (u.pathname.endsWith('/files/assets/a.bin') || u.pathname.endsWith('/files/assets/b.bin')) {
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new TextEncoder().encode(`bytes ${u.pathname.slice(-5)}`).buffer };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function setup(o: { catalogBase?: string; localDirs?: string[]; cacheRoot?: string; paneDir?: string; calls?: string[]; userDir?: string; hold?: () => Promise<void> } = {}) {
  const userDir = o.userDir ?? tmp();
  const settings = readSettings({ catalogBase: o.catalogBase ?? UNREACHABLE, localMachineDirs: o.localDirs ?? [] }, { userDir, env: {} });
  const red = fakeRed({ userDir });
  const clock = fakeClock();
  const hub = createHub(red.RED, { userDir, settings, clock, pollMs: 0 });
  registerRoutes(red.RED, hub, { paneDir: o.paneDir ?? tmp(), cacheRoot: o.cacheRoot ?? tmp(), fetchImpl: catalogFetch(o.calls, o.hold) as any });
  const base = await red.listen();
  // The pane's header goes with every call unless `pane: false`
  const call = async (method: string, path: string, body?: unknown, init: { type?: string; raw?: Buffer; pane?: boolean } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined || init.raw ? { 'Content-Type': init.type ?? (init.raw ? 'application/octet-stream' : 'application/json') } : {}),
        ...(init.pane === false ? {} : { 'X-PS-Pane': '1' }),
      },
      body: init.raw ? new Uint8Array(init.raw) : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' };
  };
  return { red, hub, clock, base, call, userDir, close: async () => { hub.close(); await red.close(); } };
}

test('reads ask for flows.read and everything that changes something for flows.write', async () => {
  const s = await setup();
  try {
    const routes: [string, string, string][] = [
      ['GET', '/physical-sandbox/pane', 'flows.read'],
      ['GET', '/physical-sandbox/pane/static/main.js', 'flows.read'],
      ['GET', '/physical-sandbox/scene', 'flows.read'],
      ['GET', '/physical-sandbox/scene/background', 'flows.read'],
      ['GET', '/physical-sandbox/machines', 'flows.read'],
      ['GET', '/physical-sandbox/bundles/resolve', 'flows.read'],
      ['GET', '/physical-sandbox/bundles/local/0/x/bundle.json', 'flows.read'],
      ['POST', '/physical-sandbox/scene/background', 'flows.write'],
      ['POST', '/physical-sandbox/scene/floor', 'flows.write'],
      ['POST', '/physical-sandbox/scene/place', 'flows.write'],
      ['POST', '/physical-sandbox/scene/remove', 'flows.write'],
      ['POST', '/physical-sandbox/stream/play', 'flows.write'],
      ['POST', '/physical-sandbox/stream/stop', 'flows.write'],
      ['POST', '/physical-sandbox/stream/clear', 'flows.write'],
      ['POST', '/physical-sandbox/record/save', 'flows.write'],
      ['POST', '/physical-sandbox/record/export', 'flows.write'],
      ['POST', '/physical-sandbox/unsent/send', 'flows.write'],
      ['POST', '/physical-sandbox/login/start', 'flows.write'],
      ['GET', '/physical-sandbox/login/poll', 'flows.write'],
      ['POST', '/physical-sandbox/pane/agent-frames', 'flows.write'],
    ];
    for (const [method, path] of routes) await s.call(method, path, method === 'POST' && !path.endsWith('background') ? {} : undefined);
    for (const [method, path, permission] of routes) assert.equal(s.red.permissions.get(`${method} ${path}`), permission, `${method} ${path}`);
  } finally { await s.close(); }
});

test('GET scene answers the scene', async () => {
  const s = await setup();
  try {
    const { status, json } = await s.call('GET', '/physical-sandbox/scene');
    assert.equal(status, 200);
    assert.deepEqual(json, s.hub.scene());
  } finally { await s.close(); }
});

test('a background still or video is kept in the user directory, set on the scene and served back', async () => {
  const s = await setup();
  try {
    let r = await s.call('POST', '/physical-sandbox/scene/background?name=' + encodeURIComponent('../../site photo.png'), undefined, { raw: PNG });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.background, { kind: 'still', name: 'site photo.png' });
    assert.deepEqual(s.hub.scene().background, { kind: 'still', name: 'site photo.png' });
    const dir = join(s.userDir, 'physical-sandbox', 'backgrounds');
    assert.deepEqual(readdirSync(dir), ['site photo.png']);
    const got = await fetch(`${s.base}/physical-sandbox/scene/background`);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);

    r = await s.call('POST', '/physical-sandbox/scene/background?name=walk.mp4', undefined, { raw: MP4, type: 'video/mp4' });
    assert.deepEqual(r.json.background, { kind: 'video', name: 'walk.mp4' });
    assert.deepEqual(readdirSync(dir), ['walk.mp4'], 'only the picture in use is kept');
    assert.equal(s.red.retained('ps-pane/scene').background.kind, 'video');
  } finally { await s.close(); }
});

test('a background that is not a picture or a video, or is over 50 MB, is refused in Japanese', async () => {
  const s = await setup();
  try {
    let r = await s.call('POST', '/physical-sandbox/scene/background?name=notes.txt', undefined, { raw: Buffer.from('just some text, not a picture') });
    assert.equal(r.status, 415);
    assert.equal(r.json.error, WORDS.notPicture);
    r = await s.call('POST', '/physical-sandbox/scene/background?name=big.png', undefined, { raw: Buffer.concat([PNG, Buffer.alloc(50 * 1024 * 1024)]) });
    assert.equal(r.status, 413);
    assert.equal(r.json.error, WORDS.backgroundTooLarge);
    assert.equal(s.hub.scene().background, null);
    assert.equal((await s.call('GET', '/physical-sandbox/scene/background')).status, 404);
  } finally { await s.close(); }
});

// A camera 2.5 m up looking down 35°, as in PS.com's pose-solve tests, and floors in front of it
const WIDTH = 1920;
const HEIGHT = 1080;
const truth = () => ({
  intr: intrinsicsFromFov(60, WIDTH, HEIGHT),
  extr: extrinsicsFromPose({ fovDeg: 60, pitchDeg: 35, rollDeg: 0, heightM: 2.5 }, { origin: { x: 0, y: 0, z: 0 }, yaw: 0 }),
});
const pixelsOf = (worlds: { x: number; y: number; z: number }[]) => {
  const { intr, extr } = truth();
  return worlds.map((w) => { const p = projectPoint(intr, extr, w)!; return { u: p.u, v: p.v }; });
};
const NEW_FLOOR = [{ x: -2, y: 0, z: -5 }, { x: 2, y: 0, z: -5 }, { x: 2, y: 0, z: -2 }, { x: -2, y: 0, z: -2 }];
const TURNED_FLOOR = NEW_FLOOR.map(({ x, z }) => {
  const a = (30 * Math.PI) / 180;
  return { x: (x - 0) * Math.cos(a) - (z + 3.5) * Math.sin(a), y: 0, z: -3.5 + x * Math.sin(a) + (z + 3.5) * Math.cos(a) };
});

test('floor: four clicks and the length of 1→2 decide a new floor and the camera', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/physical-sandbox/scene/floor', { pixels: pixelsOf(TURNED_FLOOR), edgesM: [4, 9], width: WIDTH, height: HEIGHT });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.mirrored, false);
    assert.equal(r.json.derived, true, 'the depth comes from the picture, not the typed 9 m');
    assert.ok(r.json.residualPx < 0.1, `residualPx ${r.json.residualPx}`);
    assert.ok(Math.abs(r.json.edgesM[1] - 3) < 0.05, `depth ${r.json.edgesM[1]}`);
    const scene = s.hub.scene();
    assert.ok(scene.camera);
    assert.deepEqual(scene.floor?.corners[0], { x: 0, y: 0, z: 0 });
    assert.deepEqual(scene.floor?.edgesM, r.json.edgesM);
    assert.deepEqual(s.red.retained('ps-pane/scene').floor, scene.floor);
  } finally { await s.close(); }
});

test('floor: a new floor or a record\'s floor clicked the other way round is refused in Japanese', async () => {
  const s = await setup();
  try {
    const [p1, p2, p3, p4] = pixelsOf(NEW_FLOOR);
    let r = await s.call('POST', '/physical-sandbox/scene/floor', { pixels: [p1, p4, p3, p2], edgesM: [3, 4], width: WIDTH, height: HEIGHT });
    assert.equal(r.status, 422, r.text);
    assert.equal(r.json.reason, 'mirrored');
    assert.equal(r.json.error, WORDS.newReversed);
    assert.equal(WORDS.newReversed, '床の角の順番が逆回りです。映像の上で、角 1 から時計回りにもう一度指定してください');
    assert.equal(s.hub.scene().floor, null);
    assert.equal(s.hub.scene().camera, null);
    r = await s.call('POST', '/physical-sandbox/scene/floor', { pixels: [p1, p2, p3, p4], edgesM: [4, 3], width: WIDTH, height: HEIGHT });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.mirrored, false, 'clockwise on the picture');

    // The opened record has its own floor: its corners in its order
    const square = [{ x: -2, y: 0, z: -2 }, { x: 2, y: 0, z: -2 }, { x: 2, y: 0, z: -6 }, { x: -2, y: 0, z: -6 }];
    const record = { schemaVersion: 3, floor: { source: 'corners', corners: square }, equipment: { site: { id: 'local' }, devices: [] }, names: {}, traces: [], routes: [] };
    await s.call('POST', '/physical-sandbox/stream/play', { record, file: 'square.record.json' });
    assert.equal(s.hub.scene().camera, null);
    const [q1, q2, q3, q4] = pixelsOf(square);
    r = await s.call('POST', '/physical-sandbox/scene/floor', { pixels: [q1, q4, q3, q2], edgesM: [4, 4], width: WIDTH, height: HEIGHT });
    assert.equal(r.status, 422);
    assert.equal(r.json.reason, 'mirrored');
    assert.equal(r.json.error, '角の順番が逆です。角 1 から、同じ回り方でもう一度指定してください');
    assert.equal(s.hub.scene().camera, null);
    r = await s.call('POST', '/physical-sandbox/scene/floor', { pixels: [q1, q2, q3, q4], width: WIDTH, height: HEIGHT });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.mirrored, false);
    assert.deepEqual(s.hub.scene().floor?.corners, square, 'the record\'s floor stays');
    assert.ok(s.hub.scene().camera);
  } finally { await s.close(); }
});

test('floor: clicks on one line, or no lengths, are refused', async () => {
  const s = await setup();
  try {
    const line = [0, 1, 2, 3].map((i) => ({ u: 200 + 300 * i, v: 700 }));
    let r = await s.call('POST', '/physical-sandbox/scene/floor', { pixels: line, edgesM: [4, 3], width: WIDTH, height: HEIGHT });
    assert.equal(r.status, 422);
    assert.equal(r.json.reason, 'flat');
    r = await s.call('POST', '/physical-sandbox/scene/floor', { pixels: pixelsOf(TURNED_FLOOR), width: WIDTH, height: HEIGHT });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, WORDS.badFloor);
    r = await s.call('POST', '/physical-sandbox/scene/floor', { pixels: pixelsOf(TURNED_FLOOR), edgesM: [4, 3] });
    assert.equal(r.status, 400);
  } finally { await s.close(); }
});

test('machines: the catalog, the cache and local folders, each row with where its bundle is served from', async () => {
  const local = tmp();
  makeBundle(join(local, 'myarm'), 'myarm');
  const cacheRoot = tmp();
  makeBundle(join(cacheRoot, 'catalog', 'physical-sandbox', 'g1', '3'), 'g1');
  const s = await setup({ localDirs: [local], cacheRoot });
  try {
    const r = await s.call('GET', '/physical-sandbox/machines');
    assert.equal(r.status, 200);
    assert.equal(r.json.offline, false);
    assert.deepEqual(r.json.machines.map((m: any) => [m.ref, m.source, m.bundle?.bundleUrl]), [
      ['physical-sandbox/so101:1', 'catalog', '/physical-sandbox/bundles/catalog/physical-sandbox/so101/1/bundle.json'],
      ['physical-sandbox/g1:3', 'cache', '/physical-sandbox/bundles/cache/physical-sandbox/g1/3/bundle.json'],
      ['myarm', 'local', '/physical-sandbox/bundles/local/0/myarm/bundle.json'],
    ]);
    const resolved = await s.call('GET', '/physical-sandbox/bundles/resolve?product=myarm');
    assert.deepEqual(resolved.json, r.json.machines[2].bundle);
    assert.equal((await s.call('GET', r.json.machines[1].bundle.bundleUrl)).json.id, 'g1');
    const missing = await s.call('GET', '/physical-sandbox/bundles/resolve?product=nothing');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, WORDS.noProduct);
  } finally { await s.close(); }
});

test('bundle files: a local file is served, anything outside the bundle is not; catalog files come through a cache', async () => {
  const local = tmp();
  makeBundle(join(local, 'myarm'), 'myarm');
  writeFileSync(join(local, 'secret.txt'), 'secret');
  const calls: string[] = [];
  const s = await setup({ localDirs: [local], calls });
  try {
    let r = await s.call('GET', '/physical-sandbox/bundles/local/0/myarm/assets/base.bin');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'mesh of myarm');
    for (const bad of ['/physical-sandbox/bundles/local/0/myarm/%2e%2e/secret.txt', '/physical-sandbox/bundles/local/0/%2e%2e/secret.txt', '/physical-sandbox/bundles/local/0/myarm/secret.txt']) {
      assert.equal((await s.call('GET', bad)).status, 404, bad);
    }
    r = await s.call('GET', '/physical-sandbox/bundles/catalog/physical-sandbox/so101/1/assets/a.bin');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'bytes a.bin');
    r = await s.call('GET', '/physical-sandbox/bundles/catalog/physical-sandbox/so101/1/assets/b.bin');
    assert.equal(r.text, 'bytes b.bin');
    assert.equal(calls.filter((c) => c.endsWith('/manifest')).length, 1, 'the manifest is asked once');
    assert.equal(calls.filter((c) => c.endsWith('/bundle.json')).length, 1, 'bundle.json is asked once');
    assert.equal((await s.call('GET', '/physical-sandbox/bundles/catalog/physical-sandbox/so101/1/assets/c.bin')).status, 404);
  } finally { await s.close(); }
});

test('place adds robots and boxes with ids <name>-<n>; placing an id again moves it; remove takes it away', async () => {
  const local = tmp();
  makeBundle(join(local, 'myarm'), 'myarm');
  makeBundle(join(local, 'crate'), 'crate', { kind: 'object', dimensions: { length: 0.6, width: 0.4, height: 0.3 } });
  makeBundle(join(local, 'pallet'), 'pallet', { kind: 'object' });
  const s = await setup({ localDirs: [local] });
  try {
    let r = await s.call('POST', '/physical-sandbox/scene/place', { product: 'myarm', xyz: [1, 2, 5], yaw: 0.5 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.device, { id: 'myarm-1', product: 'myarm', owner: 'viewer', parent: 'site', pose: { xyz: [1, 2, 0], rpy: [0, 0, 0.5] } });
    r = await s.call('POST', '/physical-sandbox/scene/place', { product: 'myarm', xyz: [0, 0] });
    assert.equal(r.json.device.id, 'myarm-2');
    r = await s.call('POST', '/physical-sandbox/scene/place', { product: 'crate', xyz: [3, 0] });
    assert.deepEqual(r.json.device, {
      id: 'crate-1', product: 'crate', owner: 'viewer', parent: 'site', pose: { xyz: [3, 0, 0], rpy: [0, 0, 0] },
      type: 'item', shape: { sizeM: [0.6, 0.4, 0.3] },
    });
    r = await s.call('POST', '/physical-sandbox/scene/place', { product: 'pallet', xyz: [4, 0] });
    assert.deepEqual(r.json.device.shape, { sizeM: [0.2, 0.2, 0.2] });
    // a catalog robot the listing called a machine is placed without fetching anything
    await s.call('GET', '/physical-sandbox/machines');
    r = await s.call('POST', '/physical-sandbox/scene/place', { product: 'physical-sandbox/so101:1', xyz: [5, 0], id: 'left' });
    assert.equal(r.json.device.id, 'left');
    assert.equal(r.json.device.type, undefined);

    r = await s.call('POST', '/physical-sandbox/scene/place', { id: 'myarm-1', product: 'myarm', xyz: [7, 8], yaw: 1 });
    assert.deepEqual(r.json.device.pose, { xyz: [7, 8, 0], rpy: [0, 0, 1] });
    const scene = s.hub.scene();
    assert.deepEqual(scene.devices.map((d) => d.id), ['myarm-1', 'myarm-2', 'crate-1', 'pallet-1', 'left']);
    assert.deepEqual(scene.names, { 'myarm-1': 'myarm-1', 'myarm-2': 'myarm-2', 'crate-1': 'crate-1', 'pallet-1': 'pallet-1', left: 'left' });

    assert.equal((await s.call('POST', '/physical-sandbox/scene/place', { product: 'myarm', xyz: [0, 0], id: 'crate-1' })).status, 200, 'an id there moves that device');
    assert.equal((await s.call('POST', '/physical-sandbox/scene/place', { product: 'myarm', xyz: ['a', 0] })).status, 400);
    assert.equal((await s.call('POST', '/physical-sandbox/scene/place', { product: 'a/b/c', xyz: [0, 0] })).status, 400);

    r = await s.call('POST', '/physical-sandbox/scene/remove', { id: 'myarm-2' });
    assert.equal(r.status, 200);
    assert.deepEqual(s.hub.scene().devices.map((d) => d.id), ['myarm-1', 'crate-1', 'pallet-1', 'left']);
    assert.equal(Object.hasOwn(s.hub.scene().names, 'myarm-2'), false);
    assert.equal((await s.call('POST', '/physical-sandbox/scene/remove', { id: 'myarm-2' })).status, 404);
  } finally { await s.close(); }
});

const walkRecord = {
  schemaVersion: 3, frame: { frameId: 'site', up: '+Y', unit: 'm' }, markers: [],
  equipment: { site: { id: 'local' }, devices: [{ id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }] },
  names: { arm: 'arm' },
  traces: [{ deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 1, joints: { j: 1 } }] }],
  routes: [],
};

test('stream/play opens a record (sent, or from PS.com) and plays it to the panes; stop and clear', async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'walk', '3', walkRecord, { visibility: 'public' });
  const s = await setup({ catalogBase: fake.base });
  try {
    let r = await s.call('POST', '/physical-sandbox/stream/play', { record: walkRecord, file: 'walk.record.json' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.source, r.json.count, r.json.duration], ['walk.record.json', 2, 1]);
    assert.deepEqual(s.hub.scene().devices.map((d) => d.id), ['arm']);
    assert.deepEqual(s.red.retained('ps-pane/status').opened, { file: 'walk.record.json' });
    assert.equal(s.red.published.filter((p) => p.topic === 'ps-pane/state').length, 1, 'the sample at t = 0 at once');
    s.clock.advance(1000);
    assert.equal(s.red.published.filter((p) => p.topic === 'ps-pane/state').length, 2);

    r = await s.call('POST', '/physical-sandbox/stream/play', { ref: 'ada/walk', loop: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.source, 'ada/walk:3');
    assert.deepEqual(s.red.retained('ps-pane/status').opened, { ref: 'ada/walk', version: '3', own: false });
    assert.notEqual(s.red.retained('ps-pane/status').playing, null);
    r = await s.call('POST', '/physical-sandbox/stream/stop');
    assert.equal(r.json.status.playing, null);
    assert.equal(s.hub.streamBuffer().length, 2, 'the opened record\'s states, however much was played');
    r = await s.call('POST', '/physical-sandbox/stream/clear');
    assert.equal(r.json.status.recorded, 0);

    assert.equal((await s.call('POST', '/physical-sandbox/stream/play', { ref: 'ada/none' })).status, 404);
    assert.equal((await s.call('POST', '/physical-sandbox/stream/play', {})).status, 400);
    await fake.stop();
    r = await s.call('POST', '/physical-sandbox/stream/play', { ref: 'ada/walk' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, WORDS.offline);
  } finally { await s.close(); await fake.stop(); }
});

test('saving: signed out keeps an unsent copy; after signing in it is sent; new, over, and the refusals', async () => {
  const fake = await new FakePsCom().start();
  fake.seed('bob', 'theirs', '1', walkRecord, { visibility: 'public' });
  const s = await setup({ catalogBase: fake.base });
  try {
    await s.call('POST', '/physical-sandbox/stream/play', { record: walkRecord, file: 'walk.record.json' });
    s.clock.advance(1000);

    // signed out: kept, shown as unsent
    let r = await s.call('POST', '/physical-sandbox/record/save', { mode: 'new', name: 'walk', title: '歩く' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.saved, false);
    assert.equal(r.json.unsent, 'walk');
    assert.deepEqual(s.red.retained('ps-pane/status').unsent, [{ name: 'walk', ref: 'walk', mode: 'new' }]);

    // signing in sends what was kept
    r = await s.call('POST', '/physical-sandbox/login/start');
    assert.deepEqual(r.json, { userCode: '123456', url: `${fake.base}/vr` });
    r = await s.call('GET', '/physical-sandbox/login/poll');
    assert.equal(r.json.status, 'approved');
    for (let i = 0; i < 50 && pending(s.hub.dirs.unsent).length; i += 1) await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(pending(s.hub.dirs.unsent), []);
    assert.equal(fake.record('ada', 'walk', '1').name, '歩く');
    assert.deepEqual(fake.record('ada', 'walk', '1').traces, walkRecord.traces);
    assert.deepEqual(s.red.retained('ps-pane/status').login, { signedIn: true, handle: 'ada' });
    assert.deepEqual(s.red.retained('ps-pane/status').unsent, []);

    // opened from PS.com, saved as new (based on it), then over that as the next version
    r = await s.call('POST', '/physical-sandbox/stream/play', { ref: 'ada/walk' });
    assert.deepEqual(r.json.status.opened, { ref: 'ada/walk', version: '1', own: true });
    s.clock.advance(1000);
    r = await s.call('POST', '/physical-sandbox/record/save', { mode: 'new', name: 'walk-two' });
    assert.deepEqual([r.json.saved, r.json.ref, r.json.version], [true, 'ada/walk-two', '1']);
    assert.equal(fake.record('ada', 'walk-two', '1').basedOn, 'ada/walk:1', 'basedOn the opened PS.com record');
    assert.deepEqual(s.red.retained('ps-pane/status').opened, { ref: 'ada/walk-two', version: '1', own: true });
    s.hub.push({ topic: 'ps/local/arm/state', payload: { at: s.clock.now() + 5000, joints: { j: 2 } } }, 'mqtt');
    r = await s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    assert.deepEqual([r.json.saved, r.json.ref, r.json.version, r.json.mode], [true, 'ada/walk-two', '2', 'over']);
    assert.deepEqual(fake.record('ada', 'walk-two', '2').traces[0].samples, [{ t: 0, joints: { j: 2 } }], 'the live state took the place of the arm\'s trace');

    // refusals
    r = await s.call('POST', '/physical-sandbox/record/save', { mode: 'new', name: 'Bad Name' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, WORDS.badName);
    r = await s.call('POST', '/physical-sandbox/record/save', { mode: 'new', name: 'walk' });
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, 'taken');
    await s.call('POST', '/physical-sandbox/stream/play', { ref: 'bob/theirs' });
    r = await s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, WORDS.notOwn);
  } finally { await s.close(); await fake.stop(); }
});

test('a record naming a robot only this machine has is kept, not sent', async () => {
  const fake = await new FakePsCom().start();
  const local = tmp();
  makeBundle(join(local, 'myarm'), 'myarm');
  const s = await setup({ catalogBase: fake.base, localDirs: [local] });
  try {
    await s.hub.client.loginStart();
    await s.hub.client.loginPoll();
    await s.call('POST', '/physical-sandbox/scene/place', { product: 'myarm', xyz: [0, 0] });
    const r = await s.call('POST', '/physical-sandbox/record/save', { mode: 'new', name: 'mine' });
    assert.deepEqual([r.json.saved, r.json.code, r.json.unsent], [false, 'local-machine', 'mine']);
    assert.match(r.json.reason, /手元のロボット myarm/);
    assert.equal(fake.calls.some((c) => c.method === 'PUT'), false);
  } finally { await s.close(); await fake.stop(); }
});

test('unsent/send sends the kept copies', async () => {
  const fake = await new FakePsCom().start();
  const s = await setup({ catalogBase: fake.base });
  try {
    await s.call('POST', '/physical-sandbox/stream/play', { record: walkRecord });
    await s.call('POST', '/physical-sandbox/record/save', { mode: 'new', name: 'kept' });
    assert.equal(pending(s.hub.dirs.unsent).length, 1);
    let r = await s.call('POST', '/physical-sandbox/unsent/send');
    assert.deepEqual(r.json.left.map((p: any) => p.name), ['kept'], 'still signed out');
    await s.hub.client.loginStart();
    await s.hub.client.loginPoll();
    r = await s.call('POST', '/physical-sandbox/unsent/send');
    assert.deepEqual(r.json.sent.map((p: any) => p.ref), ['ada/kept']);
    assert.deepEqual(s.red.retained('ps-pane/status').unsent, []);
  } finally { await s.close(); await fake.stop(); }
});

test('record/export writes the record into the exports folder, never over an earlier one', async () => {
  const s = await setup();
  try {
    await s.call('POST', '/physical-sandbox/stream/play', { record: walkRecord });
    s.clock.advance(1000);
    let r = await s.call('POST', '/physical-sandbox/record/export', { name: 'walk' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.file, join(s.userDir, 'physical-sandbox', 'exports', 'walk.record.json'));
    assert.deepEqual(JSON.parse(readFileSync(r.json.file, 'utf8')).traces, walkRecord.traces);
    r = await s.call('POST', '/physical-sandbox/record/export', { name: 'walk' });
    assert.equal(r.json.name, 'walk-2.record.json');
    r = await s.call('POST', '/physical-sandbox/record/export', {});
    assert.equal(r.json.name, 'record.record.json');
  } finally { await s.close(); }
});

test('a JSON body Node-RED did not read (text/plain) is read here; one that is not an object is refused', async () => {
  const s = await setup();
  try {
    let r = await s.call('POST', '/physical-sandbox/stream/play', JSON.stringify({ record: walkRecord }), { type: 'text/plain' });
    assert.equal(r.status, 400, 'a JSON string is not an object');
    const res = await fetch(`${s.base}/physical-sandbox/stream/play`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-PS-Pane': '1' }, body: JSON.stringify({ record: walkRecord }) });
    assert.equal(res.status, 200);
    r = await s.call('POST', '/physical-sandbox/scene/place', undefined, { raw: Buffer.from('[1,2]'), type: 'application/json' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, WORDS.notJson);
  } finally { await s.close(); }
});

test('the agent switch is kept in the status', async () => {
  const s = await setup();
  try {
    const r = await s.call('POST', '/physical-sandbox/pane/agent-frames', { on: true });
    assert.deepEqual(r.json, { agentFrames: true });
    assert.equal(s.red.retained('ps-pane/status').agentFrames, true);
    await s.call('POST', '/physical-sandbox/pane/agent-frames', { on: 'yes' });
    assert.equal(s.red.retained('ps-pane/status').agentFrames, false);
  } finally { await s.close(); }
});

test('the pane page and its files are served from the pane folder only', async () => {
  const paneDir = tmp();
  const outside = tmp();
  writeFileSync(join(outside, 'secret.js'), 'secret');
  const s = await setup({ paneDir });
  try {
    let r = await s.call('GET', '/physical-sandbox/pane');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, WORDS.noPane);
    writeFileSync(join(paneDir, 'index.html'), '<!doctype html><title>pane</title>');
    writeFileSync(join(paneDir, 'main.js'), 'export {}');
    r = await s.call('GET', '/physical-sandbox/pane');
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    r = await s.call('GET', '/physical-sandbox/pane/static/main.js');
    assert.equal(r.text, 'export {}');
    assert.equal((await s.call('GET', '/physical-sandbox/pane/static/%2e%2e/' + encodeURIComponent(outside.split('/').pop()!) + '/secret.js')).status, 404);
    assert.equal(existsSync(join(paneDir, 'missing.js')), false);
    assert.equal((await s.call('GET', '/physical-sandbox/pane/static/missing.js')).status, 404);
  } finally { await s.close(); }
});

/** A promise and the function that settles it. */
function gate(): { wait: () => Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((done) => { open = done; });
  return { wait: () => opened, open };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((done) => setTimeout(done, 5));
  assert.ok(check(), `waited for ${what}`);
}

test('place: two places at once get two ids, and a record opened while one waits for the catalog stays opened', { timeout: 20_000 }, async () => {
  const calls: string[] = [];
  const held = gate();
  const s = await setup({ calls, hold: held.wait });
  try {
    const one = s.call('POST', '/physical-sandbox/scene/place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] });
    const two = s.call('POST', '/physical-sandbox/scene/place', { product: 'physical-sandbox/so101:1', xyz: [1, 0] });
    await until(() => calls.length >= 2, 'both places asking the catalog');
    held.open();
    const ids = [(await one).json.device.id, (await two).json.device.id].sort();
    assert.deepEqual(ids, ['so101-1', 'so101-2']);
    assert.deepEqual(s.hub.scene().devices.map((d) => d.id).sort(), ['so101-1', 'so101-2']);
  } finally { await s.close(); }

  const calls2: string[] = [];
  const held2 = gate();
  const t = await setup({ calls: calls2, hold: held2.wait });
  try {
    const placing = t.call('POST', '/physical-sandbox/scene/place', { product: 'physical-sandbox/so101:1', xyz: [2, 0] });
    await until(() => calls2.length >= 1, 'the place asking the catalog');
    assert.equal((await t.call('POST', '/physical-sandbox/stream/play', { record: walkRecord, file: 'walk.record.json' })).status, 200);
    held2.open();
    assert.equal((await placing).status, 200);
    assert.deepEqual(t.hub.scene().devices.map((d) => d.id), ['arm', 'so101-1'], 'the opened record\'s devices and the placed one');
    assert.deepEqual(t.red.retained('ps-pane/status').opened, { file: 'walk.record.json' });
  } finally { await t.close(); }
});

/** Sign the hub in to the fake PS.com and open `ada/<name>` from it. */
async function signedInWith(fake: FakePsCom, s: Awaited<ReturnType<typeof setup>>, name: string): Promise<void> {
  await s.hub.client.loginStart();
  await s.hub.client.loginPoll();
  const r = await s.call('POST', '/physical-sandbox/stream/play', { ref: `ada/${name}` });
  assert.equal(r.status, 200, r.text);
  s.hub.stop();
}

test('saving: a save while another is under way is refused as busy; saving over twice makes one new version', { timeout: 20_000 }, async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'walk', '1', walkRecord);
  const s = await setup({ catalogBase: fake.base });
  try {
    await signedInWith(fake, s, 'walk');
    const live = (j: number) => s.hub.push({ topic: 'ps/local/arm/state', payload: { at: s.clock.now() + j * 1000, joints: { j } } }, 'mqtt');
    live(5);
    const held = gate();
    fake.holdPuts = held.wait();
    const first = s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    await until(() => fake.putsWaiting === 1, 'the first save at PS.com');
    const second = await s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    assert.equal(second.status, 409);
    assert.deepEqual(second.json, { error: '保存中です。終わるまでお待ちください', reason: 'busy' });
    assert.equal((await s.call('POST', '/physical-sandbox/record/save', { mode: 'new', name: 'other' })).json.reason, 'busy');
    held.open();
    fake.holdPuts = null;
    const r = await first;
    assert.deepEqual([r.status, r.json.saved, r.json.version], [200, true, '2']);
    assert.equal(fake.record('ada', 'walk', '3'), undefined);
    assert.deepEqual([...fake.items.keys()].sort(), ['ada/walk'], 'no walk-2 record');
    // the next save goes on from the saved version
    live(6);
    const again = await s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    assert.deepEqual([again.json.saved, again.json.version], [true, '3']);
  } finally { await s.close(); await fake.stop(); }
});

test('saving: a record opened while a save is under way stays the opened one', { timeout: 20_000 }, async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'walk', '1', walkRecord);
  const s = await setup({ catalogBase: fake.base });
  try {
    await signedInWith(fake, s, 'walk');
    const held = gate();
    fake.holdPuts = held.wait();
    const saving = s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    await until(() => fake.putsWaiting === 1, 'the save at PS.com');
    assert.equal((await s.call('POST', '/physical-sandbox/stream/play', { record: twoRecord, file: 'other.record.json' })).status, 200);
    held.open();
    fake.holdPuts = null;
    assert.equal((await saving).json.saved, true);
    assert.deepEqual(s.red.retained('ps-pane/status').opened, { file: 'other.record.json' });
    assert.deepEqual(s.hub.scene().devices.map((d) => d.id), ['arm', 'box']);
  } finally { await s.close(); await fake.stop(); }
});

const twoRecord = {
  schemaVersion: 3, frame: { frameId: 'site', up: '+Y', unit: 'm' }, markers: [],
  equipment: {
    site: { id: 'local' },
    devices: [
      { id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } },
      { id: 'box', product: 'physical-sandbox/crate:1', owner: 'viewer', parent: 'site', type: 'item', shape: { sizeM: [0.2, 0.2, 0.2] }, pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } },
    ],
  },
  names: { arm: 'arm', box: 'box' },
  traces: [
    { deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 0.5, joints: { j: 0.5 } }, { t: 1, joints: { j: 1 } }, { t: 2, joints: { j: 2 } }] },
    { deviceId: 'box', samples: [{ t: 0, position: [1, 0, 0] }, { t: 0.25, position: [1.5, 0, 0] }, { t: 1.5, position: [2, 0, 0] }] },
  ],
  routes: [],
};

test('saving over a record after half a play, a play at speed 2 or a loop keeps its traces as they were', async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'two', '1', twoRecord);
  const s = await setup({ catalogBase: fake.base });
  try {
    await signedInWith(fake, s, 'two');
    const plays: [Record<string, unknown>, number][] = [[{}, 600], [{ speed: 2 }, 3000], [{ loop: true }, 5300]];
    for (const [how, ms] of plays) {
      const r = await s.call('POST', '/physical-sandbox/stream/play', { ref: 'ada/two', ...how });
      assert.equal(r.status, 200, r.text);
      s.clock.advance(ms);
      await s.call('POST', '/physical-sandbox/stream/stop');
      const saved = await s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
      // PS.com answers a body equal to its latest version with that version: nothing changed at all
      assert.deepEqual([saved.json.saved, saved.json.version, saved.json.unchanged], [true, '1', true], JSON.stringify(how));
      assert.deepEqual(fake.record('ada', 'two', '1').traces, twoRecord.traces, JSON.stringify(how));
    }
    // and an export says the same
    const exported = await s.call('POST', '/physical-sandbox/record/export', { name: 'two' });
    assert.deepEqual(JSON.parse(readFileSync(exported.json.file, 'utf8')).traces, twoRecord.traces);
  } finally { await s.close(); await fake.stop(); }
});

test('saving: a live state while a record is open changes that device\'s trace only; saving as new keeps the rest and notes basedOn', async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'two', '1', { ...twoRecord, name: '二台' });
  const s = await setup({ catalogBase: fake.base });
  try {
    await signedInWith(fake, s, 'two');
    const at = s.clock.now();
    s.hub.push({ topic: 'ps/local/box/state', payload: { at, parent: 'site', xyz: [3, 0, 0] } }, 'mqtt');
    s.hub.push({ topic: 'ps/local/box/state', payload: { at: at + 1000, parent: 'site', xyz: [4, 0, 0] } }, 'mqtt');
    const r = await s.call('POST', '/physical-sandbox/record/save', { mode: 'new', name: 'two-live', title: '箱だけ' });
    assert.deepEqual([r.json.saved, r.json.ref], [true, 'ada/two-live']);
    const saved = fake.record('ada', 'two-live', '1');
    assert.equal(saved.basedOn, 'ada/two:1');
    assert.equal(saved.name, '箱だけ');
    assert.deepEqual(saved.traces, [twoRecord.traces[0], { deviceId: 'box', samples: [{ t: 0, position: [3, 0, 0] }, { t: 1, position: [4, 0, 0] }] }]);
    assert.deepEqual(saved.equipment, twoRecord.equipment);
  } finally { await s.close(); await fake.stop(); }
});

test('writes come from the pane only: JSON, or the X-PS-Pane header; a cross-site simple request is refused', async () => {
  const s = await setup();
  try {
    const post = (path: string, headers: Record<string, string>, body?: string | Uint8Array) => fetch(`${s.base}/physical-sandbox/${path}`, { method: 'POST', headers, body: body as any });
    const record = JSON.stringify({ record: walkRecord });
    let r = await post('stream/play', { 'Content-Type': 'text/plain' }, record);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: WORDS.notPane, reason: 'not-pane' });
    assert.deepEqual(s.hub.scene().devices, [], 'nothing was opened');
    assert.equal((await post('stream/play', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'record=1')).status, 403);
    assert.equal((await post('stream/stop', {})).status, 403, 'no body and no header');
    assert.equal((await post('scene/background?name=a.png', { 'Content-Type': 'application/octet-stream' }, new Uint8Array(PNG))).status, 403);
    assert.equal(s.hub.scene().background, null);

    assert.equal((await post('stream/play', { 'Content-Type': 'application/json' }, record)).status, 200, 'JSON alone');
    assert.equal((await post('stream/play', { 'Content-Type': 'text/plain', 'X-PS-Pane': '1' }, record)).status, 200, 'text with the header');
    assert.equal((await post('stream/stop', { 'X-PS-Pane': '1' })).status, 200);
    assert.equal((await post('scene/background?name=a.png', { 'Content-Type': 'application/octet-stream', 'X-PS-Pane': '1' }, new Uint8Array(PNG))).status, 200);
  } finally { await s.close(); }
});

/** A raw request: the headers, then the chunks `chunks()` gives until null; the answer, how much was written, and whether the connection was closed. */
function rawPost(base: string, path: string, headers: Record<string, string | number>, chunks: () => Buffer | null): Promise<{ status: number; body: string; written: number; closed: boolean }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    let written = 0;
    let closed = false;
    let ended = false;
    let done = () => {};
    const req = http.request({ hostname, port, path, method: 'POST', headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c) => parts.push(c));
      // the server cuts the connection a while after its answer: done when both have happened
      res.on('end', () => { ended = true; done(); });
      done = () => {
        if (!(ended && closed)) return;
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8'), written, closed });
      };
    });
    // writing on after the answer fails once the server cuts the connection: that is expected
    req.on('error', (e) => { if (!/EPIPE|ECONNRESET/.test(String((e as NodeJS.ErrnoException).code))) reject(e); });
    req.on('socket', (socket) => socket.on('close', () => { closed = true; done(); }));
    const pump = () => {
      for (;;) {
        const chunk = chunks();
        if (!chunk) { req.end(); return; }
        written += chunk.length;
        if (!req.write(chunk)) { req.once('drain', pump); return; }
      }
    };
    pump();
  });
}

test('a body over the limit is answered 413 at once and no more of it is read', { timeout: 20_000 }, async () => {
  // The server's timer that cuts a refused connection is unref'd (it never keeps Node-RED from
  // stopping), and a paused socket keeps no process alive: this keeps the test's alive meanwhile
  const alive = setInterval(() => {}, 100);
  const s = await setup();
  try {
    // Content-Length already over: answered before the body is sent
    let r = await rawPost(s.base, '/physical-sandbox/scene/background?name=big.png', { 'Content-Type': 'application/octet-stream', 'X-PS-Pane': '1', 'Content-Length': 60 * 1024 * 1024 }, () => null);
    assert.equal(r.status, 413);
    assert.equal(JSON.parse(r.body).error, WORDS.backgroundTooLarge);
    assert.equal(r.closed, true, 'the connection is closed');

    // no length given: the reading stops once the limit is passed
    const mb = Buffer.alloc(1024 * 1024, 0x20);
    let sent = 0;
    r = await rawPost(s.base, '/physical-sandbox/stream/play', { 'Content-Type': 'text/plain', 'X-PS-Pane': '1', 'Transfer-Encoding': 'chunked' }, () => (sent++ < 200 ? mb : null));
    assert.equal(r.status, 413);
    assert.equal(JSON.parse(r.body).error, WORDS.tooLarge);
    assert.equal(r.closed, true);
    assert.ok(sent < 200, `the server stopped reading (${sent} MB offered)`);
  } finally { await s.close(); clearInterval(alive); }
});

test('a background name keeps no .. in it', () => {
  assert.equal(safeName('../../a..b.png'), 'a.b.png');
  assert.equal(safeName('..'), 'background');
});

test('every sentence shown to people keeps the package\'s wording (no 直す・決める・読む・機体・絵・版)', async () => {
  const banned = /直す|直し|決め|決ま|読む|読ん|機体|絵|版/;
  const japanese = /[぀-ヿ一-鿿]/;
  const sentences: [string, string][] = Object.entries(WORDS).map(([k, v]) => [`WORDS.${k}`, v]);
  for (const [k, v] of Object.entries(PANE_WORDS)) sentences.push([`pane WORDS.${k}`, v.ja]);
  for (const [file, mod] of [['unsent', await import('../src/core/unsent.js')], ['pscom-client', await import('../src/core/pscom-client.js')]] as const) {
    for (const [k, v] of Object.entries(mod)) if (typeof v === 'string' && japanese.test(v)) sentences.push([`${file}.${k}`, v]);
  }
  // and every Japanese string literal in the plugin's own sources (comments left out)
  for (const dir of ['src/core', 'src/plugin', 'src/nodes', 'src/pane']) {
    const root = join(import.meta.dirname, '..', dir);
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(join(root, file), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      for (const m of code.matchAll(/'[^'\n]*'|`[^`]*`/g)) if (japanese.test(m[0])) sentences.push([`${dir}/${file}`, m[0]]);
    }
  }
  assert.ok(sentences.length > 30, `${sentences.length} sentences found`);
  for (const [where, sentence] of sentences) assert.doesNotMatch(sentence.replaceAll('読み込', ''), banned, `${where}: ${sentence}`);
});

test('a retained state moves the panes but does not take the place of the opened record\'s trace', async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'two', '1', twoRecord);
  const s = await setup({ catalogBase: fake.base });
  try {
    await signedInWith(fake, s, 'two');
    assert.equal(s.hub.push({ topic: 'ps/local/arm/state', payload: { at: s.clock.now() + 10_000, joints: { j: 7 } } }, 'mqtt', { retained: true }), true);
    assert.deepEqual(s.red.published.filter((p) => p.topic === 'ps-pane/state').at(-1)?.data.payload, { at: s.clock.now() + 10_000, joints: { j: 7 } });
    s.clock.advance(100);
    assert.ok(s.red.retained('ps-pane/snapshot').some((m: any) => m.payload.joints?.j === 7), 'the latest state has it');
    const saved = await s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    assert.deepEqual([saved.json.saved, saved.json.version, saved.json.unchanged], [true, '1', true]);
  } finally { await s.close(); await fake.stop(); }
});

test('sending kept copies waits for a save under way, and a save waits for nothing but is refused while they are sent', { timeout: 20_000 }, async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'walk', '1', walkRecord);
  const s = await setup({ catalogBase: fake.base });
  try {
    await signedInWith(fake, s, 'walk');
    // a copy kept earlier, over the same record
    mkdirSync(s.hub.dirs.unsent, { recursive: true });
    writeFileSync(join(s.hub.dirs.unsent, 'walk.record.json'), JSON.stringify({ ...walkRecord, name: 'kept' }));
    writeFileSync(join(s.hub.dirs.unsent, 'walk.send.json'), JSON.stringify({ ref: 'ada/walk', mode: 'over', base: '1' }));
    s.hub.push({ topic: 'ps/local/arm/state', payload: { at: s.clock.now(), joints: { j: 5 } } }, 'mqtt');

    let held = gate();
    fake.holdPuts = held.wait();
    const saving = s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    await until(() => fake.putsWaiting === 1, 'the save at PS.com');
    const sending = s.hub.sendUnsent();
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(fake.putsWaiting, 1, 'the kept copy waits for the save');
    held.open();
    fake.holdPuts = null;
    assert.deepEqual([(await saving).json.saved, (await saving).json.version], [true, '2']);
    await sending;
    // the save went alone: the older kept copy over the same record was dropped by it, never sent
    assert.equal(fake.calls.filter((c) => c.method === 'PUT').length, 1);
    assert.deepEqual(pending(s.hub.dirs.unsent), []);
    assert.equal(fake.record('ada', 'walk', '2').traces[0].samples[0].joints.j, 5, 'version 2 is the save');
    assert.equal(fake.record('ada', 'walk', '3'), undefined);

    // while kept copies are being sent, a save is refused as busy
    writeFileSync(join(s.hub.dirs.unsent, 'again.record.json'), JSON.stringify(walkRecord));
    writeFileSync(join(s.hub.dirs.unsent, 'again.send.json'), JSON.stringify({ ref: 'again', mode: 'new', base: null }));
    held = gate();
    fake.holdPuts = held.wait();
    const sendingAgain = s.call('POST', '/physical-sandbox/unsent/send');
    await until(() => fake.putsWaiting === 1, 'the kept copy at PS.com');
    const refused = await s.call('POST', '/physical-sandbox/record/save', { mode: 'over' });
    assert.equal(refused.json.reason, 'busy');
    held.open();
    fake.holdPuts = null;
    assert.equal((await sendingAgain).status, 200);
  } finally { await s.close(); await fake.stop(); }
});
