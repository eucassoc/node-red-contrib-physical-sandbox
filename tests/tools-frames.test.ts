// Looking at the pane (src/plugin/tools/frames.ts): ps_pane_frames gives the agent the pane's
// picture only while the person's switch 「エージェントに映像を渡す」 is on. On a small Node-RED with
// Node-RED's own 5 MB JSON parser in front, an MCP client on the plugin's route, and a pane made of
// the pane's real answer (src/pane/comms-client.ts answerEditorRequest) posting to the real answer
// route, with a stage that makes test PNGs. The hub works out the states at each stream time
// (hub.statesAt) and the pane draws them on its own copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEditorLink, LINK_WORDS } from '../src/plugin/editor-link.js';
import { createHub } from '../src/plugin/hub.js';
import { mountMcp, MCP_ROUTE } from '../src/plugin/mcp.js';
import { registerRoutes } from '../src/plugin/routes.js';
import { readSettings } from '../src/plugin/settings.js';
import { FRAMES_WORDS } from '../src/plugin/tools/frames.js';
import { answerEditorRequest, createApi, FRAME_MAX_SIDE, FRAMES_MAX, PANE_FRAMES_OFF } from '../src/pane/comms-client.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';
import { pngOf, pngSize } from './helpers/png.js';

const SWITCH_OFF = '右ペインで「エージェントに映像を渡す」を入れてください';

async function small(o: { timeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-tools-frames-'));
  const settings = readSettings({ catalogBase: 'http://127.0.0.1:9', site: 'yard' }, { userDir: dir, env: {} });
  const red = fakeRed({ userDir: dir, adminJsonParser: true });
  const hub = createHub(red.RED, { userDir: dir, settings, clock: fakeClock(), pollMs: 0 });
  const link = createEditorLink(red.RED, { timeoutMs: o.timeoutMs ?? 2000, pingMs: 20 });
  registerRoutes(red.RED, hub, { paneDir: dir });
  mountMcp(red.RED, hub, { userDir: dir, link });
  const url = await red.listen();
  const key = readFileSync(join(dir, 'physical-sandbox', 'mcp-key'), 'utf8').trim();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + MCP_ROUTE), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  /** The frames requests the plugin published. */
  const framesAsked = () => red.published.filter((p) => p.topic === 'ps-editor/request' && p.data.op === 'frames');
  return { red, hub, url, client, framesAsked, async close() { await client.close(); hub.close(); await red.close(); } };
}

type Small = Awaited<ReturnType<typeof small>>;

/**
 * A pane: it hears the plugin's requests and answers them with the pane's own code, through the
 * answer route, as a browser does. Its stage makes a PNG of `size` for each frame and notes what
 * it was asked to draw.
 */
function openPane(s: Small, o: { allowed?: () => boolean; size?: [number, number]; noise?: boolean } = {}) {
  const api = createApi({ base: `${s.url}/`, token: () => null, fetchImpl: (u, i) => fetch(u, i) });
  const drawn: { states?: any[]; maxSide: number }[] = [];
  const answers: Promise<void>[] = [];
  const [width, height] = o.size ?? [640, 360];
  const source = {
    allowed: o.allowed ?? (() => true),
    async frame(f: { states?: any[]; maxSide: number }) {
      drawn.push(f);
      return new Blob([new Uint8Array(pngOf(width, height, { noise: o.noise }))], { type: 'image/png' });
    },
  };
  const publish = s.red.RED.comms.publish;
  s.red.RED.comms.publish = (topic: string, data: any, retain: boolean) => {
    publish(topic, data, retain);
    if (topic === 'ps-editor/request') {
      const answering = answerEditorRequest(api, data, 'page-1', source);
      if (answering) answers.push(answering);
    }
  };
  return { drawn, answers };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: args });
const refusal = (answer: any): string => {
  assert.equal(answer.isError, true, JSON.stringify(answer.content?.[0]));
  return answer.content[0].text;
};

const state = (id: string, at: number, joints: Record<string, number>) => ({ topic: `ps/yard/${id}/state`, payload: { at, joints } });

test('switch off: the tool tells the person to turn it on, and no frames request goes out', async () => {
  const s = await small();
  try {
    const pane = openPane(s);
    assert.equal(s.hub.status().agentFrames, false, 'off by default');
    for (const args of [{}, { times: [0, 1] }]) {
      const text = refusal(await call(s.client, 'ps_pane_frames', args));
      assert.ok(text.startsWith(SWITCH_OFF), text);
      assert.equal(text, FRAMES_WORDS.switchOff);
    }
    assert.equal(s.framesAsked().length, 0);
    assert.equal(pane.drawn.length, 0);
  } finally { await s.close(); }
});

test('the switch is not kept across a restart: a new hub on the same folder starts with it off', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    const again = createHub(s.red.RED, { userDir: s.hub.userDir, settings: s.hub.settings, clock: fakeClock(), pollMs: 0 });
    try { assert.equal(again.status().agentFrames, false); } finally { again.close(); }
  } finally { await s.close(); }
});

test('switch on but no pane open: the agent is told to open the editor (the link\'s words, then English)', async () => {
  const s = await small({ timeoutMs: 50 });
  try {
    s.hub.setAgentFrames(true);
    const text = refusal(await call(s.client, 'ps_pane_frames'));
    assert.equal(text, FRAMES_WORDS.noPane);
    assert.ok(text.startsWith(LINK_WORDS.noEditor), text);
    assert.equal(s.framesAsked().length, 1, 'the request went out and nobody answered');
  } finally { await s.close(); }
});

test('switch on with a pane: no times gives one frame of what the pane shows now, as an MCP PNG image', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    const pane = openPane(s);
    const answer = await call(s.client, 'ps_pane_frames');
    assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
    const [info, ...images] = answer.content;
    assert.equal(info.type, 'text');
    assert.deepEqual(JSON.parse(info.text).frames, [{ t: null, width: 640, height: 360 }]);
    assert.equal(images.length, 1);
    assert.equal(images[0].type, 'image');
    assert.equal(images[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(images[0].data, 'base64'), pngOf(640, 360));
    assert.deepEqual(pane.drawn, [{ maxSide: FRAME_MAX_SIDE }], 'drawn as it is, no states given');
    assert.deepEqual(s.framesAsked()[0].data.args, { frames: [{}] });
  } finally { await s.close(); }
});

test('at stream times: the hub sends each time\'s latest state per device (seconds from the stream\'s first state), the pane draws them; up to 6, longest side within 1280', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    const pane = openPane(s);
    const t0 = 1_700_000_000_000;
    s.hub.push(state('arm', t0, { j1: 0.1, j2: 0.5 }), 'mqtt');
    s.hub.push(state('cart', t0 + 500, { wheel: 1 }), 'mqtt');
    s.hub.push(state('arm', t0 + 1000, { j1: 0.2 }), 'mqtt'); // j2 stays as it was
    s.hub.push(state('arm', t0 + 3000, { j1: 0.3, j2: 0.7 }), 'mqtt');
    const times = [0, 0.4, 1, 2.5, 3, 99];
    const answer = await call(s.client, 'ps_pane_frames', { times });
    assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
    const info = JSON.parse(answer.content[0].text);
    assert.deepEqual(info.frames.map((f: any) => f.t), times);
    assert.equal(info.duration, 3);
    const images = answer.content.slice(1);
    assert.equal(images.length, FRAMES_MAX);
    for (const image of images) {
      assert.equal(image.mimeType, 'image/png');
      const { width, height } = pngSize(image.data);
      assert.ok(Math.max(width, height) <= FRAME_MAX_SIDE);
    }
    const joints = (f: any) => Object.fromEntries((f.states ?? []).map((m: any) => [m.topic.split('/')[2], m.payload.joints]));
    assert.deepEqual(pane.drawn.map(joints), [
      { arm: { j1: 0.1, j2: 0.5 } },
      { arm: { j1: 0.1, j2: 0.5 } },
      { arm: { j1: 0.2, j2: 0.5 }, cart: { wheel: 1 } },
      { arm: { j1: 0.2, j2: 0.5 }, cart: { wheel: 1 } },
      { arm: { j1: 0.3, j2: 0.7 }, cart: { wheel: 1 } },
      { arm: { j1: 0.3, j2: 0.7 }, cart: { wheel: 1 } },
    ]);
    assert.ok(pane.drawn.every((f) => f.maxSide === FRAME_MAX_SIDE));
  } finally { await s.close(); }
});

test('the states at a time come from the opened record and the live ones together, by their own at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-tools-frames-hub-'));
  const red = fakeRed({ userDir: dir });
  const hub = createHub(red.RED, { userDir: dir, settings: readSettings({ site: 'yard' }, { userDir: dir, env: {} }), clock: fakeClock(), pollMs: 0 });
  try {
    assert.equal(hub.statesAt([0]), null, 'an empty stream has no states');
    // the record's states are on its own time (from 0 ms)
    const record = {
      schemaVersion: 3,
      frame: { frameId: 'site', up: '+Y', unit: 'm' },
      markers: [],
      equipment: { site: { id: 'yard' }, devices: [{ id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }] },
      names: { arm: 'arm' },
      traces: [{ deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 0.5, joints: { j: 0.5 } }, { t: 1, position: [1, 0, 0] }] }],
      routes: [],
    };
    hub.open(record, { file: 'arm.record.json', record });
    // a live state of something else, between the record's, and a command (not a state)
    hub.push(state('cart', 700, { wheel: 2 }), 'mqtt');
    hub.push({ topic: 'ps/yard/arm/command', payload: { at: 600, go: true } }, 'mqtt');
    const at = hub.statesAt([1, 0, 0.6, 0.75]);
    assert.ok(at);
    assert.equal(at.duration, 1);
    const shown = (s: any[]) => Object.fromEntries(s.map((m) => [m.topic.split('/')[2], { joints: m.payload.joints, ...(m.payload.position ? { position: m.payload.position } : {}) }]));
    assert.deepEqual(at.states.map(shown), [
      { arm: { joints: { j: 0.5 }, position: [1, 0, 0] }, cart: { joints: { wheel: 2 } } }, // a mover's place and joints add up
      { arm: { joints: { j: 0 } } },
      { arm: { joints: { j: 0.5 } } },
      { arm: { joints: { j: 0.5 } }, cart: { joints: { wheel: 2 } } },
    ]);
  } finally { hub.close(); }
});

test('more than 6 times, or times that are not seconds, are refused in both languages and no request goes out', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    s.hub.push(state('arm', 1000, { j1: 0.1 }), 'mqtt');
    const pane = openPane(s);
    const tooMany = refusal(await call(s.client, 'ps_pane_frames', { times: [0, 1, 2, 3, 4, 5, 6] }));
    assert.equal(tooMany, FRAMES_WORDS.tooMany);
    assert.match(tooMany, /6 枚まで/);
    assert.match(tooMany, /At most 6/);
    for (const times of [[-1], ['1'], [Number.NaN], 'now']) {
      assert.equal(refusal(await call(s.client, 'ps_pane_frames', { times })), FRAMES_WORDS.badTimes);
    }
    assert.equal(s.framesAsked().length, 0);
    assert.equal(pane.drawn.length, 0);
  } finally { await s.close(); }
});

test('times on an empty stream are refused, saying to leave them out for what the pane shows now', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    openPane(s);
    assert.equal(refusal(await call(s.client, 'ps_pane_frames', { times: [1] })), FRAMES_WORDS.emptyStream);
    assert.equal(s.framesAsked().length, 0);
  } finally { await s.close(); }
});

test('turning the switch off mid-session refuses the next call, and no request goes out', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    const pane = openPane(s);
    assert.equal((await call(s.client, 'ps_pane_frames')).isError, undefined);
    assert.equal(s.framesAsked().length, 1);
    // the person turns it off in the pane
    const off = await fetch(`${s.url}/physical-sandbox/pane/agent-frames`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
    assert.equal(off.status, 200);
    assert.equal(refusal(await call(s.client, 'ps_pane_frames')), FRAMES_WORDS.switchOff);
    assert.equal(s.framesAsked().length, 1);
    assert.equal(pane.drawn.length, 1);
  } finally { await s.close(); }
});

test('the switch turned off while the pane draws: the pictures that came back are not given', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    const pane = openPane(s, { allowed: () => { s.hub.setAgentFrames(false); return true; } });
    assert.equal(refusal(await call(s.client, 'ps_pane_frames')), FRAMES_WORDS.switchOff);
    await Promise.all(pane.answers);
    assert.equal(pane.drawn.length, 1, 'the (stale) pane drew it, and the hub kept it back');
  } finally { await s.close(); }
});

test('a pane whose switch shows off refuses to draw, and the agent gets its words', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    const pane = openPane(s, { allowed: () => false });
    const text = refusal(await call(s.client, 'ps_pane_frames'));
    assert.ok(text.includes(PANE_FRAMES_OFF), text);
    assert.equal(pane.drawn.length, 0);
  } finally { await s.close(); }
});

test('a picture over 1280 px (or not a PNG) from a pane is not given to the agent', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    openPane(s, { size: [1920, 1080] });
    assert.equal(refusal(await call(s.client, 'ps_pane_frames')), FRAMES_WORDS.badAnswer);
  } finally { await s.close(); }
});

test('frames over Node-RED\'s 5 MB JSON limit still come back: the pane posts them as text', async () => {
  const s = await small({ timeoutMs: 5000 });
  try {
    s.hub.setAgentFrames(true);
    openPane(s, { size: [1280, 1280], noise: true });
    const answer = await call(s.client, 'ps_pane_frames');
    assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
    assert.ok(answer.content[1].data.length > 5 * 1024 * 1024, `${answer.content[1].data.length}`);
    assert.deepEqual(pngSize(answer.content[1].data), { width: 1280, height: 1280 });
  } finally { await s.close(); }
});

test('the agent sees ps_pane_frames with times (at most 6, seconds) in its schema and the switch in its description', async () => {
  const s = await small();
  try {
    const { tools } = await s.client.listTools();
    const tool: any = tools.find((t) => t.name === 'ps_pane_frames');
    assert.ok(tool, tools.map((t) => t.name).join());
    assert.equal(tool.inputSchema.properties.times.type, 'array');
    assert.equal(tool.inputSchema.properties.times.maxItems, FRAMES_MAX);
    assert.equal(tool.inputSchema.properties.times.items.type, 'number');
    assert.match(tool.description, /エージェントに映像を渡す/);
    assert.match(tool.description, /never sent to PS\.com/);
  } finally { await s.close(); }
});
