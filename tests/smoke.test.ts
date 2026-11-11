// Smoke test: a real Node-RED loads the built package (plugin and nodes) from a temp userDir.
// PS_NODE_RED picks which Node-RED to run: 'node-red' (4.1.x, the floor) or 'node-red-5'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const nodeRedName = process.env.PS_NODE_RED || 'node-red';
const nodeRedRequire = createRequire(require.resolve(`${nodeRedName}/package.json`));

let RED: any;
let server: http.Server;
let base: string;
let userDir: string;
let robotsDir: string;

// Install the package as npm would: package.json plus the files it lists, under <userDir>/node_modules.
async function installBuiltPackage(dir: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const target = join(dir, 'node_modules', pkg.name);
  await mkdir(target, { recursive: true });
  await cp(join(repoRoot, 'package.json'), join(target, 'package.json'));
  for (const entry of pkg.files as string[]) {
    await cp(join(repoRoot, entry), join(target, entry), { recursive: true });
  }
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'node-red-project', private: true, dependencies: { [pkg.name]: pkg.version } }, null, 2),
  );
  return target;
}

async function get(path: string, accept: string): Promise<{ status: number; body: string }> {
  const res = await fetch(base + path, { headers: { Accept: accept } });
  return { status: res.status, body: await res.text() };
}

before(async () => {
  userDir = await mkdtemp(join(tmpdir(), 'ps-nr-smoke-'));
  const installed = await installBuiltPackage(userDir);
  // Files where the installed plugin serves its pane from (the pane itself is built by a later task)
  await mkdir(join(installed, 'dist', 'pane', 'assets'), { recursive: true });
  await writeFile(join(installed, 'dist', 'pane', 'smoke.js'), 'export const smoke = 1;\n');
  await writeFile(join(installed, 'dist', 'pane', 'assets', 'deep.css'), 'body {}\n');
  // A robot in a local folder
  robotsDir = await mkdtemp(join(tmpdir(), 'ps-nr-robots-'));
  await mkdir(join(robotsDir, 'myarm', 'assets'), { recursive: true });
  await writeFile(join(robotsDir, 'myarm', 'bundle.json'), JSON.stringify({ id: 'myarm', rootLink: 'base', links: { base: { visuals: [{ mesh: 'assets/base.bin' }] } }, joints: [] }));
  await writeFile(join(robotsDir, 'myarm', 'assets', 'base.bin'), 'mesh of myarm');
  RED = require(nodeRedName);
  server = http.createServer();
  RED.init(server, {
    userDir,
    httpAdminRoot: '/',
    httpNodeRoot: false,
    uiPort: 0,
    flowFile: 'flows.json',
    credentialSecret: false,
    logging: { console: { level: 'off', metrics: false, audit: false } },
    telemetry: { enabled: false },
    editorTheme: { tours: false },
    physicalSandbox: { site: 'smoke', catalogBase: 'http://127.0.0.1:9', localMachineDirs: [robotsDir] },
  });
  server.on('request', RED.httpAdmin);
  await RED.start();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await RED?.stop();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  if (userDir) await rm(userDir, { recursive: true, force: true });
  if (robotsDir) await rm(robotsDir, { recursive: true, force: true });
});

test('the chosen Node-RED is the one running', async () => {
  const expected = nodeRedRequire('./package.json').version;
  const { status, body } = await get('/settings', 'application/json');
  assert.equal(status, 200);
  // Node-RED adds '-git' to its version when a .git folder sits just above its node_modules (this repo's).
  assert.equal(JSON.parse(body).version.replace(/-git$/, ''), expected);
});

test('GET /plugins lists the physical-sandbox plugin, loaded without error', async () => {
  const { status, body } = await get('/plugins', 'application/json');
  assert.equal(status, 200);
  const sets = JSON.parse(body) as any[];
  const set = sets.find((s) => s.module === 'node-red-contrib-physical-sandbox');
  assert.ok(set, `no plugin set from this package in ${body}`);
  assert.equal(set.err, undefined);
  assert.deepEqual(
    set.plugins.map((p: any) => [p.id, p.type]),
    [['physical-sandbox', 'physical-sandbox']],
  );
});

test('the runtime plugin carries a hub object for the nodes', () => {
  const registry = nodeRedRequire('@node-red/registry');
  const plugin = registry.getPlugin('physical-sandbox');
  assert.equal(plugin?.type, 'physical-sandbox');
  assert.equal(typeof plugin?.hub, 'object');
  assert.notEqual(plugin.hub, null);
});

test('the editor side of the plugin adds the sidebar tab: the pane in an iframe, and a button for a window of its own', async () => {
  const { status, body } = await get('/plugins', 'text/html');
  assert.equal(status, 200);
  assert.match(body, /RED\.plugins\.registerPlugin\(\s*['"]physical-sandbox['"]/);
  assert.match(body, /RED\.sidebar\.addTab\(/);
  assert.match(body, /<iframe/);
  assert.match(body, /physical-sandbox\/pane/);
  assert.match(body, /RED\.comms\.subscribe\('ps-pane\/#'/);
  assert.match(body, /別ウィンドウで開く/);
  assert.doesNotMatch(body, /access_token=/, 'no token in an address: the pane is given it by postMessage');
  assert.match(body, /ps-pane-token/);
});

test('GET /nodes lists the ps-in and ps-play node sets with their types, enabled', async () => {
  const { status, body } = await get('/nodes', 'application/json');
  assert.equal(status, 200);
  const sets = (JSON.parse(body) as any[]).filter((s) => s.module === 'node-red-contrib-physical-sandbox');
  const byName = Object.fromEntries(sets.map((s) => [s.name, s]));
  for (const [name, type] of [['ps-in', 'ps in'], ['ps-play', 'ps play']]) {
    const set = byName[name];
    assert.ok(set, `no node set ${name} in ${body}`);
    assert.equal(set.err, undefined, `${name}: ${JSON.stringify(set.err)}`);
    assert.equal(set.enabled, true);
    assert.deepEqual(set.types, [type]);
  }
});

test('the editor gets the templates and help of both nodes', async () => {
  const { status, body } = await get('/nodes', 'text/html');
  assert.equal(status, 200);
  for (const type of ['ps in', 'ps play']) {
    assert.match(body, new RegExp(`RED\\.nodes\\.registerType\\(\\s*['"]${type}['"]`));
    assert.match(body, new RegExp(`data-template-name="${type}"`));
    assert.match(body, new RegExp(`data-help-name="${type}"`));
  }
});

/** Subscribe to `ps-pane/#` on Node-RED's comms socket as an editor does; the messages it is sent. */
async function paneSocket(): Promise<{ received: { topic: string; data: any }[]; close: () => void }> {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/comms');
  const received: { topic: string; data: any }[] = [];
  ws.addEventListener('message', (event) => {
    for (const m of JSON.parse(String(event.data))) received.push(m);
  });
  await new Promise<void>((done, fail) => { ws.addEventListener('open', () => done()); ws.addEventListener('error', fail); });
  ws.send(JSON.stringify({ subscribe: 'ps-pane/#' }));
  return { received, close: () => ws.close() };
}

async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`waited for ${what}`);
}

test('the plugin answers on the admin app with the scene of the configured site', async () => {
  const { status, body } = await get('/physical-sandbox/scene', 'application/json');
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).site, 'smoke');
});

test('two editors see the same stream, and one that subscribes late gets the scene and the latest state at once', async () => {
  const hub = nodeRedRequire('@node-red/registry').getPlugin('physical-sandbox').hub;
  const early = await paneSocket();
  try {
    await until(() => early.received.find((m) => m.topic === 'ps-pane/scene'), 'the scene');
    hub.setScene({ devices: [{ id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }], names: { arm: 'arm' } });
    assert.equal(hub.push({ topic: 'ps/smoke/arm/state', payload: { at: 1, joints: { j: 0.5 } } }, 'mqtt'), true);
    assert.equal(hub.push({ topic: 'ps/smoke/arm/state', payload: { at: 2, joints: { k: 1 } } }, 'mqtt'), true);
    await new Promise((done) => setTimeout(done, 150)); // the snapshot goes at most ten times a second

    const late = await paneSocket();
    try {
      const scene = await until(() => late.received.find((m) => m.topic === 'ps-pane/scene')?.data, 'the scene, late');
      assert.deepEqual(scene.devices.map((d: any) => d.id), ['arm']);
      const snapshot = await until(() => late.received.find((m) => m.topic === 'ps-pane/snapshot')?.data, 'the snapshot, late');
      assert.deepEqual(snapshot, [{ topic: 'ps/smoke/arm/state', payload: { at: 2, joints: { j: 0.5, k: 1 } }, at: 2 }]);
      const status = await until(() => late.received.find((m) => m.topic === 'ps-pane/status')?.data, 'the status, late');
      assert.equal(status.recorded, 2);

      hub.push({ topic: 'ps/smoke/arm/state', payload: { at: 3, joints: { j: 1 } } }, 'mqtt');
      for (const pane of [early, late]) {
        const state = await until(() => pane.received.find((m) => m.topic === 'ps-pane/state' && m.data.at === 3)?.data, 'the state at 3');
        assert.deepEqual(state.payload, { at: 3, joints: { j: 1 } });
      }
    } finally { late.close(); }
  } finally { early.close(); }
});

test('the routes with a path after them answer under this Node-RED\'s express: pane files and local bundle files', async () => {
  let r = await get('/physical-sandbox/pane/static/smoke.js', '*/*');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'export const smoke = 1;\n');
  r = await get('/physical-sandbox/pane/static/assets/deep.css', '*/*');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'body {}\n');
  assert.equal((await get('/physical-sandbox/pane/static/missing.js', '*/*')).status, 404);
  assert.equal((await get('/physical-sandbox/pane/static/%2e%2e/plugin/index.js', '*/*')).status, 404);

  r = await get('/physical-sandbox/bundles/local/0/myarm/bundle.json', 'application/json');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).id, 'myarm');
  r = await get('/physical-sandbox/bundles/local/0/myarm/assets/base.bin', '*/*');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'mesh of myarm');
  assert.equal((await get('/physical-sandbox/bundles/local/0/%2e%2e/myarm/bundle.json', '*/*')).status, 404);
});

test('a write is taken as JSON (read by Node-RED) or with the pane\'s header, and refused as a plain form', async () => {
  const post = (path: string, headers: Record<string, string>, body?: string) => fetch(`${base}/physical-sandbox/${path}`, { method: 'POST', headers, body });
  let r = await post('stream/stop', { 'Content-Type': 'text/plain' }, 'x');
  assert.equal(r.status, 403);
  assert.equal((await r.json()).reason, 'not-pane');
  assert.equal((await post('stream/stop', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'a=1')).status, 403);
  assert.equal((await post('stream/stop', { 'X-PS-Pane': '1' })).status, 200);
  r = await post('scene/place', { 'Content-Type': 'application/json' }, JSON.stringify({ product: 'myarm', xyz: [1, 2] }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).device.id, 'myarm-1');
});

test('an MCP client on this machine, with the key the plugin made in the userDir, lists ps_status through this Node-RED (its JSON parser in front)', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const key = (await readFile(join(userDir, 'physical-sandbox', 'mcp-key'), 'utf8')).trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  const url = new URL(`${base}/physical-sandbox/mcp`);
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['ps_status']);
    const answer: any = await client.callTool({ name: 'ps_status', arguments: {} });
    assert.equal(JSON.parse(answer.content[0].text).scene.site, 'smoke');
  } finally { await client.close(); }
  const noKey = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(noKey.status, 401);
});
