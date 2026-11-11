// The agent end to end, offline: a real Node-RED loads the built package, an MCP client talks to it
// through the ps-nodered-mcp bridge on stdio (as Claude Desktop does), and a fake editor
// (the real editor.html link script run in node:vm) answers over the real comms WebSocket and the real answer route.
// The agent places OpenArm, raises both hands with ps_ik, plays a 4-beat loop, is refused the pane's
// pictures (the switch is off), turns the motion into an inline record and proposes
// `inject → ps play → mqtt out` in a new tab. Nothing is deployed: GET /flows is as it was.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FakePsCom } from './helpers/fake-pscom.js';
import { fakeEditor, settle, type AjaxSettings, type FakeEditor } from './helpers/fake-editor.js';
import { installBuiltPackage, repoRoot } from './helpers/built-package.js';

const require = createRequire(import.meta.url);
const BIN = join(repoRoot, 'dist', 'bin', 'ps-nodered-mcp.js');
const openarm = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'openarm-bundle.json'), 'utf8'));

let RED: any;
let server: http.Server;
let fake: FakePsCom;
let base: string;
let userDir: string;
let cacheDir: string;
let comms: WebSocket;
let client: Client;
let editor: FakeEditor;
const previousCache = process.env.PS_CACHE_DIR;

/** What Node-RED runs: GET /flows with its revision. */
async function runningFlows(): Promise<{ rev: string; flows: any[] }> {
  const res = await fetch(`${base}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } });
  assert.equal(res.status, 200);
  return res.json() as Promise<{ rev: string; flows: any[] }>;
}

const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: args });
const json = (answer: any) => {
  assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
  return JSON.parse(answer.content[0].text);
};

before(async () => {
  fake = await new FakePsCom().start();
  // The robot comes from the psbx cache (PS_CACHE_DIR), so nothing is fetched: the joints-only OpenArm fixture
  cacheDir = await mkdtemp(join(tmpdir(), 'ps-e2e-agent-cache-'));
  const dir = join(cacheDir, 'catalog', 'physical-sandbox', 'openarm', '1');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'bundle.json'), JSON.stringify(openarm));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ kind: 'machine', display: { ja: 'OpenArm（双腕）' } }));
  await writeFile(join(cacheDir, 'catalog', 'physical-sandbox', 'openarm', 'latest'), '1');
  process.env.PS_CACHE_DIR = cacheDir;

  userDir = await mkdtemp(join(tmpdir(), 'ps-e2e-agent-'));
  await installBuiltPackage(userDir);
  RED = require('node-red');
  server = http.createServer();
  RED.init(server, {
    userDir, httpAdminRoot: '/', httpNodeRoot: false, uiPort: 0, flowFile: 'flows.json', credentialSecret: false,
    logging: { console: { level: 'off', metrics: false, audit: false } }, telemetry: { enabled: false }, editorTheme: { tours: false },
    physicalSandbox: { site: 'yard', catalogBase: fake.base },
  });
  server.on('request', RED.httpAdmin);
  await RED.start();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The person's editor: its comms over the real WebSocket, its posts to the real answer route
  editor = fakeEditor({
    post: async (_body, settings: AjaxSettings) => {
      const res = await fetch(`${base}/${settings.url}`, { method: settings.type, headers: { 'Content-Type': settings.contentType, ...settings.headers }, body: settings.data });
      const answer = await res.json();
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(answer)}`);
      return answer;
    },
  });
  comms = new WebSocket(`${base.replace('http', 'ws')}/comms`);
  await new Promise<void>((done, fail) => { comms.onopen = () => done(); comms.onerror = () => fail(new Error('comms')); });
  comms.onmessage = (event) => {
    const batch = JSON.parse(String(event.data));
    for (const m of Array.isArray(batch) ? batch : [batch]) if (typeof m?.topic === 'string') editor.deliver(m.topic, m.data);
  };
  comms.send(JSON.stringify({ subscribe: 'ps-editor/#' }));

  // Claude Desktop's side: the bridge on stdio
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, '--url', `${base}/physical-sandbox/mcp`, '--user-dir', userDir],
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: userDir },
  });
  client = new Client({ name: 'desktop', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  comms?.close();
  await RED?.stop();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  await fake?.stop();
  if (previousCache === undefined) delete process.env.PS_CACHE_DIR; else process.env.PS_CACHE_DIR = previousCache;
  if (userDir) await rm(userDir, { recursive: true, force: true });
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

test('the agent makes OpenArm raise both hands, loops the motion, and proposes a flow that nobody deploys', { timeout: 60_000 }, async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['ps_status', 'ps_machines_list', 'ps_scene_place', 'ps_ik', 'ps_stream_play', 'ps_stream_stop', 'ps_pane_frames', 'ps_record_inline', 'ps_flow_propose']) {
    assert.ok(names.includes(n), n);
  }

  // The editor is counted once the runtime's ping reaches it (the subscription is made by then)
  for (let i = 0; ; i += 1) {
    if (json(await call('ps_status')).editors === 1) break;
    assert.ok(i < 10, 'the editor never answered the ping');
    await settle(1100);
  }
  assert.equal(json(await call('ps_status')).agentFrames, false, 'the pictures switch is off at the start');

  // Place OpenArm
  const listed = json(await call('ps_machines_list', { q: 'openarm' }));
  const ref = listed.machines[0].ref;
  assert.equal(ref, 'physical-sandbox/openarm:1');
  const placed = json(await call('ps_scene_place', { product: ref, xyz: [0, 0] }));
  assert.ok(placed.device?.id, JSON.stringify(placed));

  // Both hands above the head: targets in the robot base frame that the arms reach
  const left = json(await call('ps_ik', { ref: placed.device.id, chain: 'left_arm', target: { xyz: [0, 0.25, 1.0] } }));
  const right = json(await call('ps_ik', { ref: placed.device.id, chain: 'right_arm', target: { xyz: [0, -0.25, 1.0] } }));
  assert.equal(left.reached, true, JSON.stringify(left));
  assert.equal(right.reached, true, JSON.stringify(right));
  const up = { ...left.joints, ...right.joints };
  const down = Object.fromEntries(Object.keys(up).map((k) => [k, 0]));

  // A 4-beat loop: up, down, up, down, half a second apart
  const messages = [up, down, up, down].map((joints, i) => ({ topic: `ps/yard/${placed.device.id}/state`, payload: { at: i * 500, joints } }));
  const played = json(await call('ps_stream_play', { messages, loop: true }));
  assert.equal(played.count, 4, JSON.stringify(played));
  assert.deepEqual(played.invalid, []);
  assert.equal(played.status.playing?.source, 'agent', JSON.stringify(played.status));
  assert.equal(json(await call('ps_stream_stop')).status.playing, null);
  assert.equal(json(await call('ps_status')).scene.devices.length, 1);

  // The pictures stay with the person while the switch is off
  const frames = await call('ps_pane_frames', {});
  assert.equal(frames.isError, true);
  assert.match(frames.content[0].text, /エージェントに映像を渡す/);
  assert.ok(!frames.content.some((c: any) => c.type === 'image'));

  // The motion as the inline record of a ps play node
  const inline = json(await call('ps_record_inline', { messages }));
  assert.deepEqual(inline.unknownNames, []);
  assert.equal(inline.record.traces[0].samples.length, 4);

  // Propose inject → ps play → mqtt out; the editor imports it, Node-RED runs what it ran
  const before = await runningFlows();
  const nodes = [
    { id: 'go', type: 'inject', name: 'start', payload: 'start', payloadType: 'str', x: 120, y: 80, wires: [['play']] },
    { id: 'play', type: 'ps play', name: 'bon odori', source: 'inline', record: JSON.stringify(inline.record), loop: true, x: 300, y: 80, wires: [['out']] },
    { id: 'out', type: 'mqtt out', name: 'to the robot', topic: '', qos: '0', retain: '', x: 480, y: 80, wires: [] },
  ];
  const proposed = json(await call('ps_flow_propose', { nodes, newTab: true }));
  assert.equal(proposed.imported, 3);
  assert.equal(proposed.deployed, false);
  assert.equal(editor.imports.length, 1);
  assert.deepEqual(editor.imports[0].options, { addFlow: true, generateIds: true, touchImport: true, notify: true });
  const added = editor.nodes().filter((n) => n.z === proposed.tab);
  assert.deepEqual(added.map((n) => n.type), ['inject', 'ps play', 'mqtt out']);
  assert.deepEqual(added[0].wires, [[added[1].id]]);
  assert.deepEqual(added[1].wires, [[added[2].id]]);
  await settle(100);
  assert.deepEqual(await runningFlows(), before, 'the agent never deploys');
});
