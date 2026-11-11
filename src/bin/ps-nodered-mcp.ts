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

const DEFAULT_URL = 'http://127.0.0.1:1880/physical-sandbox/mcp';
const CALL_TIMEOUT_MS = 300_000;

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

/** Runs `use` on a fresh client connected to Node-RED; failures become Unavailable with a message for the person. */
async function withNodeRed<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const key = await readKey();
  const client = new Client({ name: 'ps-nodered-mcp', version: '0.0.0' });
  // No Origin header is set: the route refuses requests that carry one.
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  try {
    await client.connect(transport);
    return await use(client);
  } catch (error) {
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
      throw new Unavailable(
        'Node-RED に断られました。mcp-key が Node-RED のものと合っていません。--user-dir を確かめてください\n' +
          `Node-RED refused the key (HTTP ${error.code}). Check that --user-dir points at the user folder of the Node-RED at ${url}.`,
      );
    }
    // An answer from Node-RED (an HTTP status or a JSON-RPC error) goes on as it is; only silence means it is not running.
    if (error instanceof StreamableHTTPError || error instanceof McpError) throw error;
    throw new Unavailable(`Node-RED が起動していません（${url}）\nNode-RED is not running at ${url}.`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const server = new Server({ name: 'physical-sandbox-nodered', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return await withNodeRed((client) => client.listTools());
  } catch (error) {
    if (error instanceof Unavailable) throw new Error(error.message);
    throw error;
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await withNodeRed((client) => client.callTool(request.params, undefined, { timeout: CALL_TIMEOUT_MS }));
  } catch (error) {
    if (error instanceof Unavailable) return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
    throw error;
  }
});

server.connect(new StdioServerTransport()).then(
  () => process.stderr.write(`ps-nodered-mcp: relaying to ${url} (key file ${keyFile})\n`),
  (error) => { process.stderr.write(`ps-nodered-mcp: ${String(error)}\n`); process.exit(1); },
);
