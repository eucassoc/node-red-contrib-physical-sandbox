/**
 * The plugin's MCP server for an agent on this machine, on Node-RED's admin app at
 * `/physical-sandbox/mcp` (Streamable HTTP, stateless, JSON answers): `POST` carries one JSON-RPC
 * message; `GET` and `DELETE` are answered 405 (no stream, no session).
 *
 * Who may use it: a request from this machine (the socket's address is loopback) carrying
 * `Authorization: Bearer <key>`, the key in `<userDir>/physical-sandbox/mcp-key` (mcp-key.ts). It
 * does not use Node-RED's adminAuth (a bridge to the agent cannot hold an editor token), and the
 * pane's write guard (JSON or X-PS-Pane) does not apply: the key is its guard.
 *
 * The body: Node-RED's admin app already reads `application/json` up to its `apiMaxLength` (5 MB
 * by default) and answers 413 itself above that; any other body is read here, up to
 * MCP_BODY_LIMIT, and a bigger one is answered 413 at once.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { version } from '../../package.json';
import type { Hub } from './hub.js';
import { ensureKey, keyFileIn } from './mcp-key.js';
import { readBody, refuseTooLarge } from './routes.js';

export const MCP_ROUTE = '/physical-sandbox/mcp';
export const MCP_BODY_LIMIT = 5 * 1024 * 1024;

/** The socket addresses of this machine. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// What the caller is told: the agent passes it on to the person, who may read either language
export const MCP_WORDS = {
  notHere: 'この Node-RED を動かしている PC の中からだけ接続できます / Only an MCP client on the machine running this Node-RED may connect',
  badKey: (file: string) => `MCP の鍵が違います。${file} の中身を Authorization: Bearer に指定してください / The MCP key is missing or wrong: send the contents of ${file} as Authorization: Bearer`,
  tooLarge: '送られた内容が大きすぎます（5 MB まで） / The request is too large (5 MB at most)',
  notJson: '送られた内容を JSON として読み込めませんでした / The request is not JSON',
  failed: 'MCP の処理に失敗しました / Internal server error',
};

/** What the tools reach. Later tools add to it. */
export interface McpContext {
  hub: Hub;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

/** Every tool of the plugin, on one server. */
export function registerTools(server: McpServer, ctx: McpContext): void {
  const { hub } = ctx;

  server.registerTool('ps_status', {
    description: 'The status of Physical Sandbox in this Node-RED: whether it is signed in to PS.com, the scene (its site and the ids of its devices), '
      + 'whether the person lets agents have the pane\'s picture (agentFrames), and how many saved records are still waiting to reach PS.com (unsent).',
  }, async () => {
    const status = hub.status();
    const scene = hub.scene();
    return text({
      login: status.login,
      scene: { site: scene.site, devices: scene.devices.map((d) => d.id) },
      agentFrames: status.agentFrames,
      unsent: status.unsent.length,
    });
  });
}

/** A key compared in constant time (both sides hashed, so its length is not given away either). */
function keyCheck(key: string): (header: unknown) => boolean {
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  const expected = digest(key);
  return (header) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(typeof header === 'string' ? header : '');
    return m !== null && timingSafeEqual(digest(m[1]), expected);
  };
}

export function mountMcp(RED: any, hub: Hub, opts: { userDir: string }): { newServer: () => McpServer } {
  const app = RED.httpAdmin;
  const keyFile = keyFileIn(opts.userDir);
  const keyMatches = keyCheck(ensureKey(opts.userDir));

  /** A server with every tool: one per request, as a stateless transport needs (a server holds one transport). */
  const newServer = (): McpServer => {
    const server = new McpServer({ name: 'physical-sandbox', version });
    registerTools(server, { hub });
    return server;
  };

  /** This machine first (another machine is told no before the key is looked at), then the key. */
  const guard = (req: any, res: any, next: () => void): void => {
    if (!LOOPBACK.has(String(req.socket?.remoteAddress ?? ''))) {
      res.status(403).json(rpcError(-32001, MCP_WORDS.notHere));
      return;
    }
    if (!keyMatches(req.headers?.authorization)) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json(rpcError(-32001, MCP_WORDS.badKey(keyFile)));
      return;
    }
    next();
  };

  app.post(MCP_ROUTE, guard, async (req: any, res: any) => {
    try {
      let body: unknown = req.body;
      if (!req._body) {
        const bytes = await readBody(req, MCP_BODY_LIMIT);
        if (!bytes) { refuseTooLarge(req, res, MCP_WORDS.tooLarge, rpcError(-32000, MCP_WORDS.tooLarge)); return; }
        try { body = JSON.parse(bytes.toString('utf8')); } catch { res.status(400).json(rpcError(-32700, MCP_WORDS.notJson)); return; }
      }
      const server = newServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      RED.log?.warn?.(`physical-sandbox: MCP: ${(e as Error)?.stack ?? e}`);
      if (!res.headersSent) res.status(500).json(rpcError(-32603, MCP_WORDS.failed));
    }
  });

  const notAllowed = (_req: any, res: any) => { res.status(405).set('Allow', 'POST').json(rpcError(-32000, 'Method not allowed.')); };
  app.get(MCP_ROUTE, guard, notAllowed);
  app.delete(MCP_ROUTE, guard, notAllowed);

  RED.log?.info?.(`physical-sandbox: MCP for agents on this machine at ${MCP_ROUTE} under the admin root; key in ${keyFile}`);
  return { newServer };
}
