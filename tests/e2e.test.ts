// End to end, with nothing stubbed but PS.com and the broker: a real Node-RED loads the built package
// from a user directory, a flow is deployed through the admin API, `inject → ps play → mqtt out` plays
// an inline record to an aedes broker, a robot (the test) sends the same motion live, `mqtt in → ps in`
// takes it into the hub, and saving writes one record to a fake PS.com whose traces equal the inline one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Aedes } from 'aedes';
import { FakePsCom } from './helpers/fake-pscom.js';

const require = createRequire(import.meta.url);
const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');

let RED: any;
let httpServer: http.Server;
let brokerServer: Server;
let broker: Aedes;
let fake: FakePsCom;
let base: string;
let userDir: string;
let brokerPort: number;

/** Install the package as npm would: package.json plus the files it lists, under <userDir>/node_modules. */
async function installBuiltPackage(dir: string): Promise<void> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const target = join(dir, 'node_modules', pkg.name);
  await mkdir(target, { recursive: true });
  await cp(join(repoRoot, 'package.json'), join(target, 'package.json'));
  for (const entry of pkg.files as string[]) await cp(join(repoRoot, entry), join(target, entry), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'node-red-project', private: true, dependencies: { [pkg.name]: pkg.version } }));
}

before(async () => {
  fake = await new FakePsCom().start();
  broker = await Aedes.createBroker();
  brokerServer = createServer(broker.handle);
  await new Promise<void>((done) => brokerServer.listen(0, '127.0.0.1', done));
  brokerPort = (brokerServer.address() as AddressInfo).port;

  userDir = await mkdtemp(join(tmpdir(), 'ps-e2e-'));
  await installBuiltPackage(userDir);
  RED = require('node-red');
  httpServer = http.createServer();
  RED.init(httpServer, {
    userDir, httpAdminRoot: '/', httpNodeRoot: false, uiPort: 0, flowFile: 'flows.json', credentialSecret: false,
    logging: { console: { level: 'off', metrics: false, audit: false } }, telemetry: { enabled: false }, editorTheme: { tours: false },
    physicalSandbox: { site: 'yard', catalogBase: fake.base },
  });
  httpServer.on('request', RED.httpAdmin);
  await RED.start();
  await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  await RED?.stop();
  await new Promise<void>((done) => (httpServer ? httpServer.close(() => done()) : done()));
  await new Promise<void>((done) => (broker ? broker.close(() => done()) : done()));
  await new Promise<void>((done) => (brokerServer ? brokerServer.close(() => done()) : done()));
  await fake?.stop();
  if (userDir) await rm(userDir, { recursive: true, force: true });
});

const arm = { id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } };
const inline = {
  schemaVersion: 3,
  frame: { frameId: 'site', up: '+Y', unit: 'm' },
  markers: [],
  equipment: { site: { id: 'yard' }, devices: [arm] },
  names: { arm: 'arm' },
  traces: [{ deviceId: 'arm', samples: [{ t: 0, joints: { shoulder: 0 } }, { t: 0.3, position: [0.1, 0, 0], yaw: 0.2, joints: { shoulder: 0.5 } }] }],
  routes: [],
};

const until = async <T>(get: () => T | undefined, what: string): Promise<T> => {
  for (let i = 0; i < 300; i += 1) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`waited for ${what}`);
};

test('inject → ps play → mqtt out, and mqtt in → ps in: the states reach the hub and one record is saved with the inline record\'s traces', { timeout: 30_000 }, async () => {
  const hub = require(require.resolve('@node-red/registry', { paths: [require.resolve('node-red')] })).getPlugin('physical-sandbox').hub;
  hub.setScene({ devices: [arm], names: { arm: 'arm' } });
  await hub.client.loginStart();
  // the client keeps polls 3 s apart, in real time here
  await new Promise((done) => setTimeout(done, 3100));
  assert.equal(await hub.client.loginPoll(), 'approved');

  // what the flow sends out through the broker
  const out: { topic: string; payload: any }[] = [];
  broker.on('publish', (packet) => { if (packet.topic.startsWith('ps/')) out.push({ topic: packet.topic, payload: JSON.parse(String(packet.payload)) }); });
  const subscribed = new Promise<void>((done) => broker.on('subscribe', () => done()));

  const flows = [
    { id: 'tab', type: 'tab', label: 'e2e' },
    { id: 'b', type: 'mqtt-broker', broker: '127.0.0.1', port: String(brokerPort), clientid: '', autoConnect: true, usetls: false, protocolVersion: '4', keepalive: '60', cleansession: true },
    { id: 'go', type: 'inject', z: 'tab', payload: 'start', payloadType: 'str', topic: '', once: false, wires: [['play']] },
    { id: 'play', type: 'ps play', z: 'tab', source: 'inline', record: JSON.stringify(inline), ref: '', loop: false, speed: 1, wires: [['pub']] },
    { id: 'pub', type: 'mqtt out', z: 'tab', broker: 'b', topic: '', qos: '0', retain: '', wires: [] },
    { id: 'sub', type: 'mqtt in', z: 'tab', broker: 'b', topic: 'ps/#', qos: '0', datatype: 'auto-detect', inputs: 0, wires: [['psin']] },
    { id: 'psin', type: 'ps in', z: 'tab', site: '', wires: [[]] },
  ];
  const deployed = await fetch(`${base}/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'full' }, body: JSON.stringify(flows) });
  assert.equal(deployed.status, 204, await deployed.text());
  await subscribed;

  // inject → ps play → mqtt out: the inline record's two samples reach the broker as states
  assert.equal((await fetch(`${base}/inject/go`, { method: 'POST' })).status, 200);
  await until(() => (out.length >= 2 ? true : undefined), 'the played states at the broker');
  assert.deepEqual(out.map((m) => m.topic), ['ps/yard/arm/state', 'ps/yard/arm/state']);
  assert.deepEqual(out.map((m) => m.payload.joints), [{ shoulder: 0 }, { shoulder: 0.5 }]);
  assert.deepEqual(out[1]!.payload.position, [0.1, 0, 0]);
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(hub.status().recorded, 0, 'what was played, and its echoes, are not kept');
  hub.stop();

  // a robot sends the same motion live (other times): mqtt in → ps in → the stream
  const at0 = Date.now() + 60_000;
  for (const [i, sample] of inline.traces[0]!.samples.entries()) {
    const { t, ...fields } = sample;
    broker.publish({ cmd: 'publish', topic: 'ps/yard/arm/state', payload: Buffer.from(JSON.stringify({ at: at0 + t * 1000, ...fields })), qos: 0, retain: false, dup: false }, () => {});
    assert.ok(i < 2);
  }
  await until(() => (hub.status().recorded === 2 ? true : undefined), 'two states in the stream');
  assert.deepEqual(hub.streamBuffer().map((m: any) => m.payload.joints.shoulder), [0, 0.5]);

  // record/save writes one record to PS.com with the inline record's traces
  const saved = await fetch(`${base}/physical-sandbox/record/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PS-Pane': '1' }, body: JSON.stringify({ mode: 'new', name: 'e2e-arm' }) });
  const result = await saved.json() as any;
  assert.equal(saved.status, 200, JSON.stringify(result));
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.deepEqual([result.saved, result.ref, result.version], [true, 'ada/e2e-arm', '1']);
  assert.equal([...fake.items.keys()].length, 1, 'one record at PS.com');
  const record = JSON.parse(fake.items.get('ada/e2e-arm')!.versions.get('1')!.raw.toString());
  assert.deepEqual(record.traces, inline.traces);
});
