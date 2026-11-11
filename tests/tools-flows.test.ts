// The flow tools (src/plugin/tools/flows.ts): ps_flows_read and ps_flow_propose. First against a
// real Node-RED with the built package, an MCP client on its route and the editor side of the link
// (the real script of editor.html, src/plugin/editor.html, run against a fake RED) hearing the
// runtime's comms over its WebSocket and answering through the real answer route; then, on a small
// Node-RED, what the agent is told when no editor answers, when the editor took a proposal but never
// answered, and when it could not import it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEditorLink, LINK_WORDS } from '../src/plugin/editor-link.js';
import { createHub } from '../src/plugin/hub.js';
import { mountMcp, MCP_ROUTE } from '../src/plugin/mcp.js';
import { readSettings } from '../src/plugin/settings.js';
import { FLOW_WORDS, MAX_PROPOSED_NODES } from '../src/plugin/tools/flows.js';
import { fakeEditor, settle, type AjaxSettings, type FakeEditor } from './helpers/fake-editor.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';
import { installBuiltPackage } from './helpers/built-package.js';

const require = createRequire(import.meta.url);
const PROPOSED = 'エージェントの提案を読み込みました。確かめてから Deploy してください';

let RED: any;
let server: http.Server;
let base: string;
let userDir: string;
let comms: WebSocket;
/** The editors open now: each hears what the runtime publishes on ps-editor/#. */
const editors: FakeEditor[] = [];

const deployed = [
  { id: 't1', type: 'tab', label: 'Mine', disabled: false, info: '', env: [] },
  { id: 'n1', type: 'inject', z: 't1', name: 'mine', props: [{ p: 'payload' }], repeat: '', crontab: '', once: false, onceDelay: 0.1, topic: '', payload: '', payloadType: 'date', x: 120, y: 80, wires: [['n2']] },
  { id: 'n2', type: 'debug', z: 't1', name: 'mine too', active: true, tosidebar: true, console: false, tostatus: false, complete: 'false', statusVal: '', statusType: 'auto', x: 300, y: 80, wires: [] },
];

/** What Node-RED runs: GET /flows with its revision. */
async function runningFlows(): Promise<{ rev: string; flows: any[] }> {
  const res = await fetch(`${base}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } });
  assert.equal(res.status, 200);
  return res.json() as Promise<{ rev: string; flows: any[] }>;
}

/** An editor whose posts go to this Node-RED as the browser would send them (address, headers and body as given to $.ajax). */
function openEditor(o: Parameters<typeof fakeEditor>[0] = {}): FakeEditor {
  const post = async (_body: unknown, settings: AjaxSettings) => {
    const res = await fetch(`${base}/${settings.url}`, {
      method: settings.type,
      headers: { 'Content-Type': settings.contentType, ...settings.headers },
      body: settings.data,
    });
    const answer = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(answer)}`);
    return answer;
  };
  const editor = fakeEditor({ post, ...o });
  editors.push(editor);
  return editor;
}
const closeEditors = () => { editors.length = 0; };

async function mcp(): Promise<Client> {
  const key = readFileSync(join(userDir, 'physical-sandbox', 'mcp-key'), 'utf8').trim();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + MCP_ROUTE), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: args });
const json = (answer: any) => JSON.parse(answer.content[0].text);

before(async () => {
  userDir = await mkdtemp(join(tmpdir(), 'ps-tools-flows-'));
  await installBuiltPackage(userDir);
  RED = require('node-red');
  server = http.createServer();
  RED.init(server, {
    userDir, httpAdminRoot: '/', httpNodeRoot: false, uiPort: 0, flowFile: 'flows.json', credentialSecret: false,
    logging: { console: { level: 'off', metrics: false, audit: false } }, telemetry: { enabled: false }, editorTheme: { tours: false },
    physicalSandbox: { site: 'yard', catalogBase: 'http://127.0.0.1:9' },
  });
  server.on('request', RED.httpAdmin);
  await RED.start();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = await fetch(`${base}/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'full' }, body: JSON.stringify(deployed) });
  assert.equal(put.status, 204, await put.text());

  // The editor's comms: the runtime's messages come in batches ([{topic, data}, ...])
  comms = new WebSocket(`${base.replace('http', 'ws')}/comms`);
  await new Promise<void>((done, fail) => { comms.onopen = () => done(); comms.onerror = () => fail(new Error('comms')); });
  comms.onmessage = (event) => {
    const batch = JSON.parse(String(event.data));
    for (const m of Array.isArray(batch) ? batch : [batch]) {
      if (typeof m?.topic === 'string') for (const editor of editors) editor.deliver(m.topic, m.data);
    }
  };
  comms.send(JSON.stringify({ subscribe: 'ps-editor/#' }));
  // subscribed once an editor is counted by ps_status's ping
  const probe = openEditor();
  const client = await mcp();
  try {
    for (let i = 0; ; i += 1) {
      if (json(await call(client, 'ps_status')).editors === 1) break;
      assert.ok(i < 10, 'the editor never answered the ping');
      await settle(1100); // the count is kept 10 s only after an answer; an empty count is asked again
    }
  } finally { await client.close(); }
  assert.ok(probe);
  closeEditors();
});

after(async () => {
  comms?.close();
  await RED?.stop();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  if (userDir) await rm(userDir, { recursive: true, force: true });
});

test('the agent sees both flow tools, with the shape of a proposal in the schema', async () => {
  const client = await mcp();
  try {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.ok(byName.ps_flows_read && byName.ps_flow_propose, tools.map((t) => t.name).join());
    const schema: any = byName.ps_flow_propose.inputSchema;
    assert.deepEqual(schema.required, ['nodes']);
    assert.equal(schema.properties.nodes.type, 'array');
    assert.equal(schema.properties.nodes.maxItems, MAX_PROPOSED_NODES);
    assert.deepEqual(schema.properties.nodes.items.required, ['type', 'id']);
    assert.match(schema.properties.nodes.description, /global-config/);
    assert.equal(schema.properties.newTab.type, 'boolean');
    assert.match(byName.ps_flow_propose.description ?? '', /Deploy/);
    assert.match(byName.ps_flow_propose.description ?? '', /never deploy/i);
  } finally { await client.close(); }
});

test('ps_flows_read: the open editor\'s node set, with its undeployed edits and no credentials', async () => {
  const editor = openEditor({ nodeSet: [...deployed, { id: 'e1', type: 'comment', z: 't1', name: 'not deployed yet' }] });
  const client = await mcp();
  try {
    const answer = await call(client, 'ps_flows_read');
    assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
    assert.deepEqual(json(answer), editor.nodes());
    assert.deepEqual(editor.nodeSetCalls, [{ credentials: false }]);
  } finally { await client.close(); closeEditors(); }
});

test('ps_flows_read: a node set over Node-RED\'s 5 MB JSON limit reaches the agent (the editor posts it as text)', async () => {
  const big = [{ id: 'tb', type: 'tab', label: 'Big' }, ...Array.from({ length: 30_000 }, (_, i) => ({ id: `f${i}`, type: 'function', z: 'tb', func: 'x'.repeat(200), wires: [] }))];
  assert.ok(JSON.stringify(big).length > 5 * 1024 * 1024);
  openEditor({ nodeSet: big });
  const client = await mcp();
  try {
    const answer = await call(client, 'ps_flows_read');
    assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
    assert.equal(json(answer).length, big.length);
  } finally { await client.close(); closeEditors(); }
});

test('ps_flow_propose: imported into a new tab with new ids, the notice is shown, and nothing is deployed (GET /flows unchanged)', async () => {
  const before = await runningFlows();
  const editor = openEditor({ nodeSet: deployed });
  const client = await mcp();
  try {
    // n1 is an id the person's flow already has
    const nodes = [
      { id: 'n1', type: 'inject', name: 'agent', x: 100, y: 60, wires: [['p1']] },
      { id: 'p1', type: 'ps play', name: 'dance', source: 'inline', x: 260, y: 60, wires: [[]] },
    ];
    const answer = await call(client, 'ps_flow_propose', { nodes, newTab: true });
    assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
    const result = json(answer);
    assert.equal(result.imported, 2);
    assert.equal(result.deployed, false);
    assert.match(result.next, /Deploy/);
    assert.equal(result.notInstalled, undefined, 'every type is installed here');
    assert.deepEqual(editor.imports.map((i) => i.options), [{ addFlow: true, generateIds: true, touchImport: true, notify: true }]);
    assert.deepEqual(editor.notes, [{ text: PROPOSED, type: 'compact' }]);

    // the new tab is the open one, and holds both nodes, with new ids, wired to each other
    const now = editor.nodes();
    assert.ok(!deployed.some((n) => n.id === result.tab), 'a tab of its own');
    assert.deepEqual(now.find((n) => n.id === result.tab)?.type, 'tab');
    const added = now.filter((n) => n.z === result.tab);
    assert.deepEqual(added.map((n) => n.name), ['agent', 'dance']);
    for (const n of added) assert.ok(!['n1', 'p1'].includes(n.id), `${n.id} is a new id`);
    assert.deepEqual(added[0].wires, [[added[1].id]]);
    // the clashing id was given a new one: the person's n1 is as it was
    assert.deepEqual(now.filter((n) => n.id === 'n1'), [deployed[1]]);

    // and Node-RED runs what it ran: no deploy
    await settle(50);
    assert.deepEqual(await runningFlows(), before);
    // the agent reads the proposal back from the editor
    assert.deepEqual(json(await call(client, 'ps_flows_read')), now);
  } finally { await client.close(); closeEditors(); }
});

test('ps_flow_propose: without newTab it goes into a new tab too; with newTab false into the open one', async () => {
  const editor = openEditor({ nodeSet: deployed });
  const client = await mcp();
  try {
    await call(client, 'ps_flow_propose', { nodes: [{ id: 'a', type: 'debug' }] });
    assert.equal(editor.imports[0].options.addFlow, true);
    await call(client, 'ps_flow_propose', { nodes: [{ id: 'b', type: 'debug' }], newTab: false });
    assert.equal(editor.imports[1].options.addFlow, false);
  } finally { await client.close(); closeEditors(); }
});

test('ps_flow_propose: a proposal that brings its own tab is shown in that tab, and the answer names it', async () => {
  const before = await runningFlows();
  const editor = openEditor({ nodeSet: deployed, workspace: 't1' });
  const client = await mcp();
  try {
    const nodes = [
      { id: 't1', type: 'tab', label: 'Dance' }, // the same id as the person's tab
      { id: 'a', type: 'inject', z: 't1', name: 'go', wires: [['b']] },
      { id: 'b', type: 'ps play', z: 't1', name: 'dance', wires: [[]] },
    ];
    const result = json(await call(client, 'ps_flow_propose', { nodes }));
    const now = editor.nodes();
    const tab = now.find((n) => n.type === 'tab' && n.label === 'Dance');
    assert.ok(tab && tab.id !== 't1', 'the tab got a new id');
    assert.equal(result.tab, tab.id, 'the answer names the proposal\'s tab, not the person\'s');
    assert.deepEqual(editor.shown, [tab.id], 'and the editor shows it');
    assert.deepEqual(now.filter((n) => n.z === tab.id).map((n) => n.name), ['go', 'dance']);
    assert.deepEqual(now.find((n) => n.id === 't1'), deployed[0], 'the person\'s tab is as it was');
    assert.deepEqual(await runningFlows(), before);
  } finally { await client.close(); closeEditors(); }
});

test('ps_flow_propose: credentials are taken out before the editor is asked, and the answer says so', async () => {
  const editor = openEditor({ nodeSet: deployed });
  const client = await mcp();
  try {
    const nodes = [
      { id: 'b', type: 'mqtt-broker', broker: '127.0.0.1', credentials: { user: 'u', password: 'secret' } },
      { id: 'o', type: 'mqtt out', broker: 'b', topic: 'x' },
    ];
    const result = json(await call(client, 'ps_flow_propose', { nodes }));
    assert.deepEqual(editor.imports[0].nodes, [{ id: 'b', type: 'mqtt-broker', broker: '127.0.0.1' }, { id: 'o', type: 'mqtt out', broker: 'b', topic: 'x' }]);
    assert.ok(!JSON.stringify(editor.posted).includes('secret'));
    assert.equal(result.credentialsRemoved, true);
    assert.ok(result.next.includes(FLOW_WORDS.credentialsRemoved));
    assert.match(FLOW_WORDS.credentialsRemoved, /資格情報/);
    assert.match(FLOW_WORDS.credentialsRemoved, /credentials/);
    // none sent: nothing said
    const plain = json(await call(client, 'ps_flow_propose', { nodes: [{ id: 'd', type: 'debug' }] }));
    assert.equal('credentialsRemoved' in plain, false);
    assert.ok(!plain.next.includes(FLOW_WORDS.credentialsRemoved));
  } finally { await client.close(); closeEditors(); }
});

test('ps_flow_propose: types this Node-RED does not have are imported all the same and named in the answer', async () => {
  const editor = openEditor({ nodeSet: deployed, knownTypes: ['inject', 'debug', 'ps play'] });
  const client = await mcp();
  try {
    const answer = await call(client, 'ps_flow_propose', { nodes: [{ id: 'a', type: 'inject', wires: [['b']] }, { id: 'b', type: 'node-red-contrib-something' }] });
    assert.equal(answer.isError, undefined);
    const result = json(answer);
    assert.equal(result.imported, 2);
    assert.deepEqual(result.notInstalled, ['node-red-contrib-something']);
    assert.match(result.next, /node-red-contrib-something/);
    assert.match(result.next, /インストール/);
    assert.equal(editor.imports.length, 1);
  } finally { await client.close(); closeEditors(); }
});

test('ps_flow_propose refuses what is not a set of nodes, with a clear message, and asks no editor', async () => {
  const editor = openEditor({ nodeSet: deployed });
  const client = await mcp();
  try {
    const cases: [unknown, string][] = [
      [undefined, FLOW_WORDS.notArray],
      ['[{"type":"inject"}]', FLOW_WORDS.notArray],
      [{ type: 'inject' }, FLOW_WORDS.notArray],
      [[], FLOW_WORDS.empty],
      [[{ id: 'a', type: 'inject' }, 3], FLOW_WORDS.notObject(1)],
      [[{ id: 'a', type: 'inject' }, [{ type: 'inject' }]], FLOW_WORDS.notObject(1)],
      [[{ id: 'a' }], FLOW_WORDS.noType(0)],
      [[{ id: 'a', type: '' }], FLOW_WORDS.noType(0)],
      [[{ id: 'a', type: 7 }], FLOW_WORDS.noType(0)],
      // Node-RED keeps only the first node of an id: nodes without one, or with the same one, would be lost
      [[{ id: 'a', type: 'inject' }, { type: 'debug' }], FLOW_WORDS.noId(1)],
      [[{ id: '', type: 'debug' }], FLOW_WORDS.noId(0)],
      [[{ id: 5, type: 'debug' }], FLOW_WORDS.noId(0)],
      [[{ id: 'a', type: 'inject' }, { id: 'b', type: 'debug' }, { id: 'a', type: 'debug' }], FLOW_WORDS.sameId(2, 0)],
      // a global-config node merges into, and can replace, the person's global environment variables
      [[{ id: 'a', type: 'inject' }, { id: 'g', type: 'global-config', env: [{ name: 'KEY', value: 'x', type: 'str' }] }], FLOW_WORDS.globalConfig(1)],
      [Array.from({ length: MAX_PROPOSED_NODES + 1 }, (_, i) => ({ id: `x${i}`, type: 'debug' })), FLOW_WORDS.tooMany],
    ];
    for (const [nodes, words] of cases) {
      const answer = await call(client, 'ps_flow_propose', nodes === undefined ? {} : { nodes });
      assert.equal(answer.isError, true, JSON.stringify(nodes)?.slice(0, 80));
      assert.equal(answer.content[0].text, words);
      assert.match(words, /[぀-ヿ]/, 'in Japanese');
      assert.match(words, / \/ [A-Za-z]/, 'and English');
    }
    assert.match(FLOW_WORDS.sameId(2, 0), /nodes\[2\]/);
    assert.match(FLOW_WORDS.sameId(2, 0), /nodes\[0\]/);
    assert.deepEqual(editor.posted, [], 'no editor was asked');
    assert.deepEqual(editor.imports, []);
    // 2000 nodes are taken
    const most = await call(client, 'ps_flow_propose', { nodes: Array.from({ length: MAX_PROPOSED_NODES }, (_, i) => ({ id: `x${i}`, type: 'debug' })) });
    assert.equal(most.isError, undefined, most.content?.[0]?.text);
    assert.equal(json(most).imported, MAX_PROPOSED_NODES);
  } finally { await client.close(); closeEditors(); }
});

// --- What the agent is told when the editor does not do it: a small Node-RED, short times -----------

async function small(o: { timeoutMs: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-tools-flows-small-'));
  const settings = readSettings({ catalogBase: 'http://127.0.0.1:9', site: 'yard' }, { userDir: dir, env: {} });
  const red = fakeRed({ userDir: dir });
  const hub = createHub(red.RED, { userDir: dir, settings, clock: fakeClock(), pollMs: 0 });
  const link = createEditorLink(red.RED, { timeoutMs: o.timeoutMs, pingMs: 20 });
  mountMcp(red.RED, hub, { userDir: dir, link });
  const url = await red.listen();
  const open = (e: Parameters<typeof fakeEditor>[0] = {}) => {
    const editor = fakeEditor({
      post: async (_body, s) => (await fetch(`${url}/${s.url}`, { method: s.type, headers: { 'Content-Type': s.contentType, ...s.headers }, body: s.data })).json(),
      ...e,
    });
    const publish = red.RED.comms.publish;
    red.RED.comms.publish = (topic: string, data: unknown, retain: boolean) => { publish(topic, data, retain); editor.deliver(topic, data); };
    return editor;
  };
  const key = readFileSync(join(dir, 'physical-sandbox', 'mcp-key'), 'utf8').trim();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + MCP_ROUTE), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return {
    red, url, open, client,
    async close() { await client.close(); hub.close(); await red.close(); },
  };
}

test('no editor open: both tools say to open the Node-RED editor, in Japanese and English', async () => {
  const s = await small({ timeoutMs: 50 });
  try {
    for (const [name, args] of [['ps_flows_read', {}], ['ps_flow_propose', { nodes: [{ id: 'a', type: 'debug' }] }]] as const) {
      const answer = await call(s.client, name, args);
      assert.equal(answer.isError, true, name);
      assert.equal(answer.content[0].text, FLOW_WORDS.noEditor);
      assert.ok(FLOW_WORDS.noEditor.startsWith(LINK_WORDS.noEditor), 'the link\'s words, then English');
      assert.match(FLOW_WORDS.noEditor, /Open the Node-RED editor/);
    }
  } finally { await s.close(); }
});

test('an editor that took the proposal but never answered: the agent is told to check the editor before proposing again', async () => {
  const s = await small({ timeoutMs: 100 });
  try {
    // it claims and is granted, then its answer is lost (a tab closed in the middle, a broken network)
    const editor = s.open({
      post: async (body, st) => (body.claim
        ? (await fetch(`${s.url}/${st.url}`, { method: st.type, headers: { 'Content-Type': st.contentType, ...st.headers }, body: st.data })).json()
        : {}),
    });
    const answer = await call(s.client, 'ps_flow_propose', { nodes: [{ id: 'a', type: 'debug' }] });
    assert.equal(answer.isError, true);
    assert.equal(answer.content[0].text, LINK_WORDS.proposalUnanswered);
    assert.notEqual(answer.content[0].text, FLOW_WORDS.noEditor);
    assert.equal(editor.imports.length, 1, 'the editor did import it');
  } finally { await s.close(); }
});

test('an editor that could not import: its words; an answer without the list of types: no list', async () => {
  const s = await small({ timeoutMs: 500 });
  try {
    s.open({ importResult: () => undefined });
    const refused = await call(s.client, 'ps_flow_propose', { nodes: [{ id: 'a', type: 'debug' }] });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^エディタで提案を取り込めませんでした/);
    assert.match(refused.content[0].text, /The editor could not import the proposal/);
  } finally { await s.close(); }

  const t = await small({ timeoutMs: 500 });
  try {
    // an editor of another make: it answers {imported, tab} only
    const publish = t.red.RED.comms.publish;
    t.red.RED.comms.publish = (topic: string, data: any, retain: boolean) => {
      publish(topic, data, retain);
      if (topic !== 'ps-editor/request' || data.op !== 'propose') return;
      const answer = (body: unknown) => fetch(`${t.url}/physical-sandbox/editor/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      void answer({ id: data.id, claim: true }).then((claim: any) => answer({ id: data.id, ok: true, result: { imported: 1, tab: 'x' }, ticket: claim.ticket }));
    };
    const result = json(await call(t.client, 'ps_flow_propose', { nodes: [{ id: 'a', type: 'debug' }] }));
    assert.equal(result.imported, 1);
    assert.equal(result.tab, 'x');
    assert.equal('notInstalled' in result, false);
    assert.doesNotMatch(result.next, /インストール/);
  } finally { await t.close(); }
});
