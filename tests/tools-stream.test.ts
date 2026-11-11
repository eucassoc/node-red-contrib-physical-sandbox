// The scene, stream and record tools (src/plugin/tools/stream.ts): the agent places robots, plays
// a stream in the pane, turns it into a record for a `ps play` node and saves it, by the pane's own
// rules (src/plugin/actions.ts), through an MCP client on the plugin's route of a small Node-RED.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHub } from '../src/plugin/hub.js';
import { mountMcp, MCP_ROUTE } from '../src/plugin/mcp.js';
import { WORDS } from '../src/plugin/actions.js';
import { readSettings } from '../src/plugin/settings.js';
import { OFFLINE, SIGN_IN } from '../src/core/unsent.js';
import { applyState, newStore } from '../src/pscom/state.js';
import { dispatch } from '../src/pane/comms-client.js';
import psPlayNode from '../src/nodes/ps-play.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';
import { FakePsCom } from './helpers/fake-pscom.js';

const require = createRequire(import.meta.url);
const helper = require('node-red-node-test-helper');
before(() => helper.init(require.resolve('node-red')));
after(async () => { await helper.unload(); });

const UNREACHABLE = 'http://127.0.0.1:9';
const so101 = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'so101-bundle.json'), 'utf8'));

/** A psbx cache holding so101. */
function cache(): string {
  const root = mkdtempSync(join(tmpdir(), 'ps-tools-stream-cache-'));
  const dir = join(root, 'catalog', 'physical-sandbox', 'so101', '1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(so101));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ kind: 'machine', display: { ja: 'SO-101' } }));
  writeFileSync(join(root, 'catalog', 'physical-sandbox', 'so101', 'latest'), '1');
  return root;
}

async function small(o: { catalogBase?: string; adminJsonParser?: boolean; fetchImpl?: (url: string, init?: any) => Promise<any> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-tools-stream-'));
  const settings = readSettings({ catalogBase: o.catalogBase ?? UNREACHABLE }, { userDir: dir, env: {} });
  const red = fakeRed({ userDir: dir, adminJsonParser: o.adminJsonParser });
  const clock = fakeClock();
  const hub = createHub(red.RED, { userDir: dir, settings, clock, pollMs: 0 });
  mountMcp(red.RED, hub, { userDir: dir, cacheRoot: cache(), fetchImpl: o.fetchImpl });
  const url = await red.listen();
  const key = readFileSync(join(dir, 'physical-sandbox', 'mcp-key'), 'utf8').trim();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + MCP_ROUTE), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return { red, hub, clock, client, async close() { await client.close(); hub.close(); await red.close(); } };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: args });
const json = (answer: any) => {
  assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
  return JSON.parse(answer.content[0].text);
};
const refusal = (answer: any): string => {
  assert.equal(answer.isError, true, answer.content?.[0]?.text);
  return answer.content[0].text;
};

/** What a pane holds: the hub's state messages applied to a store as the pane's stage applies them. */
function paneView(red: ReturnType<typeof fakeRed>) {
  const pane = red.pane();
  const store = newStore();
  let seen = 0;
  return {
    store,
    /** Take in what the pane has been sent since the last time. */
    update() {
      for (; seen < pane.received.length; seen += 1) {
        const { topic, data } = pane.received[seen];
        dispatch(topic, data, {
          scene: () => {}, snapshot: () => {}, status: () => {},
          state: (m) => { if (String(m.topic).endsWith('/state')) applyState(store, { id: m.topic, type: 'mover' }, m.payload); },
        });
      }
    },
    joints: (id: string) => (store.get(`ps/local/${id}/state`) as any)?.joints,
  };
}

/** Two arms waving for a second, 30 states a second each: `at` from 0 in steps of 33 ms. */
const angle = (k: number, phase: number) => Math.round(Math.sin(k / 5 + phase) * 1000) / 1000;
const wave = (ids = ['so101-1', 'so101-2']) => Array.from({ length: 31 }, (_, k) => ids.map((id, i) => ({
  topic: `ps/local/${id}/state`,
  payload: { at: k * 33, joints: { shoulder_pan: angle(k, i), elbow_flex: angle(k, i + 1) } },
}))).flat();

const STREAM_TOOLS = ['ps_scene_get', 'ps_scene_place', 'ps_scene_remove', 'ps_stream_play', 'ps_stream_stop', 'ps_stream_clear', 'ps_record_open', 'ps_record_save', 'ps_record_inline'];

/** The record a save kept on this machine (signed out) under `name`. */
const keptCopy = (hub: { dirs: { unsent: string } }, name: string): any => JSON.parse(readFileSync(join(hub.dirs.unsent, `${name}.record.json`), 'utf8'));

test('the agent sees the scene, stream and record tools; ps_stream_play says what a message is and that at counts from the first one', async () => {
  const s = await small();
  try {
    const { tools } = await s.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of STREAM_TOOLS) assert.ok(byName[name], name);
    const play = byName.ps_stream_play.description ?? '';
    assert.match(play, /ps\/<site>\/<id>\/state/);
    assert.match(play, /first/);
    assert.match(play, /same first at/, 'every device a state at the same first at');
    assert.match(play, /takes the place of/);
    assert.match(byName.ps_record_inline.description ?? '', /same first at/);
    assert.match(byName.ps_record_save.description ?? '', /last ps_stream_play/);
    assert.deepEqual((byName.ps_stream_play.inputSchema as any).required, ['messages']);
    assert.deepEqual((byName.ps_record_save.inputSchema as any).required, ['mode']);
  } finally { await s.close(); }
});

test('ps_scene_place then ps_stream_play: a two-arm wave moves the pane in time and the stream buffer collects it', async () => {
  const s = await small();
  try {
    const a = json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    const b = json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0.5, 0], yaw: Math.PI }));
    assert.deepEqual([a.device.id, b.device.id], ['so101-1', 'so101-2']);
    assert.deepEqual(b.device.pose, { xyz: [0.5, 0, 0], rpy: [0, 0, Math.PI] });
    assert.deepEqual(json(await call(s.client, 'ps_scene_get')).devices.map((d: any) => d.id), ['so101-1', 'so101-2']);

    const pane = paneView(s.red);
    const start = s.clock.now();
    const played = json(await call(s.client, 'ps_stream_play', { messages: wave() }));
    assert.deepEqual([played.count, played.duration, played.invalid, played.otherSite, played.unknownNames], [62, 0.99, [], [], []]);
    assert.equal(played.status.playing.source, 'agent');
    pane.update();
    assert.deepEqual(pane.joints('so101-1'), { shoulder_pan: angle(0, 0), elbow_flex: angle(0, 1) });
    s.clock.advance(330);
    pane.update();
    assert.deepEqual(pane.joints('so101-1'), { shoulder_pan: angle(10, 0), elbow_flex: angle(10, 1) });
    assert.deepEqual(pane.joints('so101-2'), { shoulder_pan: angle(10, 1), elbow_flex: angle(10, 2) });
    s.clock.advance(1000);
    pane.update();
    assert.deepEqual(pane.joints('so101-2'), { shoulder_pan: angle(30, 1), elbow_flex: angle(30, 2) });
    assert.equal(s.hub.status().playing, null, 'played to the end');

    const buffer = s.hub.streamBuffer();
    assert.equal(buffer.length, 62);
    assert.deepEqual(buffer.slice(0, 2).map((m) => [m.topic, m.at - start]), [['ps/local/so101-1/state', 0], ['ps/local/so101-2/state', 0]]);
    assert.equal(buffer.at(-1)!.at - start, 990);
  } finally { await s.close(); }
});

test('ps_stream_play: bad messages are answered by index with the reason, another site\'s are skipped, and the rest still play', async () => {
  const s = await small();
  try {
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    const messages: unknown[] = wave(['so101-1']);
    messages.splice(3, 0, { topic: 'ps/local/so101-1/state', payload: { joints: { shoulder_pan: 1 } } });
    messages.splice(5, 0, { topic: 'ps/yard/so101-1/state', payload: { at: 99, joints: { shoulder_pan: 1 } } });
    messages.push(42, { topic: 'ps/local/ghost/state', payload: { at: 0, joints: { j: 1 } } });
    const played = json(await call(s.client, 'ps_stream_play', { messages, loop: true }));
    assert.deepEqual(played.invalid.map((p: any) => p.index), [3, 33]);
    assert.match(played.invalid[0].reason, /at/);
    assert.deepEqual(played.otherSite, [{ index: 5, site: 'yard' }]);
    assert.deepEqual(played.unknownNames, ['ghost']);
    assert.equal(played.count, 32);
    assert.ok(played.next, 'the agent is told what was left out');
    s.clock.advance(3000);
    assert.equal(s.hub.streamBuffer().length, 32, 'a loop keeps the states once');
    assert.equal(json(await call(s.client, 'ps_stream_stop')).status.playing, null);

    // nothing playable: an error, and nothing stops
    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-1']), loop: true }));
    const text = refusal(await call(s.client, 'ps_stream_play', { messages: [{ topic: 'x' }] }));
    assert.match(text, /再生できるメッセージがありません/);
    assert.match(text, /nothing to play/i);
    assert.match(text, /messages\[0\]/);
    assert.equal(s.hub.status().playing?.source, 'agent');
  } finally { await s.close(); }
});

test('ps_record_inline: the record, pasted into a ps play node, plays the same states as ps_stream_play', async () => {
  const s = await small();
  try {
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0.5, 0] }));
    const messages = [
      ...wave(), { topic: 'ps/local/ghost/state', payload: { at: 0, joints: { j: 1 } } },
      { topic: 'ps/yard/so101-1/state', payload: { at: 0, joints: { j: 1 } } }, { topic: 'ps/yard/so101-2/state', payload: { at: 0, joints: { j: 1 } } },
    ];
    const inline = json(await call(s.client, 'ps_record_inline', { messages }));
    assert.deepEqual(inline.unknownNames, ['ghost'], 'the names no device answers to');
    assert.deepEqual(inline.otherSite, { sites: ['yard'], count: 2 });
    assert.equal(inline.skipped, undefined, 'one name for one meaning');
    assert.deepEqual(inline.invalid, []);
    assert.equal(inline.record.schemaVersion, 3);
    assert.deepEqual(inline.record.traces.map((t: any) => [t.deviceId, t.samples.length]), [['so101-1', 31], ['so101-2', 31]]);
    assert.equal(s.hub.streamBuffer().length, 0, 'nothing was played or kept');

    // what the agent's play sends to the panes, by the time from its start
    const heard = (from: string) => s.red.published
      .filter((p) => p.topic === 'ps-pane/state' && p.data.from === from)
      .map((p) => ({ topic: p.data.topic, payload: p.data.payload }));
    const relative = (list: { topic: string; payload: any }[]) => {
      const first = list[0]?.payload.at;
      return list.map(({ topic, payload }) => ({ topic, payload: { ...payload, at: payload.at - first } }));
    };
    json(await call(s.client, 'ps_stream_play', { messages: wave() }));
    s.clock.advance(2000);
    const fromAgent = relative(heard('agent'));
    assert.equal(fromAgent.length, 62);

    // a ps play node with the record as its inline source
    const withHub = (red: any) => { red.plugins.get = (id: string) => (id === 'physical-sandbox' ? { type: 'physical-sandbox', hub: s.hub } : undefined); return psPlayNode(red); };
    await helper.load([withHub], [{ id: 'play', type: 'ps play', name: '', source: 'inline', record: JSON.stringify(inline.record), ref: '', loop: false, speed: 1, wires: [[]] }]);
    helper.getNode('play').receive({ payload: 'start' });
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
    s.clock.advance(2000);
    const fromNode = relative(heard('record'));
    await helper.unload();
    assert.deepEqual(fromNode, fromAgent);
  } finally { await s.close(); }
});

test('ps_record_save and ps_record_open follow the pane\'s rules: kept unsent signed out, new, over, and the refusals in Japanese and English', { timeout: 20_000 }, async () => {
  const fake = await new FakePsCom().start();
  const s = await small({ catalogBase: fake.base });
  try {
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-1']) }));
    s.clock.advance(2000);

    // signed out: kept on this machine as unsent
    let saved = json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'wave', title: '手を振る' }));
    assert.deepEqual([saved.saved, saved.unsent, saved.reason], [false, 'wave', SIGN_IN]);
    assert.match(saved.next, /unsent/);
    assert.deepEqual(s.hub.status().unsent, [{ name: 'wave', ref: 'wave', mode: 'new' }]);

    // signed in, the kept copy goes
    await s.hub.client.loginStart();
    assert.equal(await s.hub.client.loginPoll(), 'approved');
    assert.deepEqual((await s.hub.sendUnsent()).sent.map((c) => c.ref), ['ada/wave']);
    assert.equal(fake.record('ada', 'wave', '1').name, '手を振る');
    assert.equal(fake.record('ada', 'wave', '1').traces[0].samples.length, 31);

    // saving over with nothing of the person's open is refused
    assert.match(refusal(await call(s.client, 'ps_record_save', { mode: 'over' })), new RegExp(`${WORDS.notOwn} / .+`));

    // opened from PS.com (and played), changed by the agent, saved over as the next version
    const opened = json(await call(s.client, 'ps_record_open', { ref: 'ada/wave' }));
    assert.equal(opened.source, 'ada/wave:1');
    assert.deepEqual(opened.status.opened, { ref: 'ada/wave', version: '1', own: true });
    assert.equal(opened.status.playing.source, 'ada/wave:1');
    s.clock.advance(2000);
    json(await call(s.client, 'ps_stream_play', { messages: [{ topic: 'ps/local/so101-1/state', payload: { at: 0, joints: { shoulder_pan: 1.5 } } }] }));
    saved = json(await call(s.client, 'ps_record_save', { mode: 'over' }));
    assert.deepEqual([saved.saved, saved.ref, saved.version, saved.mode], [true, 'ada/wave', '2', 'over']);
    assert.deepEqual(fake.record('ada', 'wave', '2').traces[0].samples, [{ t: 0, joints: { shoulder_pan: 1.5 } }]);

    // refusals: a bad name, a name that is there, a record that is not, a save under way
    assert.match(refusal(await call(s.client, 'ps_record_save', { mode: 'new', name: 'Bad Name' })), new RegExp(`^${WORDS.badName} / .*lowercase`));
    assert.match(refusal(await call(s.client, 'ps_record_save', { mode: 'new', name: 'wave' })), /はもうあります.* \/ .*exists/);
    assert.match(refusal(await call(s.client, 'ps_record_open', { ref: 'ada/nothing' })), /記録が見つかりませんでした（ada\/nothing） \/ .*not found/);
    let release!: () => void;
    fake.holdPuts = new Promise<void>((done) => { release = done; });
    const first = call(s.client, 'ps_record_save', { mode: 'new', name: 'wave-two' });
    for (let i = 0; i < 200 && fake.putsWaiting === 0; i += 1) await new Promise((done) => setTimeout(done, 10));
    assert.match(refusal(await call(s.client, 'ps_record_save', { mode: 'new', name: 'wave-three' })), new RegExp(`^${WORDS.busy} / .*under way`));
    fake.holdPuts = null;
    release();
    assert.equal(json(await first).ref, 'ada/wave-two');

    // signed in but PS.com out of reach: kept on this machine too
    await fake.stop();
    saved = json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'away' }));
    assert.deepEqual([saved.saved, saved.unsent, saved.reason], [false, 'away', OFFLINE]);
    assert.match(saved.next, /unsent/);
    assert.equal(s.hub.status().login.signedIn, true, 'offline, not signed out');
    assert.deepEqual(s.hub.status().unsent.map((c) => c.name), ['away']);
    assert.ok(keptCopy(s.hub, 'away').traces.length > 0);
  } finally { await s.close(); await fake.stop(); }
});

test('ps_scene_place and ps_scene_remove refuse as the pane does, in Japanese and English; placing an id again moves it; remove takes it away', async () => {
  const s = await small();
  try {
    assert.match(refusal(await call(s.client, 'ps_scene_place', { product: 'nobody/nothing:1', xyz: [0, 0] })), new RegExp(`^${WORDS.noProduct} / .*ps_machines_list`));
    json(await call(s.client, 'ps_scene_place', { id: 'left', product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    const moved = json(await call(s.client, 'ps_scene_place', { id: 'left', product: 'physical-sandbox/so101:1', xyz: [1, 2], yaw: 0.5 }));
    assert.deepEqual(moved.device.pose, { xyz: [1, 2, 0], rpy: [0, 0, 0.5] });
    assert.match(refusal(await call(s.client, 'ps_scene_remove', { id: 'right' })), new RegExp(`^${WORDS.noDevice} / `));
    assert.deepEqual(json(await call(s.client, 'ps_scene_remove', { id: 'left' })).removed, 'left');
    const scene = json(await call(s.client, 'ps_scene_get'));
    assert.deepEqual([scene.devices, scene.names, scene.site], [[], {}, 'local']);
  } finally { await s.close(); }
});

test('a 60 s stream of 30 states a second with 16 joints goes in one call; a 6 MB call is refused 413, naming Node-RED\'s limit in Japanese and English', { timeout: 30_000 }, async () => {
  const s = await small({ adminJsonParser: true });
  try {
    const joints = (k: number) => Object.fromEntries(Array.from({ length: 16 }, (_, j) => [`joint_${j + 1}`, angle(k, j)]));
    const messages = Array.from({ length: 1800 }, (_, k) => ({ topic: 'ps/local/openarm-1/state', payload: { at: Math.round(k * 1000 / 30), joints: joints(k) } }));
    assert.ok(JSON.stringify(messages).length < 5 * 1024 * 1024);
    const played = json(await call(s.client, 'ps_stream_play', { messages }));
    assert.deepEqual([played.count, played.duration], [1800, 59.967]);
    json(await call(s.client, 'ps_stream_stop'));

    const big = Array.from({ length: 6 * 1024 }, (_, k) => ({ topic: 'ps/local/arm/state', payload: { at: k, pad: 'x'.repeat(1024) } }));
    await assert.rejects(call(s.client, 'ps_stream_play', { messages: big }), (e: any) => {
      assert.equal(e.code, 413);
      assert.match(String(e.message), /Node-RED の上限（apiMaxLength）を超えています/);
      assert.match(String(e.message), /over Node-RED's size limit \(apiMaxLength\)/);
      return true;
    });
  } finally { await s.close(); }
});

test('each ps_stream_play takes the place of the agent\'s last attempt; append keeps both; ps_stream_clear empties the stream', async () => {
  const s = await small();
  try {
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0.5, 0] }));
    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-1']) }));
    s.clock.advance(2000);
    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-2']) }));
    s.clock.advance(2000);
    json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'only-b' }));
    assert.deepEqual(keptCopy(s.hub, 'only-b').traces.map((t: any) => t.deviceId), ['so101-2'], 'attempt A is gone');

    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-1']), append: true }));
    s.clock.advance(2000);
    json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'both' }));
    assert.deepEqual(keptCopy(s.hub, 'both').traces.map((t: any) => [t.deviceId, t.samples.length]), [['so101-1', 31], ['so101-2', 31]]);

    const cleared = json(await call(s.client, 'ps_stream_clear'));
    assert.equal(cleared.status.recorded, 0);
    assert.deepEqual(s.hub.streamBuffer(), []);
  } finally { await s.close(); }
});

test('a stream played at speed 2 is saved at the times the agent wrote', async () => {
  const s = await small();
  try {
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-1']), speed: 2 }));
    s.clock.advance(600);
    assert.equal(s.hub.status().playing, null, 'played in half the time');
    json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'fast' }));
    const times = keptCopy(s.hub, 'fast').traces[0].samples.map((x: any) => x.t);
    assert.deepEqual(times, Array.from({ length: 31 }, (_, k) => Math.round(k * 33) / 1000));
  } finally { await s.close(); }
});

test('a catalog object the agent listed, whose bundle.json cannot be fetched, is placed as a 0.2 m box, as from the pane', async () => {
  const catalog = async (url: string) => {
    const u = new URL(url);
    const answer = (body: unknown, status = 200) => ({
      ok: status === 200, status, json: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer, headers: { get: () => null },
    });
    if (u.pathname === '/api/catalog/search') {
      const kind = u.searchParams.get('kind');
      return answer({ items: kind === 'object' ? [{ handle: 'maker', name: 'crate', latest_version: '1', display: { ja: '箱' }, kind }] : [] });
    }
    return answer({}, 404);
  };
  const s = await small({ catalogBase: 'https://ps.test', fetchImpl: catalog });
  try {
    assert.match(refusal(await call(s.client, 'ps_scene_place', { product: 'maker/crate:1', xyz: [1, 1] })), new RegExp(`^${WORDS.noProduct}`), 'not listed: found nowhere');
    const listed = json(await call(s.client, 'ps_machines_list'));
    assert.ok(listed.machines.some((m: any) => m.ref === 'maker/crate:1' && m.kind === 'object'), JSON.stringify(listed));
    const placed = json(await call(s.client, 'ps_scene_place', { product: 'maker/crate:1', xyz: [1, 1] }));
    assert.deepEqual([placed.device.type, placed.device.shape, placed.device.pose.xyz], ['item', { sizeM: [0.2, 0.2, 0.2] }, [1, 1, 0.1]]);
  } finally { await s.close(); }
});

/** The joints of each device in one time's states (from hub.statesAt), by device id. */
const jointsOf = (states: { topic: string; payload: any }[]) =>
  Object.fromEntries(states.map((m) => [m.topic.split('/')[2], m.payload.joints]));
/** One arm's adjustment: 31 states a second apart from the wave, so they cannot be mistaken for it. */
const adjust = (id: string, base: number) => Array.from({ length: 31 }, (_, k) => ({
  topic: `ps/local/${id}/state`, payload: { at: k * 33, joints: { shoulder_pan: Math.round((base + k / 100) * 1000) / 1000 } },
}));
const tracesOf = (record: any) => Object.fromEntries(record.traces.map((t: any) => [t.deviceId, t.samples]));

/** Signed in to a fake PS.com, two arms placed. */
async function signedIn() {
  const fake = await new FakePsCom().start();
  const s = await small({ catalogBase: fake.base });
  await s.hub.client.loginStart();
  assert.equal(await s.hub.client.loginPoll(), 'approved');
  json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
  json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0.5, 0] }));
  return { ...s, fake, async close() { await s.close(); await fake.stop(); } };
}

test('after a save the stream is the saved record: an adjustment of one arm shows both arms in frames, and a save over writes just that', { timeout: 20_000 }, async () => {
  const s = await signedIn();
  try {
    json(await call(s.client, 'ps_stream_play', { messages: wave() }));
    s.clock.advance(2000);
    const take1 = json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'take1' }));
    assert.deepEqual([take1.saved, take1.ref, take1.version], [true, 'ada/take1', '1']);
    assert.equal(s.hub.status().recorded, 62, 'the saved record\'s states');
    const v1 = tracesOf(s.fake.record('ada', 'take1', '1'));

    // the agent adjusts the second arm only
    json(await call(s.client, 'ps_stream_play', { messages: adjust('so101-2', 1) }));
    s.clock.advance(2000);
    assert.equal(s.hub.status().recorded, 62, 'the first arm\'s 31 and the adjusted arm\'s 31');
    const at = s.hub.statesAt([0, 0.5])!;
    assert.deepEqual(at.states.map(jointsOf), [
      { 'so101-1': { shoulder_pan: angle(0, 0), elbow_flex: angle(0, 1) }, 'so101-2': { shoulder_pan: 1 } },
      { 'so101-1': { shoulder_pan: angle(15, 0), elbow_flex: angle(15, 1) }, 'so101-2': { shoulder_pan: 1.15 } },
    ],
    'both arms, the second as adjusted (its trace is the adjustment alone)');

    const over = json(await call(s.client, 'ps_record_save', { mode: 'over' }));
    assert.deepEqual([over.saved, over.ref, over.version], [true, 'ada/take1', '2']);
    const v2 = tracesOf(s.fake.record('ada', 'take1', '2'));
    assert.deepEqual(v2['so101-1'], v1['so101-1'], 'the other arm unchanged');
    assert.deepEqual(v2['so101-2'].map((x: any) => x.joints.shoulder_pan), adjust('so101-2', 1).map((m) => m.payload.joints.shoulder_pan));
    assert.deepEqual(s.hub.statesAt([0, 0.5])!.states, at.states, 'what the frames showed is what was saved');
  } finally { await s.close(); }
});

test('open a record, play one arm, save over, play the other arm: the frames and the next save agree', { timeout: 20_000 }, async () => {
  const s = await signedIn();
  try {
    json(await call(s.client, 'ps_stream_play', { messages: wave() }));
    s.clock.advance(2000);
    json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'take1' }));
    json(await call(s.client, 'ps_record_open', { ref: 'ada/take1' }));
    s.clock.advance(2000);

    json(await call(s.client, 'ps_stream_play', { messages: [{ topic: 'ps/local/so101-1/state', payload: { at: 0, joints: { shoulder_pan: 0.9 } } }] }));
    s.clock.advance(100);
    assert.equal(json(await call(s.client, 'ps_record_save', { mode: 'over' })).version, '2');
    json(await call(s.client, 'ps_stream_play', { messages: [{ topic: 'ps/local/so101-2/state', payload: { at: 0, joints: { shoulder_pan: 0.7 } } }] }));
    s.clock.advance(100);

    const at = s.hub.statesAt([0.5])!;
    assert.deepEqual(jointsOf(at.states[0]), { 'so101-1': { shoulder_pan: 0.9 }, 'so101-2': { shoulder_pan: 0.7 } }, 'the first arm as saved in version 2');
    const v3 = json(await call(s.client, 'ps_record_save', { mode: 'over' }));
    assert.equal(v3.version, '3');
    const traces = tracesOf(s.fake.record('ada', 'take1', '3'));
    assert.deepEqual(traces['so101-1'], [{ t: 0, joints: { shoulder_pan: 0.9 } }]);
    assert.deepEqual(traces['so101-2'], [{ t: 0, joints: { shoulder_pan: 0.7 } }]);
  } finally { await s.close(); }
});

test('ps_stream_clear starts fresh over an opened record: a save writes only what played after it; 上書き保存 is still the next version', { timeout: 20_000 }, async () => {
  const s = await signedIn();
  try {
    json(await call(s.client, 'ps_stream_play', { messages: wave() }));
    s.clock.advance(2000);
    json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'take1' }));
    const cleared = json(await call(s.client, 'ps_stream_clear'));
    assert.equal(cleared.status.recorded, 0);
    assert.deepEqual(cleared.status.opened, { ref: 'ada/take1', version: '1', own: true }, 'the record stays open');
    assert.equal(s.hub.statesAt([0]), null, 'nothing to show: a save would write no states');

    json(await call(s.client, 'ps_stream_play', { messages: [{ topic: 'ps/local/so101-1/state', payload: { at: 0, joints: { shoulder_pan: 0.4 } } }] }));
    s.clock.advance(100);
    assert.deepEqual(jointsOf(s.hub.statesAt([0])!.states[0]), { 'so101-1': { shoulder_pan: 0.4 } });
    const take2 = json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'take2' }));
    assert.equal(take2.saved, true);
    assert.deepEqual(s.fake.record('ada', 'take2', '1').traces.map((t: any) => t.deviceId), ['so101-1'], 'only the arm played after the clear');

    // over the record opened from PS.com: the next version of it, with only what played after the clear
    json(await call(s.client, 'ps_record_open', { ref: 'ada/take1' }));
    s.clock.advance(2000);
    json(await call(s.client, 'ps_stream_clear'));
    json(await call(s.client, 'ps_stream_play', { messages: [{ topic: 'ps/local/so101-2/state', payload: { at: 0, joints: { shoulder_pan: 0.3 } } }] }));
    s.clock.advance(100);
    const over = json(await call(s.client, 'ps_record_save', { mode: 'over' }));
    assert.deepEqual([over.ref, over.version], ['ada/take1', '2']);
    const v2 = s.fake.record('ada', 'take1', '2');
    assert.deepEqual(v2.traces, [{ deviceId: 'so101-2', samples: [{ t: 0, joints: { shoulder_pan: 0.3 } }] }]);
    assert.deepEqual(v2.equipment.devices.map((d: any) => d.id), ['so101-1', 'so101-2'], 'the record\'s devices stay');
  } finally { await s.close(); }
});

test('ps_stream_clear stops the agent\'s looping play, so nothing more is shown or kept', async () => {
  const s = await small();
  try {
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-1']), loop: true }));
    s.clock.advance(2500);
    assert.equal(s.hub.status().playing?.source, 'agent');
    const cleared = json(await call(s.client, 'ps_stream_clear'));
    assert.equal(cleared.status.playing, null, 'the loop stopped');
    const heard = s.red.published.length;
    s.clock.advance(3000);
    assert.equal(s.red.published.filter((p, i) => i >= heard && p.topic === 'ps-pane/state').length, 0);
    assert.equal(s.hub.status().recorded, 0);
  } finally { await s.close(); }
});

test('a play at speed 10 then one appended: the appended states are kept after the last kept one, none lost', async () => {
  const s = await small();
  try {
    json(await call(s.client, 'ps_scene_place', { product: 'physical-sandbox/so101:1', xyz: [0, 0] }));
    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-1']), speed: 10 }));
    s.clock.advance(200);
    json(await call(s.client, 'ps_stream_play', { messages: wave(['so101-1']), append: true }));
    s.clock.advance(2000);
    json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'twice' }));
    const times = keptCopy(s.hub, 'twice').traces[0].samples.map((x: any) => x.t);
    assert.equal(times.length, 62, 'every sample of both attempts');
    assert.ok(times.every((t: number, i: number) => i === 0 || t > times[i - 1]), 'in time order, no overlap');
    assert.deepEqual(times.slice(29, 33), [0.957, 0.99, 1.024, 1.057]);
  } finally { await s.close(); }
});

test('an MQTT recording that runs on across 保存: 上書き保存 holds the whole session, the frames agree, and the agent\'s arm is still replaced by its next attempt', { timeout: 20_000 }, async () => {
  const s = await signedIn();
  try {
    const t0 = s.clock.now();
    /** One live state of arm 1 from the broker, `k` tenths of a second into the session. */
    const live = (k: number) => {
      s.clock.advance(Math.max(0, t0 + k * 100 - s.clock.now()));
      assert.ok(s.hub.push({ topic: 'ps/local/so101-1/state', payload: { at: t0 + k * 100, joints: { shoulder_pan: k / 10 } } }, 'mqtt'));
    };
    for (let k = 0; k < 10; k += 1) live(k);
    json(await call(s.client, 'ps_stream_play', { messages: adjust('so101-2', 1) }));
    s.clock.advance(1100);
    const take1 = json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'session' }));
    assert.equal(take1.saved, true);
    const v1 = tracesOf(s.fake.record('ada', 'session', '1'));
    assert.equal(v1['so101-1'].length, 10);

    // the broker goes on; the agent adjusts arm 2 again
    for (let k = 21; k < 31; k += 1) live(k);
    json(await call(s.client, 'ps_stream_play', { messages: adjust('so101-2', 2) }));
    s.clock.advance(1100);
    const at = s.hub.statesAt([0, 2.5, 3])!;
    assert.deepEqual(at.states.map(jointsOf), [
      { 'so101-1': { shoulder_pan: 0 }, 'so101-2': { shoulder_pan: 2 } },
      { 'so101-1': { shoulder_pan: 2.5 }, 'so101-2': { shoulder_pan: 2.3 } },
      { 'so101-1': { shoulder_pan: 3 }, 'so101-2': { shoulder_pan: 2.3 } },
    ], 'arm 1 from the start of the session, arm 2 as adjusted after the save');

    assert.equal(json(await call(s.client, 'ps_record_save', { mode: 'over' })).version, '2');
    const v2 = tracesOf(s.fake.record('ada', 'session', '2'));
    assert.equal(v2['so101-1'].length, 20, 'the whole session');
    assert.deepEqual(v2['so101-1'].slice(0, 10), v1['so101-1'], 'what was saved first, then what came after');
    assert.deepEqual(v2['so101-1'].at(-1), { t: 3, joints: { shoulder_pan: 3 } });
    assert.deepEqual(v2['so101-2'].map((x: any) => x.joints.shoulder_pan), adjust('so101-2', 2).map((m) => m.payload.joints.shoulder_pan), 'the agent\'s attempt replaced');
    assert.deepEqual(s.hub.statesAt([0, 2.5, 3])!.states, at.states, 'what the frames showed is what was saved');
  } finally { await s.close(); }
});

test('append across a save keeps both attempts, in the frames and in 上書き保存', { timeout: 20_000 }, async () => {
  const s = await signedIn();
  try {
    json(await call(s.client, 'ps_stream_play', { messages: adjust('so101-1', 1) }));
    s.clock.advance(1100);
    json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'twice' }));
    json(await call(s.client, 'ps_stream_play', { messages: adjust('so101-1', 2), append: true }));
    s.clock.advance(1100);
    const at = s.hub.statesAt([0, 1.5])!;
    assert.deepEqual(at.states.map(jointsOf), [{ 'so101-1': { shoulder_pan: 1 } }, { 'so101-1': { shoulder_pan: 2.12 } }], 'the first attempt, then the appended one (from 1.1 s, when it was played)');
    assert.equal(json(await call(s.client, 'ps_record_save', { mode: 'over' })).version, '2');
    const v2 = tracesOf(s.fake.record('ada', 'twice', '2'))['so101-1'];
    assert.deepEqual(v2.map((x: any) => x.joints.shoulder_pan), [...adjust('so101-1', 1), ...adjust('so101-1', 2)].map((m) => m.payload.joints.shoulder_pan), 'both attempts');
    assert.deepEqual(s.hub.statesAt([0, 1.5])!.states, at.states, 'what the frames showed is what was saved');
  } finally { await s.close(); }
});

test('a save at 0.5 s of a 1 s play, then 上書き保存 after the play: the new version holds the whole play', { timeout: 20_000 }, async () => {
  const s = await signedIn();
  try {
    json(await call(s.client, 'ps_stream_play', { messages: adjust('so101-1', 1) }));
    s.clock.advance(500);
    json(await call(s.client, 'ps_record_save', { mode: 'new', name: 'half' }));
    assert.equal(tracesOf(s.fake.record('ada', 'half', '1'))['so101-1'].length, 16, 'what had played by then');
    s.clock.advance(1000);
    assert.equal(s.hub.status().playing, null);
    assert.equal(s.hub.statesAt([0.99])!.states[0].length, 1);
    assert.deepEqual(jointsOf(s.hub.statesAt([0.99])!.states[0]), { 'so101-1': { shoulder_pan: 1.3 } }, 'the frames have the rest of the play');
    assert.equal(json(await call(s.client, 'ps_record_save', { mode: 'over' })).version, '2');
    const v2 = tracesOf(s.fake.record('ada', 'half', '2'))['so101-1'];
    assert.deepEqual(v2.map((x: any) => x.joints.shoulder_pan), adjust('so101-1', 1).map((m) => m.payload.joints.shoulder_pan), 'the whole play');
  } finally { await s.close(); }
});

test('「記録を空にする」 pressed while a save is under way waits for it, and is not undone when the save ends', { timeout: 20_000 }, async () => {
  const s = await signedIn();
  try {
    json(await call(s.client, 'ps_stream_play', { messages: wave() }));
    s.clock.advance(2000);
    let release!: () => void;
    s.fake.holdPuts = new Promise<void>((done) => { release = done; });
    const saving = call(s.client, 'ps_record_save', { mode: 'new', name: 'held' });
    for (let i = 0; i < 200 && s.fake.putsWaiting === 0; i += 1) await new Promise((done) => setTimeout(done, 10));
    let cleared = false;
    const clearing = call(s.client, 'ps_stream_clear').then((answer) => { cleared = true; return answer; });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(cleared, false, 'the clear waits for the save');
    assert.equal(s.hub.status().recorded, 62);
    s.fake.holdPuts = null;
    release();
    assert.equal(json(await saving).ref, 'ada/held');
    assert.equal(json(await clearing).status.recorded, 0);
    assert.deepEqual(s.hub.status().opened, { ref: 'ada/held', version: '1', own: true });
    assert.equal(s.hub.statesAt([0]), null, 'after the save, the clear: nothing a save would write');

    json(await call(s.client, 'ps_stream_play', { messages: [{ topic: 'ps/local/so101-2/state', payload: { at: 0, joints: { shoulder_pan: 0.2 } } }] }));
    s.clock.advance(100);
    assert.equal(json(await call(s.client, 'ps_record_save', { mode: 'over' })).version, '2');
    assert.deepEqual(s.fake.record('ada', 'held', '2').traces, [{ deviceId: 'so101-2', samples: [{ t: 0, joints: { shoulder_pan: 0.2 } }] }]);
  } finally { await s.close(); }
});
