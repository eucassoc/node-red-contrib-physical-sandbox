// Looking at the pane (src/plugin/tools/frames.ts): ps_pane_frames gives the agent the pane's
// picture only while the person's switch 「エージェントに映像を渡す」 is on. On a small Node-RED with
// Node-RED's own 5 MB JSON parser in front, an MCP client on the plugin's route, and panes made of
// the pane's real answers (src/pane/comms-client.ts createPaneAnswers) posting to the real answer
// route, with a stage that makes test pictures. The hub works out what the stream, saved now as a
// record, replays at each time (hub.statesAt) and the pane draws it on its own copy.
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
import { createApi, createPaneAnswers, PANE_FRAMES_OFF, PANE_FRAMES_TOO_LARGE } from '../src/pane/comms-client.js';
import { FRAME_MAX_BYTES, FRAME_MAX_SIDE, FRAMES_MAX, frameBudget } from '../src/core/frames.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';
import { jpegOf, pngOf, pngSize } from './helpers/png.js';

const SWITCH_OFF = '右ペインで「エージェントに映像を渡す」を入れてください';

async function small(o: { framesTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-tools-frames-'));
  const settings = readSettings({ catalogBase: 'http://127.0.0.1:9', site: 'yard' }, { userDir: dir, env: {} });
  const red = fakeRed({ userDir: dir, adminJsonParser: true });
  const clock = fakeClock();
  const hub = createHub(red.RED, { userDir: dir, settings, clock, pollMs: 0 });
  // a refusal waits for a pane that gives the frames until the time is up: short here
  const link = createEditorLink(red.RED, { framesTimeoutMs: o.framesTimeoutMs ?? 400, pingMs: 20 });
  registerRoutes(red.RED, hub, { paneDir: dir });
  mountMcp(red.RED, hub, { userDir: dir, link });
  const url = await red.listen();
  const key = readFileSync(join(dir, 'physical-sandbox', 'mcp-key'), 'utf8').trim();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + MCP_ROUTE), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  /** The frames requests the plugin published. */
  const framesAsked = () => red.published.filter((p) => p.topic === 'ps-editor/request' && p.data.op === 'frames');
  return { red, hub, clock, url, client, framesAsked, async close() { await client.close(); hub.close(); await red.close(); } };
}

type Small = Awaited<ReturnType<typeof small>>;

/** Devices on the scene, each answering to its own id. */
function onScene(s: Small, ids: string[]): void {
  s.hub.setScene({
    devices: ids.map((id) => ({ id, product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } })),
    names: Object.fromEntries(ids.map((id) => [id, id])),
  });
}

/**
 * A pane: it hears the plugin's requests (and cancels) and answers them with the pane's own code,
 * through the answer route, as a browser does. Its stage draws each frame at `size` and encodes it
 * as a test PNG (or `png` bytes) and as a JPEG frame of that size (or `jpeg` bytes), noting what
 * it was asked to draw.
 */
function openPane(s: Small, o: { allowed?: () => boolean; size?: [number, number]; png?: Buffer; jpeg?: Buffer } = {}) {
  const api = createApi({ base: `${s.url}/`, token: () => null, fetchImpl: (u, i) => fetch(u, i) });
  const drawn: { states?: any[]; maxSide: number }[] = [];
  const answering: Promise<void>[] = [];
  const [width, height] = o.size ?? [640, 360];
  const answers = createPaneAnswers(api, 'page-1', {
    allowed: o.allowed ?? (() => true),
    picture(f) {
      drawn.push(f);
      return {
        width,
        height,
        async encode(type) {
          const bytes = type === 'image/png' ? (o.png ?? pngOf(width, height)) : (o.jpeg ?? jpegOf(width, height));
          return new Blob([new Uint8Array(bytes)], { type });
        },
      };
    },
  });
  const publish = s.red.RED.comms.publish;
  s.red.RED.comms.publish = (topic: string, data: any, retain: boolean) => {
    publish(topic, data, retain);
    if (topic === 'ps-editor/request') {
      const answer = answers.request(data);
      if (answer) answering.push(answer);
    } else if (topic === 'ps-editor/cancel') {
      answers.cancel(data.id);
    }
  };
  return { drawn, answering };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: args });
const refusal = (answer: any): string => {
  assert.equal(answer.isError, true, JSON.stringify(answer.content?.[0]));
  return answer.content[0].text;
};
const given = (answer: any): any => {
  assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
  return answer;
};

const state = (id: string, at: number, joints: Record<string, number>) => ({ topic: `ps/yard/${id}/state`, payload: { at, joints } });
/** What each frame was asked to show, by outside name: the joints and, when given, the place. */
const shown = (states: any[] = []) => Object.fromEntries(states.map((m) => [m.topic.split('/')[2], {
  ...(m.payload.joints ? { joints: m.payload.joints } : {}),
  ...(m.payload.position ? { position: m.payload.position } : {}),
  ...(m.payload.xyz ? { xyz: m.payload.xyz } : {}),
}]));

/** A record of an arm and a box (an item), both moving over 1 s. */
const twoDevices = {
  schemaVersion: 3,
  frame: { frameId: 'site', up: '+Y', unit: 'm' },
  markers: [],
  equipment: {
    site: { id: 'yard' },
    devices: [
      { id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } },
      { id: 'box', product: 'physical-sandbox/crate:1', owner: 'viewer', parent: 'site', type: 'item', shape: { sizeM: [0.2, 0.2, 0.2] }, pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } },
    ],
  },
  names: { arm: 'arm', box: 'box' },
  traces: [
    { deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 0.5, joints: { j: 0.5 } }, { t: 1, position: [1, 0, 0] }] },
    { deviceId: 'box', samples: [{ t: 0, position: [1, 0, 0] }, { t: 1, position: [2, 0, 0] }] },
  ],
  routes: [],
};

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
  const s = await small({ framesTimeoutMs: 50 });
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
    const [info, ...images] = given(await call(s.client, 'ps_pane_frames')).content;
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

test('at stream times: the hub sends what the saved record replays at each (each device from its own first state), the pane draws them; up to 6, longest side within 1280', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    onScene(s, ['arm', 'cart']);
    const pane = openPane(s);
    const t0 = 1_700_000_000_000;
    s.hub.push(state('arm', t0, { j1: 0.1, j2: 0.5 }), 'mqtt');
    s.hub.push(state('cart', t0 + 500, { wheel: 1 }), 'mqtt'); // the cart's own first state: t = 0
    s.hub.push(state('arm', t0 + 1000, { j1: 0.2 }), 'mqtt'); // j2 stays as it was
    s.hub.push(state('arm', t0 + 3000, { j1: 0.3, j2: 0.7 }), 'mqtt');
    s.hub.push(state('stranger', t0 + 200, { x: 1 }), 'mqtt'); // no device answers to it: a save leaves it out
    const times = [0, 0.4, 1, 2.5, 3, 99];
    const answer = given(await call(s.client, 'ps_pane_frames', { times }));
    const info = JSON.parse(answer.content[0].text);
    assert.deepEqual(info.frames.map((f: any) => f.t), times);
    assert.equal(info.duration, 3, 'the longest trace');
    const images = answer.content.slice(1);
    assert.equal(images.length, FRAMES_MAX);
    for (const image of images) {
      assert.equal(image.mimeType, 'image/png');
      const { width, height } = pngSize(image.data);
      assert.ok(Math.max(width, height) <= FRAME_MAX_SIDE);
    }
    const cart = { joints: { wheel: 1 } };
    assert.deepEqual(pane.drawn.map((f) => shown(f.states)), [
      { arm: { joints: { j1: 0.1, j2: 0.5 } }, cart },
      { arm: { joints: { j1: 0.1, j2: 0.5 } }, cart },
      { arm: { joints: { j1: 0.2, j2: 0.5 } }, cart },
      { arm: { joints: { j1: 0.2, j2: 0.5 } }, cart },
      { arm: { joints: { j1: 0.3, j2: 0.7 } }, cart },
      { arm: { joints: { j1: 0.3, j2: 0.7 } }, cart },
    ]);
    assert.ok(pane.drawn.every((f) => f.maxSide === FRAME_MAX_SIDE));
  } finally { await s.close(); }
});

test('the states at a time are the save\'s: the opened record on its time, a live device from its own first state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-tools-frames-hub-'));
  const red = fakeRed({ userDir: dir });
  const hub = createHub(red.RED, { userDir: dir, settings: readSettings({ site: 'yard' }, { userDir: dir, env: {} }), clock: fakeClock(), pollMs: 0 });
  try {
    assert.equal(hub.statesAt([0]), null, 'an empty stream has no states');
    hub.open(twoDevices, { file: 'two.record.json', record: twoDevices });
    // the box moves live now (epoch ms): its loaded states give way, and it counts from its own first
    const now = 1_700_000_000_000;
    hub.push({ topic: 'ps/yard/box/state', payload: { at: now, type: 'item', parent: 'site', xyz: [5, 0, 0] } }, 'mqtt');
    hub.push({ topic: 'ps/yard/box/state', payload: { at: now + 2000, type: 'item', parent: 'site', xyz: [6, 0, 0] } }, 'mqtt');
    hub.push({ topic: 'ps/yard/arm/command', payload: { at: now + 100, go: true } }, 'mqtt');
    const at = hub.statesAt([1, 0, 0.6, 2]);
    assert.ok(at);
    assert.equal(at.duration, 2);
    assert.deepEqual(at.states.map(shown), [
      { arm: { joints: { j: 0.5 }, position: [1, 0, 0] }, box: { xyz: [5, 0, 0] } }, // a mover's place and joints add up
      { arm: { joints: { j: 0 } }, box: { xyz: [5, 0, 0] } },
      { arm: { joints: { j: 0.5 } }, box: { xyz: [5, 0, 0] } },
      { arm: { joints: { j: 0.5 }, position: [1, 0, 0] }, box: { xyz: [6, 0, 0] } },
    ]);
  } finally { hub.close(); }
});

test('an opened two-device record with one device played by the agent: frames at 0 and 1 show both moving', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    s.hub.open(twoDevices, { file: 'two.record.json', record: twoDevices });
    const pane = openPane(s);
    given(await call(s.client, 'ps_stream_play', { messages: [state('arm', 0, { j: -1 }), state('arm', 1000, { j: -2 })] }));
    s.clock.advance(1000); // the agent's play runs to its end
    given(await call(s.client, 'ps_pane_frames', { times: [0, 1] }));
    assert.deepEqual(pane.drawn.map((f) => shown(f.states)), [
      { arm: { joints: { j: -1 } }, box: { xyz: [1, 0, 0] } },
      { arm: { joints: { j: -2 } }, box: { xyz: [2, 0, 0] } },
    ]);
  } finally { await s.close(); }
});

test('more than 6 times, or times that are not seconds, are refused in both languages and no request goes out', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    onScene(s, ['arm']);
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
    given(await call(s.client, 'ps_pane_frames'));
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
    await Promise.all(pane.answering);
    assert.equal(pane.drawn.length, 1, 'the (stale) pane drew it, and the hub kept it back');
  } finally { await s.close(); }
});

test('a pane whose switch shows off refuses to draw; with no other pane the agent gets its words when the time is up', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    const pane = openPane(s, { allowed: () => false });
    const text = refusal(await call(s.client, 'ps_pane_frames'));
    assert.equal(text, PANE_FRAMES_OFF);
    assert.equal(pane.drawn.length, 0);
  } finally { await s.close(); }
});

test('two panes, one refusing (its switch shows off) and one giving the frames: the frames are taken, and the other is told to stop', async () => {
  for (const order of ['refusing first', 'giving first']) {
    const s = await small({ framesTimeoutMs: 5000 });
    try {
      s.hub.setAgentFrames(true);
      const panes = order === 'refusing first' ? [openPane(s, { allowed: () => false }), openPane(s)] : [openPane(s), openPane(s, { allowed: () => false })];
      const started = Date.now();
      const answer = given(await call(s.client, 'ps_pane_frames'));
      assert.equal(answer.content[1].mimeType, 'image/png', order);
      assert.ok(Date.now() - started < 4000, `${order}: not held until the time was up`);
      assert.ok(s.red.published.some((p) => p.topic === 'ps-editor/cancel' && p.data.id === s.framesAsked()[0].data.id), order);
      await Promise.all(panes.flatMap((p) => p.answering));
    } finally { await s.close(); }
  }
});

test('a picture over 1280 px (or not a PNG) from a pane is not given to the agent', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    openPane(s, { size: [1920, 1080] });
    assert.equal(refusal(await call(s.client, 'ps_pane_frames')), FRAMES_WORDS.badAnswer);
  } finally { await s.close(); }
});

test('a frame too large even as JPEG is refused in the person\'s words', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    const big = Buffer.concat([pngOf(16, 9), Buffer.alloc(FRAME_MAX_BYTES)]);
    openPane(s, { png: big, jpeg: Buffer.concat([jpegOf(640, 360), Buffer.alloc(FRAME_MAX_BYTES)]) });
    const text = refusal(await call(s.client, 'ps_pane_frames'));
    assert.equal(text, PANE_FRAMES_TOO_LARGE);
    assert.match(text, /^映像が大きすぎて渡せませんでした \/ The frames were too large to hand over/);
  } finally { await s.close(); }
});

test('a PNG over its share goes as JPEG and is handed over as image/jpeg with its size; two of them pass Node-RED\'s 5 MB JSON limit as text', async () => {
  const s = await small({ framesTimeoutMs: 5000 });
  try {
    s.hub.setAgentFrames(true);
    onScene(s, ['arm']);
    s.hub.push(state('arm', 1000, { j1: 0.1 }), 'mqtt');
    const budget = frameBudget(2);
    const jpeg = jpegOf(1280, 720, budget - 1000);
    openPane(s, { size: [1280, 720], png: Buffer.concat([pngOf(16, 9), Buffer.alloc(budget)]), jpeg });
    const answer = given(await call(s.client, 'ps_pane_frames', { times: [0, 1] }));
    assert.deepEqual(JSON.parse(answer.content[0].text).frames, [{ t: 0, width: 1280, height: 720 }, { t: 1, width: 1280, height: 720 }]);
    for (const image of answer.content.slice(1)) {
      assert.equal(image.mimeType, 'image/jpeg');
      assert.deepEqual(Buffer.from(image.data, 'base64'), jpeg);
    }
    assert.ok(answer.content[1].data.length + answer.content[2].data.length > 5 * 1024 * 1024);
  } finally { await s.close(); }
});

test('a frame over its share of the bytes, or a JPEG over 1280 px, from a pane of another make is not given', async () => {
  const s = await small();
  try {
    s.hub.setAgentFrames(true);
    // it answers on its own, as text
    const publish = s.red.RED.comms.publish;
    let frame: any = null;
    s.red.RED.comms.publish = (topic: string, data: any, retain: boolean) => {
      publish(topic, data, retain);
      if (topic !== 'ps-editor/request' || data.op !== 'frames') return;
      void fetch(`${s.url}/physical-sandbox/editor/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8', 'X-PS-Pane': '1' },
        body: JSON.stringify({ id: data.id, ok: true, result: { frames: [frame] } }),
      });
    };
    frame = { data: Buffer.concat([pngOf(16, 9), Buffer.alloc(FRAME_MAX_BYTES)]).toString('base64'), type: 'image/png', width: 16, height: 9 };
    assert.equal(refusal(await call(s.client, 'ps_pane_frames')), FRAMES_WORDS.badAnswer);
    frame = { data: jpegOf(1920, 1080).toString('base64'), type: 'image/jpeg', width: 640, height: 360 };
    assert.equal(refusal(await call(s.client, 'ps_pane_frames')), FRAMES_WORDS.badAnswer, 'the size in the JPEG, not the one said');
    frame = { data: jpegOf(640, 360).toString('base64'), type: 'image/gif', width: 640, height: 360 };
    assert.equal(refusal(await call(s.client, 'ps_pane_frames')), FRAMES_WORDS.badAnswer);
    frame = { data: jpegOf(640, 360).toString('base64'), type: 'image/jpeg', width: 640, height: 360 };
    assert.equal(given(await call(s.client, 'ps_pane_frames')).content[1].mimeType, 'image/jpeg');
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
    assert.match(tool.description, /narrow pane gives a blurrier robot/);
    assert.match(tool.inputSchema.properties.times.description, /own first state, as a saved record keeps it/);
  } finally { await s.close(); }
});
