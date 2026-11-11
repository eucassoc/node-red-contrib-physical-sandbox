// Smoke test: a real Node-RED with adminAuth (a user made up for this run) loads the built package.
// The editor's routes ask for a token; the MCP route does not, and answers an MCP client on this
// machine that has the key. PS_NODE_RED picks which Node-RED to run, as in smoke.test.ts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { installBuiltPackage } from './helpers/built-package.js';

const require = createRequire(import.meta.url);
const nodeRedName = process.env.PS_NODE_RED || 'node-red';
const nodeRedRequire = createRequire(require.resolve(`${nodeRedName}/package.json`));
const bcrypt = createRequire(nodeRedRequire.resolve('@node-red/editor-api/package.json'))('bcryptjs');

let RED: any;
let server: http.Server;
let base: string;
let userDir: string;

before(async () => {
  userDir = await mkdtemp(join(tmpdir(), 'ps-nr-auth-'));
  await installBuiltPackage(userDir);
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
    // A user only this run knows: nothing here signs in, it only turns adminAuth on
    adminAuth: { type: 'credentials', users: [{ username: 'tester', password: bcrypt.hashSync(randomBytes(16).toString('hex'), 8), permissions: '*' }] },
    physicalSandbox: { site: 'guarded', catalogBase: 'http://127.0.0.1:9' },
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
});

test('with adminAuth on, the editor\'s routes ask for a token, and the MCP route still answers ps_status with the key', async () => {
  assert.equal((await fetch(`${base}/flows`)).status, 401);
  assert.equal((await fetch(`${base}/physical-sandbox/scene`)).status, 401);
  const key = (await readFile(join(userDir, 'physical-sandbox', 'mcp-key'), 'utf8')).trim();
  const client = new Client({ name: 'smoke-auth', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/physical-sandbox/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  try {
    const answer: any = await client.callTool({ name: 'ps_status', arguments: {} });
    assert.equal(JSON.parse(answer.content[0].text).scene.site, 'guarded');
  } finally { await client.close(); }
  const noKey = await fetch(`${base}/physical-sandbox/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(noKey.status, 401);
  assert.equal((await noKey.json()).jsonrpc, '2.0', 'the MCP route\'s own 401, not Node-RED\'s');
});
