// The MCP route on the admin app, for this machine and its key only. Tests for src/plugin/mcp.ts
// and src/plugin/mcp-key.ts (with the hub behind them), through the MCP SDK's own client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHub } from '../src/plugin/hub.js';
import { readSettings } from '../src/plugin/settings.js';
import { mountMcp, MCP_ROUTE, MCP_BODY_LIMIT } from '../src/plugin/mcp.js';
import { ensureKey, keyFileIn } from '../src/plugin/mcp-key.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ps-mcp-'));
const UNREACHABLE = 'http://127.0.0.1:9';

/** The plugin's hub and MCP route on a fake Node-RED; `X-Test-Remote` makes a request look as if it came from that address. */
async function setup(o: { adminJsonParser?: boolean; userDir?: string } = {}) {
  const userDir = o.userDir ?? tmp();
  const settings = readSettings({ catalogBase: UNREACHABLE, site: 'yard' }, { userDir, env: {} });
  const red = fakeRed({ userDir, adminJsonParser: o.adminJsonParser });
  red.RED.httpAdmin.use((req: any, _res: any, next: () => void) => {
    const remote = req.headers['x-test-remote'];
    if (typeof remote === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: remote, configurable: true });
    next();
  });
  const hub = createHub(red.RED, { userDir, settings, clock: fakeClock(), pollMs: 0 });
  mountMcp(red.RED, hub, { userDir });
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

test('a key file that others may read is made 0600; one with nothing in it is given a key', () => {
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
      assert.deepEqual(tools.map((t) => t.name), ['ps_status']);
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
      });
      // Stateless: each call is a request of its own, and two at once both answer
      const both = await Promise.all([client.callTool({ name: 'ps_status' }), client.listTools()]);
      assert.equal((both[0] as any).content[0].type, 'text');
      assert.equal(both[1].tools.length, 1);
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
    const big = JSON.stringify({ ...INITIALIZE, params: { ...INITIALIZE.params, pad: 'x'.repeat(MCP_BODY_LIMIT) } });
    const r = await raw(s.url, { headers: { Authorization: `Bearer ${s.key}` }, body: big });
    assert.equal(r.status, 413);
    assert.match(r.json?.error?.message, /5 MB/);
    assert.match(r.json?.error?.message, /大きすぎます/);
    assert.match(r.json?.error?.message, /too large/);
  } finally { await s.close(); }
});

test('a body over 5 MB in Node-RED, whose own JSON parser answers first: the SDK client sees HTTP 413', async () => {
  const s = await setup({ adminJsonParser: true });
  try {
    const client = await s.client();
    try {
      // Under the limit the parsed body is taken as it is
      assert.equal(((await client.callTool({ name: 'ps_status', arguments: { pad: 'x'.repeat(1024 * 1024) } })) as any).content[0].type, 'text');
      await assert.rejects(
        client.callTool({ name: 'ps_status', arguments: { pad: 'x'.repeat(MCP_BODY_LIMIT) } }),
        (e: any) => { assert.equal(e.code, 413); assert.match(String(e.message), /413|too large/i); return true; },
      );
    } finally { await client.close(); }
  } finally { await s.close(); }
});
