// A round trip through a real broker: `ps play` → `mqtt out` → aedes → `mqtt in` → `ps in` → the
// hub, with Node-RED's own MQTT nodes, for each Output setting of `mqtt in` (an object, text, a Buffer);
// and with a real hub, a played record coming back through the broker is not kept as live.
import { test, after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Aedes } from 'aedes';
import psInNode from '../src/nodes/ps-in.js';
import psPlayNode from '../src/nodes/ps-play.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, realClock, validMessage } from '../src/plugin/hub.js';
import { registerRoutes } from '../src/plugin/routes.js';
import { readSettings } from '../src/plugin/settings.js';
import { fakeRed } from './helpers/fake-red.js';
import { FakePsCom } from './helpers/fake-pscom.js';

const require = createRequire(import.meta.url);
const helper = require('node-red-node-test-helper');
const mqttNode = require(require.resolve('@node-red/nodes/core/network/10-mqtt.js', { paths: [require.resolve('node-red')] }));

let broker: Aedes;
let server: Server;
let port: number;

before(async () => {
  helper.init(require.resolve('node-red'));
  broker = await Aedes.createBroker();
  server = createServer(broker.handle);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => { await helper.unload(); });

after(async () => {
  await new Promise<void>((done) => broker.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
});

/** The nodes (with `hub` as the plugin's) and the flow: ps play → mqtt out → broker → mqtt in → ps in → helper. */
function roundTrip(hub: unknown, datatype: string, play: Record<string, unknown> = { source: 'inline', record: JSON.stringify(record), ref: '' }) {
  const nodes = [mqttNode, psInNode, psPlayNode].map((fn) => (red: any) => {
    red.plugins.get = (id: string) => (id === 'physical-sandbox' ? { type: 'physical-sandbox', hub } : undefined);
    return fn(red);
  });
  return [nodes, [
    { id: 'b', type: 'mqtt-broker', broker: '127.0.0.1', port: String(port), clientid: '', autoConnect: true, usetls: false, protocolVersion: '4', keepalive: '60', cleansession: true },
    { id: 'play', type: 'ps play', loop: false, speed: 1, wires: [['out']], ...play },
    { id: 'out', type: 'mqtt out', broker: 'b', topic: '', qos: '0', retain: '', wires: [] },
    { id: 'in', type: 'mqtt in', broker: 'b', topic: 'ps/#', qos: '0', datatype, inputs: 0, wires: [['psin']] },
    { id: 'psin', type: 'ps in', site: '', wires: [['seen']] },
    { id: 'seen', type: 'helper' },
  ]] as const;
}

const record = {
  schemaVersion: 3,
  frame: { frameId: 'site', up: '+Y', unit: 'm' },
  equipment: {
    site: { id: 'local' },
    devices: [
      { id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } },
      { id: 'box', type: 'item', parent: 'site', pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } },
    ],
  },
  names: { arm: 'arm', box: 'box' },
  traces: [
    // as a record is written (a trace starts at t = 0; position, yaw, joints), so saving its own stream over it changes nothing
    { deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 0.05, joints: { j: 0.5 } }, { t: 0.1, position: [0.1, 0, 0], yaw: 0.2, joints: { j: 1 } }] },
    { deviceId: 'box', samples: [{ t: 0, position: [1, 0, 0.2] }] },
  ],
  markers: [],
  routes: [],
};

for (const datatype of ['auto-detect', 'utf8', 'buffer']) {
  test(`ps play → mqtt out → broker → mqtt in (${datatype}) → ps in: the hub gets the same states`, { timeout: 10_000 }, async () => {
    const pushed: { message: any; from: string; retained?: boolean }[] = [];
    const hub = {
      clock: realClock,
      scene: () => ({ site: 'local' }),
      push(message: unknown, from: string, opts?: { retained?: boolean }) {
        pushed.push({ message: validMessage(message), from, retained: opts?.retained });
        return true;
      },
    };
    const subscribed = new Promise<void>((done) => broker.once('subscribe', () => done()));
    await helper.load(...roundTrip(hub, datatype));
    await subscribed;
    const seen: any[] = [];
    helper.getNode('seen').on('input', (msg: any) => seen.push(msg));
    helper.getNode('play').receive({ payload: 'start' });

    for (let i = 0; i < 200 && (pushed.filter((p) => p.from === 'mqtt').length < 4 || seen.length < 4); i += 1) await new Promise((done) => setTimeout(done, 10));
    const played = pushed.filter((p) => p.from === 'record').map((p) => p.message);
    const heard = pushed.filter((p) => p.from === 'mqtt');
    assert.equal(played.length, 4);
    assert.deepEqual(heard.map((p) => p.message), played, 'the same messages, in the same order');
    assert.deepEqual(heard.map((p) => p.retained), [false, false, false, false]);
    assert.equal(seen.length, 4, 'and on out of ps in');
    const kind = datatype === 'buffer' ? 'buffer' : datatype === 'utf8' ? 'string' : 'object';
    assert.ok(seen.every((m) => (kind === 'buffer' ? Buffer.isBuffer(m.payload) : typeof m.payload === kind)), `${kind} payloads`);
  });
}

test('a record played out through the broker and back into ps in (twice as fast) moves the pane but is not kept: saving over changes nothing', { timeout: 20_000 }, async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'walk', '1', record);
  const userDir = mkdtempSync(join(tmpdir(), 'ps-broker-'));
  const settings = readSettings({ catalogBase: fake.base, localMachineDirs: [] }, { userDir, env: {} });
  const red = fakeRed({ userDir });
  const hub = createHub(red.RED, { userDir, settings, pollMs: 0 });
  registerRoutes(red.RED, hub, { paneDir: mkdtempSync(join(tmpdir(), 'ps-broker-pane-')), cacheRoot: mkdtempSync(join(tmpdir(), 'ps-broker-cache-')) });
  const base = await red.listen();
  const call = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PS-Pane': '1' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() as any };
  };
  try {
    await hub.client.loginStart();
    await hub.client.loginPoll();
    let r = await call('/physical-sandbox/stream/play', { ref: 'ada/walk' }); // the pane opens the record
    assert.equal(r.status, 200);
    hub.stop();
    const recorded = hub.status().recorded;
    assert.equal(recorded, 4);
    const buffer = hub.streamBuffer();

    const subscribed = new Promise<void>((done) => broker.once('subscribe', () => done()));
    await helper.load(...roundTrip(hub, 'auto-detect', { source: 'record', record: '', ref: 'ada/walk', speed: 2 }));
    await subscribed;
    const seen: any[] = [];
    helper.getNode('seen').on('input', (msg: any) => seen.push(msg));
    const before = red.published.length;
    helper.getNode('play').receive({ payload: 'start' });
    for (let i = 0; i < 300 && seen.length < 4; i += 1) await new Promise((done) => setTimeout(done, 10));
    assert.equal(seen.length, 4, 'every played state came back through the broker');
    const states = red.published.slice(before).filter((p) => p.topic === 'ps-pane/state');
    assert.equal(states.filter((p) => p.data.from === 'record').length, 4, 'played to the panes');
    assert.equal(hub.status().recorded, recorded, 'the echoes are not kept');
    assert.deepEqual(hub.streamBuffer(), buffer, 'the opened record\'s states, on its own time');

    r = await call('/physical-sandbox/record/save', { mode: 'over' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.saved, r.json.version, r.json.unchanged], [true, '1', true]);

    // a live message of the same device at another time is kept, as before
    assert.equal(hub.push({ topic: 'ps/local/arm/state', payload: { at: realClock.now() + 60_000, joints: { j: 9 } } }, 'mqtt'), true);
    assert.equal(hub.status().recorded, recorded - 3 + 1, 'the arm\'s loaded trace gave way to the live state');
  } finally {
    hub.close();
    await red.close();
    await fake.stop();
  }
});
