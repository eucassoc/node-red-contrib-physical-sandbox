// A round trip through a real broker: `ps play` → `mqtt out` → aedes → `mqtt in` → `ps in` → the
// hub, with Node-RED's own MQTT nodes, for each Output setting of `mqtt in` (an object, text, a Buffer).
import { test, after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Aedes } from 'aedes';
import psInNode from '../src/nodes/ps-in.js';
import psPlayNode from '../src/nodes/ps-play.js';
import { realClock, validMessage } from '../src/plugin/hub.js';

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
    { deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 0.05, joints: { j: 0.5 } }, { t: 0.1, joints: { j: 1 }, position: [0.1, 0, 0], yaw: 0.2 }] },
    { deviceId: 'box', samples: [{ t: 0.05, position: [1, 0, 0.2] }] },
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
    const nodes = [mqttNode, psInNode, psPlayNode].map((fn) => (red: any) => {
      red.plugins.get = (id: string) => (id === 'physical-sandbox' ? { type: 'physical-sandbox', hub } : undefined);
      return fn(red);
    });
    const subscribed = new Promise<void>((done) => broker.once('subscribe', () => done()));
    await helper.load(nodes, [
      { id: 'b', type: 'mqtt-broker', broker: '127.0.0.1', port: String(port), clientid: '', autoConnect: true, usetls: false, protocolVersion: '4', keepalive: '60', cleansession: true },
      { id: 'play', type: 'ps play', source: 'inline', record: JSON.stringify(record), ref: '', loop: false, speed: 1, wires: [['out']] },
      { id: 'out', type: 'mqtt out', broker: 'b', topic: '', qos: '0', retain: '', wires: [] },
      { id: 'in', type: 'mqtt in', broker: 'b', topic: 'ps/#', qos: '0', datatype, inputs: 0, wires: [['psin']] },
      { id: 'psin', type: 'ps in', site: '', wires: [['seen']] },
      { id: 'seen', type: 'helper' },
    ]);
    await subscribed;
    const seen: any[] = [];
    helper.getNode('seen').on('input', (msg: any) => seen.push(msg));
    helper.getNode('play').receive({ payload: 'start' });

    for (let i = 0; i < 200 && pushed.filter((p) => p.from === 'mqtt').length < 4; i += 1) await new Promise((done) => setTimeout(done, 10));
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
