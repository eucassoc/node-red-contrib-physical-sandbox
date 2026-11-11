// The ps-nodered-mcp bridge: the built bin, spawned as Claude Desktop would, against a real Node-RED.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installBuiltPackage, repoRoot } from './helpers/built-package.js';

const require = createRequire(import.meta.url);
const BIN = join(repoRoot, 'dist', 'bin', 'ps-nodered-mcp.js');

let RED: any;
let server: http.Server;
let userDir: string;
let url: string;
let key: string;
let running = false;

before(async () => {
  userDir = await mkdtemp(join(tmpdir(), 'ps-bridge-'));
  await installBuiltPackage(userDir);
  RED = require('node-red');
  server = http.createServer();
  RED.init(server, {
    userDir, httpAdminRoot: '/', httpNodeRoot: false, uiPort: 0, flowFile: 'flows.json', credentialSecret: false,
    logging: { console: { level: 'off', metrics: false, audit: false } },
    telemetry: { enabled: false }, editorTheme: { tours: false },
    physicalSandbox: { site: 'bridge', catalogBase: 'http://127.0.0.1:9' },
  });
  server.on('request', RED.httpAdmin);
  await RED.start();
  running = true;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/physical-sandbox/mcp`;
  key = (await readFile(join(userDir, 'physical-sandbox', 'mcp-key'), 'utf8')).trim();
});

after(async () => {
  if (running) await RED.stop();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  if (userDir) await rm(userDir, { recursive: true, force: true });
});

/** A client on the bridge's stdio, with stderr collected. */
async function viaBridge(args: string[], env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [BIN, ...args], stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: userDir, ...env },
  });
  let err = '';
  transport.stderr?.on('data', (d) => { err += d; });
  const client = new Client({ name: 'desktop', version: '0.0.0' });
  await client.connect(transport);
  return { client, err: () => err, close: () => client.close() };
}

const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

test('lists the tools of Node-RED and calls one through the bridge', async () => {
  const b = await viaBridge(['--url', url, '--user-dir', userDir]);
  try {
    const { tools } = await b.client.listTools();
    assert.ok(tools.some((t) => t.name === 'ps_status'));
    const r: any = await b.client.callTool({ name: 'ps_status', arguments: {} });
    assert.notEqual(r.isError, true);
    assert.ok(JSON.parse(text(r)), 'ps_status answers JSON');
    assert.ok(!b.err().includes(key), 'the key is never printed');
  } finally { await b.close(); }
});

test('url and user folder can come from the environment', async () => {
  const b = await viaBridge([], { PS_NODERED_URL: url, NODE_RED_USER_DIR: userDir });
  try {
    const r: any = await b.client.callTool({ name: 'ps_status', arguments: {} });
    assert.notEqual(r.isError, true);
  } finally { await b.close(); }
});

test('a missing key file: starts, and each call says where the key should be (Japanese and English)', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'ps-bridge-nokey-'));
  const b = await viaBridge(['--url', url, '--user-dir', empty]);
  try {
    const r: any = await b.client.callTool({ name: 'ps_status', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(text(r), /Node-RED のユーザーフォルダに physical-sandbox\/mcp-key がありません/);
    assert.match(text(r), /mcp-key/);
    assert.match(text(r), /[Nn]ot found|missing/);
  } finally { await b.close(); await rm(empty, { recursive: true, force: true }); }
});

test('a wrong key is reported, not retried', async () => {
  const wrong = await mkdtemp(join(tmpdir(), 'ps-bridge-wrong-'));
  await mkdir(join(wrong, 'physical-sandbox'));
  await writeFile(join(wrong, 'physical-sandbox', 'mcp-key'), 'f'.repeat(64));
  const b = await viaBridge(['--url', url, '--user-dir', wrong]);
  try {
    const r: any = await b.client.callTool({ name: 'ps_status', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(text(r), /断られ|refused/);
    assert.ok(!text(r).includes('f'.repeat(64)));
  } finally { await b.close(); await rm(wrong, { recursive: true, force: true }); }
});

test('with Node-RED stopped, a call answers the Japanese line and the English one, and the bridge keeps running', async () => {
  const b = await viaBridge(['--url', url, '--user-dir', userDir]);
  try {
    await b.client.listTools();
    await RED.stop();
    running = false;
    await new Promise<void>((done) => server.close(() => done()));
    const r: any = await b.client.callTool({ name: 'ps_status', arguments: {} });
    assert.equal(r.isError, true);
    assert.ok(text(r).includes(`Node-RED が起動していません（${url}）`), text(r));
    assert.match(text(r), /not running/i);
    const again: any = await b.client.callTool({ name: 'ps_status', arguments: {} });
    assert.equal(again.isError, true);
    assert.ok(!b.err().includes(key));
  } finally { await b.close(); }
});

test('with Node-RED stopped, tools/list still succeeds with one stub tool', async () => {
  // runs after the test above, which stopped Node-RED
  const b = await viaBridge(['--url', url, '--user-dir', userDir]);
  try {
    const { tools } = await b.client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['ps_status']);
    assert.match(tools[0].description ?? '', /not reachable/);
  } finally { await b.close(); }
});

test('a 404 from Node-RED says the plugin is missing; another failure is logged and answered in general terms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ps-bridge-404-'));
  await mkdir(join(dir, 'physical-sandbox'));
  await writeFile(join(dir, 'physical-sandbox', 'mcp-key'), 'a'.repeat(64));
  const status = { code: 404 };
  const other = http.createServer((_req, res) => { res.statusCode = status.code; res.end('no'); });
  await new Promise<void>((done) => other.listen(0, '127.0.0.1', done));
  const u = `http://127.0.0.1:${(other.address() as AddressInfo).port}/physical-sandbox/mcp`;
  const b = await viaBridge(['--url', u, '--user-dir', dir]);
  try {
    const r: any = await b.client.callTool({ name: 'ps_status', arguments: {} });
    assert.match(text(r), /プラグインが見つかりません/);
    assert.doesNotMatch(text(r), /起動していません（/);
    status.code = 500;
    const r2: any = await b.client.callTool({ name: 'ps_status', arguments: {} });
    assert.equal(r2.isError, true);
    assert.doesNotMatch(text(r2), /起動していません（/);
    assert.match(b.err(), /ps-nodered-mcp: /);
  } finally { await b.close(); other.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Node-RED comes up after the bridge: the client gets list_changed and then the real list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ps-bridge-late-'));
  await mkdir(join(dir, 'physical-sandbox'));
  await writeFile(join(dir, 'physical-sandbox', 'mcp-key'), 'b'.repeat(64));
  // a free port, then nothing listening on it
  const probe = http.createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const u = `http://127.0.0.1:${port}/physical-sandbox/mcp`;
  const b = await viaBridge(['--url', u, '--user-dir', dir], { PS_BRIDGE_POLL_MS: '200' });
  let late: http.Server | undefined;
  try {
    const changed = new Promise<void>((done) => b.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => done()));
    assert.deepEqual((await b.client.listTools()).tools.map((t) => t.name), ['ps_status']);
    late = http.createServer(async (req, res) => {
      const mcp = new McpServer({ name: 'late', version: '0' });
      mcp.registerTool('ps_status', { description: 'real' }, async () => ({ content: [{ type: 'text', text: '{}' }] }));
      mcp.registerTool('ps_more', { description: 'more' }, async () => ({ content: [{ type: 'text', text: '{}' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((done) => late!.listen(port, '127.0.0.1', done));
    await changed;
    assert.deepEqual((await b.client.listTools()).tools.map((t) => t.name).sort(), ['ps_more', 'ps_status']);
  } finally { await b.close(); late?.closeAllConnections(); late?.close(); await rm(dir, { recursive: true, force: true }); }
});
