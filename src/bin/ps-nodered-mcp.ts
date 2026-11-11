#!/usr/bin/env node
// ps-nodered-mcp: the command Claude Desktop starts. It speaks MCP over stdio to Claude Desktop and
// relays tools/list and tools/call to this machine's Node-RED (POST /physical-sandbox/mcp) with the
// key from <userDir>/physical-sandbox/mcp-key. A relay, not a re-implementation: whatever tools the
// plugin registers are passed on as they are. stdout is the MCP channel, so logs go to stderr only.
//
// Node-RED's MCP route is stateless, so each request opens its own short connection; nothing is
// lost when Node-RED restarts, and a missing key or a stopped Node-RED is answered per call.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { version } from '../../package.json';

const DEFAULT_URL = 'http://127.0.0.1:1880/physical-sandbox/mcp';
const CALL_TIMEOUT_MS = 300_000;
// While Node-RED cannot be reached the bridge looks again at this interval (PS_BRIDGE_POLL_MS, in ms; see the README).
const POLL_MS = Number(process.env.PS_BRIDGE_POLL_MS) || 5000;

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

const argv = process.argv.slice(2);
const url = option(argv, '--url') ?? process.env.PS_NODERED_URL ?? DEFAULT_URL;
const userDirOption = option(argv, '--user-dir') ?? process.env.NODE_RED_USER_DIR ?? '~/.node-red';
const userDir = userDirOption === '~' ? homedir() : userDirOption.startsWith('~/') ? join(homedir(), userDirOption.slice(2)) : userDirOption;
const keyFile = join(userDir, 'physical-sandbox', 'mcp-key');

class Unavailable extends Error {}

async function readKey(): Promise<string> {
  try {
    const key = (await readFile(keyFile, 'utf8')).trim();
    if (key) return key;
  } catch { /* handled below */ }
  throw new Unavailable(
    'Node-RED のユーザーフォルダに physical-sandbox/mcp-key がありません。Node-RED にこのパッケージを入れて起動してから、もう一度お試しください\n' +
      `The key file physical-sandbox/mcp-key was not found in the Node-RED user folder (${userDir}). Install this package in Node-RED, start it, and try again.`,
  );
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT']);

/** The errors from `error` down its causes (fetch's TypeError carries the socket's error as its cause). */
function chainOf(error: unknown): any[] {
  const chain: any[] = [];
  for (let e: any = error; e && chain.length < 5; e = e.cause) chain.push(e);
  return chain;
}

/** True only when nothing answered there: a cause (however deep) with a connection error code. */
function isNetworkError(error: unknown): boolean {
  return chainOf(error).some((e) => NETWORK_CODES.has(e?.code));
}

/** What went wrong, from the deepest cause: its code and message (never the request's headers). */
function causeOf(error: unknown): string {
  const deepest = chainOf(error).at(-1);
  const code = typeof deepest?.code === 'string' ? deepest.code : '';
  const message = (typeof deepest?.message === 'string' ? deepest.message : String(deepest)).replace(/\s+/g, ' ').trim();
  return (code && !message.includes(code) ? `${code}: ${message}` : message).slice(0, 300);
}

/** Runs `use` on a fresh client connected to Node-RED; failures become Unavailable with a message for the person. */
async function withNodeRed<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const key = await readKey();
  const client = new Client({ name: 'ps-nodered-mcp', version });
  // No Origin header is set: the route refuses requests that carry one.
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  try {
    await client.connect(transport);
    return await use(client);
  } catch (error) {
    if (error instanceof Unavailable || error instanceof McpError) throw error;
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
      throw new Unavailable(
        'Node-RED に接続を拒否されました。mcp-key が Node-RED のものと合っていません。--user-dir を確かめてください\n' +
          `Node-RED refused the key (HTTP ${error.code}). Check that --user-dir points at the user folder of the Node-RED at ${url}.`,
      );
    }
    if (error instanceof StreamableHTTPError && error.code === 404) {
      throw new Unavailable(
        'Node-RED にこのパッケージのプラグインが見つかりません。パッケージを入れてから Node-RED をもう一度起動してください\n' +
          `Node-RED answered 404 at ${url}: the physical-sandbox plugin is not installed there. Install the package, then start Node-RED again.`,
      );
    }
    if (isNetworkError(error)) throw new Unavailable(`Node-RED が起動していません（${url}）\nNode-RED is not running at ${url}.`);
    const cause = causeOf(error);
    process.stderr.write(`ps-nodered-mcp: ${(error as Error)?.message ?? String(error)} (${cause})\n`);
    throw new Unavailable(
      `Node-RED への接続で問題が起きました（${cause}）\nSomething went wrong talking to Node-RED at ${url}: ${cause}`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

// Claude Desktop often starts before Node-RED and does not list again on its own, so tools/list never
// fails: it answers the last good list, or one stub tool, and tells the client when the real list is there.
const STUB_TOOLS = [{
  name: 'ps_status',
  description: 'Node-RED is not reachable yet (the physical-sandbox plugin answers here once Node-RED is running). Calling this explains what is missing. Node-RED に接続できていません。',
  inputSchema: { type: 'object' as const, properties: {} },
}];

const server = new Server({ name: 'physical-sandbox-nodered', version }, { capabilities: { tools: { listChanged: true } } });

let lastGood: { tools: unknown[] } | undefined;
let lastReturned: string | undefined;
let pollTimer: NodeJS.Timeout | undefined;

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refresh(), POLL_MS);
  pollTimer.unref();
}

/** Asks Node-RED for its list; when it differs from what Claude Desktop last got, tells it. */
async function refresh(): Promise<void> {
  try {
    const list = await withNodeRed((client) => client.listTools());
    lastGood = list;
    stopPolling();
    const json = JSON.stringify(list.tools);
    if (lastReturned !== undefined && json !== lastReturned) {
      lastReturned = json;
      await server.sendToolListChanged().catch(() => undefined);
    }
  } catch { /* still not reachable: the timer tries again */ }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const list = await withNodeRed((client) => client.listTools());
    lastGood = list;
    lastReturned = JSON.stringify(list.tools);
    stopPolling();
    return list;
  } catch {
    const answer = lastGood ?? { tools: STUB_TOOLS };
    lastReturned = JSON.stringify(answer.tools);
    startPolling();
    return answer;
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const result = await withNodeRed((client) => client.callTool(request.params, undefined, { timeout: CALL_TIMEOUT_MS, signal: extra.signal }));
    if (pollTimer) void refresh();
    return result;
  } catch (error) {
    if (error instanceof Unavailable) {
      startPolling();
      return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
    }
    throw error;
  }
});

server.connect(new StdioServerTransport()).then(
  () => process.stderr.write(`ps-nodered-mcp: relaying to ${url} (key file ${keyFile})\n`),
  (error) => { process.stderr.write(`ps-nodered-mcp: ${String(error)}\n`); process.exit(1); },
);
