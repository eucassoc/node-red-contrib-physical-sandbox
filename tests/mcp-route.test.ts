// The MCP route on the admin app, for this machine and its key only. Tests for src/plugin/mcp.ts
// and src/plugin/mcp-key.ts (with the hub behind them), through the MCP SDK's own client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHub } from '../src/plugin/hub.js';
import { readSettings } from '../src/plugin/settings.js';
import { mountMcp, MCP_ROUTE, MCP_BODY_LIMIT } from '../src/plugin/mcp.js';
import { ensureKey, keyFileIn } from '../src/plugin/mcp-key.js';
import { createEditorLink } from '../src/plugin/editor-link.js';
import { fakeEditor } from './helpers/fake-editor.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ps-mcp-'));
const UNREACHABLE = 'http://127.0.0.1:9';

/** The plugin's hub and MCP route on a fake Node-RED; `X-Test-Remote` makes a request look as if it came from that address. */
async function setup(o: { adminJsonParser?: boolean; userDir?: string; warn?: (m: string) => void; link?: boolean } = {}) {
  const userDir = o.userDir ?? tmp();
  const settings = readSettings({ catalogBase: UNREACHABLE, site: 'yard' }, { userDir, env: {} });
  const red = fakeRed({ userDir, adminJsonParser: o.adminJsonParser, fakeRemote: true });
  if (o.warn) red.RED.log.warn = o.warn as any;
  const hub = createHub(red.RED, { userDir, settings, clock: fakeClock(), pollMs: 0 });
  const link = o.link ? createEditorLink(red.RED, { pingMs: 50 }) : undefined;
  mountMcp(red.RED, hub, { userDir, link });
  const base = await red.listen();
  const url = new URL(base + MCP_ROUTE);
  const key = readFileSync(join(userDir, 'physical-sandbox', 'mcp-key'), 'utf8').trim();
  return {
    userDir, hub, red, url, key,
    async client(bearer = key): Promise<Client> {
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
      return client;
    },
    async close() { hub.close(); await red.close(); },
  };
}

const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

/** One request as an MCP client sends it, with whatever headers are given on top. */
async function raw(url: URL, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const method = opts.method ?? 'POST';
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close', ...opts.headers },
    body: method === 'POST' ? (opts.body ?? JSON.stringify(INITIALIZE)) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: res.headers };
}

test('the key: 32 random bytes in hex, created 0600 under <userDir>/physical-sandbox, and the same one afterwards', () => {
  const userDir = tmp();
  const key = ensureKey(userDir);
  assert.match(key, /^[0-9a-f]{64}$/);
  const file = join(userDir, 'physical-sandbox', 'mcp-key');
  assert.equal(keyFileIn(userDir), file);
  assert.equal(readFileSync(file, 'utf8').trim(), key);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(ensureKey(userDir), key, 'kept, not made again');
  assert.notEqual(ensureKey(tmp()), key, 'another Node-RED has another key');
});

test('a key file that others may read is made 0600 and kept as it is; one with nothing in it is given a key', () => {
  const userDir = tmp();
  mkdirSync(join(userDir, 'physical-sandbox'), { recursive: true });
  const file = join(userDir, 'physical-sandbox', 'mcp-key');
  writeFileSync(file, 'my-own-key\n');
  chmodSync(file, 0o644);
  assert.equal(ensureKey(userDir), 'my-own-key');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, '  \n');
  const made = ensureKey(userDir);
  assert.match(made, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(file, 'utf8').trim(), made);
});

test('a key that is not 64 hex characters still works, with a warning in the log', async () => {
  const userDir = tmp();
  mkdirSync(join(userDir, 'physical-sandbox'), { recursive: true });
  writeFileSync(join(userDir, 'physical-sandbox', 'mcp-key'), 'my-own-key\n');
  const warnings: string[] = [];
  const s = await setup({ userDir, warn: (m) => warnings.push(m) });
  try {
    assert.equal(s.key, 'my-own-key');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /mcp-key/);
    assert.match(warnings[0], /64 hex/);
    assert.equal((await raw(s.url, { headers: { Authorization: 'Bearer my-own-key' } })).status, 200);
  } finally { await s.close(); }
  const quiet: string[] = [];
  const t = await setup({ warn: (m) => quiet.push(m) });
  try { assert.deepEqual(quiet, []); } finally { await t.close(); }
});

test('mounting makes the key at plugin start, and a second start keeps it', async () => {
  const s = await setup();
  try {
    assert.match(s.key, /^[0-9a-f]{64}$/);
    const again = await setup({ userDir: s.userDir });
    try { assert.equal(again.key, s.key); } finally { await again.close(); }
  } finally { await s.close(); }
});

test('an MCP client on this machine with the key lists ps_status and gets the hub status', async () => {
  const s = await setup();
  try {
    const client = await s.client();
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ['ps_status', 'ps_flows_read', 'ps_flow_propose', 'ps_machines_list', 'ps_machine_joints', 'ps_ik',
        'ps_scene_get', 'ps_scene_place', 'ps_scene_remove', 'ps_stream_play', 'ps_stream_stop', 'ps_stream_clear', 'ps_record_inline', 'ps_record_open', 'ps_record_save', 'ps_pane_frames']);
      assert.ok(tools[0].description && /status/i.test(tools[0].description));
      s.hub.setAgentFrames(true);
      const answer: any = await client.callTool({ name: 'ps_status', arguments: {} });
      assert.equal(answer.isError, undefined);
      assert.equal(answer.content[0].type, 'text');
      const status = JSON.parse(answer.content[0].text);
      assert.deepEqual(status, {
        login: { signedIn: false, handle: null },
        scene: { site: 'yard', devices: [] },
        agentFrames: true,
        unsent: 0,
        editors: 'unknown',
        panes: 'unknown',
      });
      // Stateless: each call is a request of its own, and two at once both answer
      const both = await Promise.all([client.callTool({ name: 'ps_status' }), client.listTools()]);
      assert.equal((both[0] as any).content[0].type, 'text');
      assert.equal(both[1].tools.length, tools.length);
    } finally { await client.close(); }
  } finally { await s.close(); }
});

test('ps_status counts the editors and panes that answer a ping on the editor link', async () => {
  const s = await setup({ link: true });
  try {
    const base = s.url.origin;
    const post = async (body: unknown) => (await fetch(`${base}/physical-sandbox/editor/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const editor = fakeEditor({ post });
    const publish = s.red.RED.comms.publish;
    s.red.RED.comms.publish = (topic: string, data: unknown, retain: boolean) => { publish(topic, data, retain); editor.deliver(topic, data); };
    const client = await s.client();
    try {
      const answer: any = await client.callTool({ name: 'ps_status', arguments: {} });
      const status = JSON.parse(answer.content[0].text);
      assert.equal(status.editors, 1);
      assert.equal(status.panes, 0);
    } finally { await client.close(); }
  } finally { await s.close(); }
});

test('no key, or a wrong one: 401, and the SDK client cannot connect', async () => {
  const s = await setup();
  try {
    const none = await raw(s.url);
    assert.equal(none.status, 401);
    assert.equal(none.json?.jsonrpc, '2.0');
    assert.match(none.json?.error?.message, /鍵/);
    assert.match(none.json?.error?.message, /key/);
    assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
    assert.match(none.json?.error?.message, /user directory/);
    assert.ok(!none.text.includes(s.userDir), 'the key file\'s place on disk is not given away');
    const wrong = await raw(s.url, { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } });
    assert.equal(wrong.status, 401);
    const short = await raw(s.url, { headers: { Authorization: `Bearer ${s.key.slice(0, 10)}` } });
    assert.equal(short.status, 401);
    const notBearer = await raw(s.url, { headers: { Authorization: s.key } });
    assert.equal(notBearer.status, 401);
    await assert.rejects(s.client('not-the-key'));
    // The editor's own way in does not open this route: it never asks Node-RED for a permission
    assert.equal(s.red.permissions.size, 0);
  } finally { await s.close(); }
});

test('from another machine: 403, even with the key; this machine by IPv4, IPv6 and IPv4-in-IPv6 is let in', async () => {
  const s = await setup();
  try {
    const auth = { Authorization: `Bearer ${s.key}` };
    for (const remote of ['192.168.1.20', '10.0.0.2', '::ffff:192.168.1.20', 'fe80::1', '127.0.0.2']) {
      const r = await raw(s.url, { headers: { ...auth, 'X-Test-Remote': remote } });
      assert.equal(r.status, 403, remote);
      assert.match(r.json?.error?.message, /PC/, remote);
    }
    const noKeyAway = await raw(s.url, { headers: { 'X-Test-Remote': '192.168.1.20' } });
    assert.equal(noKeyAway.status, 403, 'another machine is told no before the key is looked at');
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const r = await raw(s.url, { headers: { ...auth, 'X-Test-Remote': remote } });
      assert.equal(r.status, 200, remote);
      assert.equal(r.json?.result?.serverInfo?.name, 'physical-sandbox');
    }
  } finally { await s.close(); }
});

test('a request with an Origin (a page in a browser, a rebound name): 403, even from this machine with the key', async () => {
  const s = await setup();
  try {
    const auth = { Authorization: `Bearer ${s.key}` };
    for (const origin of ['http://evil.example', 'http://127.0.0.1:1880', 'null']) {
      const r = await raw(s.url, { headers: { ...auth, Origin: origin } });
      assert.equal(r.status, 403, origin);
      assert.equal(r.json?.jsonrpc, '2.0');
      assert.match(r.json?.error?.message, /ブラウザ/);
      assert.match(r.json?.error?.message, /browser/);
    }
    assert.equal((await raw(s.url, { method: 'GET', headers: { ...auth, Origin: 'http://evil.example' } })).status, 403);
  } finally { await s.close(); }
});

/** A POST with headers fetch would not send as given (Host), over a plain socket. */
function rawPost(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(INITIALIZE);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), Connection: 'close', ...headers },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end(body);
  });
}

test('another machine that says it is this one (X-Forwarded-For, Host): still 403; only the socket counts', async () => {
  const s = await setup();
  try {
    const auth = { Authorization: `Bearer ${s.key}` };
    assert.equal(await rawPost(s.url, { ...auth, 'X-Test-Remote': '192.168.1.20', 'X-Forwarded-For': '127.0.0.1', Host: '127.0.0.1' }), 403);
    assert.equal(await rawPost(s.url, { ...auth, 'X-Test-Remote': '192.168.1.20', 'X-Real-IP': '::1', Host: 'localhost' }), 403);
    assert.equal(await rawPost(s.url, auth), 200, 'and this machine is still let in');
  } finally { await s.close(); }
});

test('GET and DELETE: 405 (stateless, no stream and no session to end)', async () => {
  const s = await setup();
  try {
    const auth = { Authorization: `Bearer ${s.key}` };
    for (const method of ['GET', 'DELETE']) {
      const r = await raw(s.url, { method, headers: auth });
      assert.equal(r.status, 405, method);
      assert.equal(r.json?.error?.code, -32000);
      assert.equal(r.headers.get('allow'), 'POST');
    }
    assert.equal((await raw(s.url, { method: 'GET' })).status, 401, 'the key first');
  } finally { await s.close(); }
});

test('a body that is not JSON: a JSON-RPC parse error', async () => {
  const s = await setup();
  try {
    const r = await raw(s.url, { headers: { Authorization: `Bearer ${s.key}` }, body: '{not json' });
    assert.equal(r.status, 400);
    assert.equal(r.json?.error?.code, -32700);
  } finally { await s.close(); }
});

test(`a body over ${MCP_BODY_LIMIT / 1024 / 1024} MB, read by the route itself: 413 with the reason in Japanese and English`, async () => {
  const s = await setup();
  try {
    // Only the headers, saying more than the limit: answered before any of the body is sent (a sender
    // that kept writing would see the connection cut a second after the answer)
    const r = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = http.request(s.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${s.key}`, 'Content-Length': MCP_BODY_LIMIT + 1 },
      }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => { req.destroy(); resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(parts).toString('utf8')) }); });
      });
      req.on('error', (e) => { if (!/EPIPE|ECONNRESET/.test(String((e as NodeJS.ErrnoException).code))) reject(e); });
      req.flushHeaders();
    });
    assert.equal(r.status, 413);
    assert.match(r.json?.error?.message, /5 MB/);
    assert.match(r.json?.error?.message, /大きすぎます/);
    assert.match(r.json?.error?.message, /too large/);
  } finally { await s.close(); }
});

test('a body over 5 MB in Node-RED, whose own JSON parser answers first: the SDK client sees HTTP 413 with the reason in Japanese and English', async () => {
  const s = await setup({ adminJsonParser: true });
  try {
    const client = await s.client();
    try {
      // Under the limit the parsed body is taken as it is
      assert.equal(((await client.callTool({ name: 'ps_status', arguments: { pad: 'x'.repeat(1024 * 1024) } })) as any).content[0].type, 'text');
      await assert.rejects(
        client.callTool({ name: 'ps_status', arguments: { pad: 'x'.repeat(MCP_BODY_LIMIT) } }),
        (e: any) => {
          assert.equal(e.code, 413);
          assert.match(String(e.message), /大きすぎます（5 MB まで）/);
          assert.match(String(e.message), /too large/);
          return true;
        },
      );
    } finally { await client.close(); }
    const big = await raw(s.url, { headers: { Authorization: `Bearer ${s.key}` }, body: JSON.stringify({ pad: 'x'.repeat(MCP_BODY_LIMIT) }) });
    assert.equal(big.status, 413);
    assert.equal(big.json?.jsonrpc, '2.0');
    assert.equal(big.json?.error?.code, -32000);
  } finally { await s.close(); }
});

test('JSON that Node-RED\'s own parser cannot read: 400 with a JSON-RPC parse error, not its HTML page', async () => {
  const s = await setup({ adminJsonParser: true });
  try {
    const r = await raw(s.url, { headers: { Authorization: `Bearer ${s.key}` }, body: '{not json' });
    assert.equal(r.status, 400);
    assert.equal(r.json?.jsonrpc, '2.0');
    assert.equal(r.json?.error?.code, -32700);
    // Another machine is told no, whatever its body
    const away = await raw(s.url, { headers: { 'X-Test-Remote': '192.168.1.20' }, body: '{not json' });
    assert.equal(away.status, 403);
  } finally { await s.close(); }
});

test('the plugin still starts, with its hub, when the MCP route cannot be mounted: MCP is off and the log says why', async () => {
  const userDir = tmp();
  // A folder where the key file should be: the key cannot be read
  mkdirSync(join(userDir, 'physical-sandbox', 'mcp-key'), { recursive: true });
  const red = fakeRed({ userDir, settings: { physicalSandbox: { catalogBase: UNREACHABLE } } });
  const warnings: string[] = [];
  red.RED.log.warn = ((m: string) => warnings.push(m)) as any;
  const registered: any[] = [];
  (red.RED as any).plugins = { registerPlugin: (id: string, def: any) => registered.push([id, def]) };
  const { default: plugin } = await import('../src/plugin/index.js');
  (plugin as any)(red.RED);
  try {
    assert.equal(registered.length, 1);
    assert.equal(registered[0][0], 'physical-sandbox');
    assert.equal(typeof registered[0][1].hub.scene, 'function');
    assert.ok(warnings.some((w) => /MCP/.test(w) && /off/.test(w)), warnings.join('\n'));
    const base = await red.listen();
    assert.equal((await fetch(`${base}${MCP_ROUTE}`, { method: 'POST' })).status, 404, 'no MCP route');
  } finally { registered[0]?.[1].hub.close(); await red.close(); }
});
