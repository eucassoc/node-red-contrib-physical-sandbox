// The nodes, run in node-red-node-test-helper: `ps in` takes MQTT messages into the hub, `ps play`
// plays a record out. The helper loads no plugins, so each test gives the nodes a stub hub through
// RED.plugins.get('physical-sandbox') (or none, to see what a node does without the plugin).
import { test, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import psInNode from '../src/nodes/ps-in.js';
import psPlayNode from '../src/nodes/ps-play.js';
import { PsComClient } from '../src/core/pscom-client.js';
import { fakeClock } from './helpers/fake-red.js';
import { FakePsCom } from './helpers/fake-pscom.js';
import { catalogUnderscore } from './helpers/node-catalog.js';

const require = createRequire(import.meta.url);
const helper = require('node-red-node-test-helper');

before(() => helper.init(require.resolve('node-red')));
afterEach(async () => { await helper.unload(); });

type Pushed = { message: any; from: string; opts: any };

/** A hub as the nodes use it: what was pushed, the scene's site, a clock and a PS.com client. */
function stubHub(opts: { clock?: ReturnType<typeof fakeClock>; client?: unknown; site?: string } = {}) {
  const pushed: Pushed[] = [];
  return {
    pushed,
    clock: opts.clock ?? fakeClock(),
    client: opts.client,
    scene: () => ({ site: opts.site ?? 'local' }),
    push(message: unknown, from: string, o?: unknown) {
      pushed.push({ message, from, opts: o });
      return true;
    },
  };
}

/** The node modules, given a RED whose plugins answer with `hub` (or with nothing). */
function withHub(hub: unknown, lang: 'en-US' | 'ja' = 'ja') {
  return [psInNode, psPlayNode].map((fn) => (red: any) => {
    red._ = catalogUnderscore(lang);
    red.plugins.get = (id: string) => (id === 'physical-sandbox' && hub ? { type: 'physical-sandbox', hub } : undefined);
    return fn(red);
  });
}

const tick = () => new Promise((done) => setImmediate(done));
async function settle(): Promise<void> { for (let i = 0; i < 5; i += 1) await tick(); }

/** Everything the helper node at `id` is sent. */
function collect(id: string): any[] {
  const got: any[] = [];
  helper.getNode(id).on('input', (msg: any) => got.push(msg));
  return got;
}

/** Every status the node has been given, in order. */
function statuses(node: any): any[] {
  const seen: any[] = [];
  const original = node.status.bind(node);
  node.status = (s: any) => { seen.push(s); return original(s); };
  return seen;
}

const inFlow = (extra: Record<string, unknown> = {}) => [
  { id: 'in', type: 'ps in', name: '', site: '', wires: [['out']], ...extra },
  { id: 'out', type: 'helper' },
];

// ---- ps in ----

test('ps in takes a payload object, JSON text or a Buffer as mqtt in gives it, into the hub and on to its output', async () => {
  const hub = stubHub();
  await helper.load(withHub(hub), inFlow());
  const out = collect('out');
  const node = helper.getNode('in');
  const payload = { at: 5, joints: { j: 0.5 } };
  node.receive({ topic: 'ps/local/arm/state', payload, qos: 0, retain: false });
  node.receive({ topic: 'ps/local/arm/state', payload: JSON.stringify({ ...payload, at: 6 }), qos: 0, retain: false });
  node.receive({ topic: 'ps/local/arm/event', payload: Buffer.from(JSON.stringify({ at: 7, name: 'grip' })), qos: 0, retain: false });
  await settle();
  assert.deepEqual(hub.pushed.map((p) => [p.message.topic, p.from, p.opts]), [
    ['ps/local/arm/state', 'mqtt', { retained: false }],
    ['ps/local/arm/state', 'mqtt', { retained: false }],
    ['ps/local/arm/event', 'mqtt', { retained: false }],
  ]);
  assert.deepEqual(hub.pushed[0].message.payload, payload);
  assert.equal(hub.pushed[1].message.payload, JSON.stringify({ ...payload, at: 6 }), 'the hub reads the text itself');
  assert.ok(Buffer.isBuffer(hub.pushed[2].message.payload), 'the hub reads the bytes itself');
  assert.deepEqual(out.map((m) => m.topic), ['ps/local/arm/state', 'ps/local/arm/state', 'ps/local/arm/event']);
});

test('ps in passes a retained message to the hub as retained', async () => {
  const hub = stubHub();
  await helper.load(withHub(hub), inFlow());
  helper.getNode('in').receive({ topic: 'ps/local/arm/state', payload: { at: 1, joints: { j: 1 } }, retain: true });
  await settle();
  assert.deepEqual(hub.pushed.map((p) => p.opts), [{ retained: true }]);
});

test('ps in drops what is not a message without throwing, and says so once with a yellow status', async () => {
  const hub = stubHub();
  await helper.load(withHub(hub), inFlow());
  const out = collect('out');
  const node = helper.getNode('in');
  const seen = statuses(node);
  const errors: unknown[] = [];
  node.on('call:error', (call: unknown) => errors.push(call));
  for (const msg of [
    { topic: 'ps/local/arm/state', payload: 42 },
    { topic: 'ps/local/arm/state', payload: 'not json' },
    { topic: 'ps/local/arm/state', payload: Buffer.from([0xff, 0x00]) },
    { topic: 'ps/local/arm/state', payload: { joints: { j: 1 } } }, // no at
    { topic: 'sensors/temp', payload: { at: 1 } },
    { topic: 'ps/local/arm/wave', payload: { at: 1 } },
    { payload: { at: 1 } },
    { topic: 'ps/local/arm/state', payload: null },
    { topic: 'ps/local/arm/state', payload: [1, 2] },
  ]) node.receive(msg);
  await settle();
  assert.deepEqual(hub.pushed, []);
  assert.deepEqual(out, []);
  assert.deepEqual(errors, []);
  const yellow = seen.filter((s) => s?.text === '読み込めないメッセージ');
  assert.equal(yellow.length, 1, JSON.stringify(seen));
  assert.equal(yellow[0].fill, 'yellow');
  node.receive({ topic: 'ps/local/arm/state', payload: { at: 2, joints: { j: 1 } } });
  await settle();
  assert.equal(hub.pushed.length, 1, 'a good message still goes after a bad one');
});

test('ps in with a site takes that site\'s messages only', async () => {
  const hub = stubHub();
  await helper.load(withHub(hub), inFlow({ site: 'farm' }));
  const out = collect('out');
  const node = helper.getNode('in');
  node.receive({ topic: 'ps/yard/arm/state', payload: { at: 1, joints: { j: 1 } } });
  node.receive({ topic: 'ps/farm/arm/state', payload: { at: 2, joints: { j: 1 } } });
  await settle();
  assert.deepEqual(hub.pushed.map((p) => p.message.topic), ['ps/farm/arm/state']);
  assert.deepEqual(out.map((m) => m.topic), ['ps/farm/arm/state']);
});

test('ps in without the plugin says so with a red status, and still passes the message on', async () => {
  await helper.load(withHub(null), inFlow());
  const out = collect('out');
  const node = helper.getNode('in');
  const seen = statuses(node);
  node.receive({ topic: 'ps/local/arm/state', payload: { at: 1, joints: { j: 1 } } });
  await settle();
  assert.deepEqual(out.map((m) => m.topic), ['ps/local/arm/state']);
  assert.deepEqual(seen.at(-1), { fill: 'red', shape: 'ring', text: 'プラグインが読み込まれていません' });
});

test('ps in with a site that is not a site name says so in red and takes nothing', async () => {
  const hub = stubHub();
  await helper.load(withHub(hub), inFlow({ site: 'a/b' }));
  const out = collect('out');
  const node = helper.getNode('in');
  const seen = statuses(node);
  node.receive({ topic: 'ps/local/arm/state', payload: { at: 1, joints: { j: 1 } } });
  await settle();
  assert.deepEqual(hub.pushed, []);
  assert.deepEqual(out, []);
  assert.deepEqual(seen.at(-1), { fill: 'red', shape: 'ring', text: '現地の名前が正しくありません' });
});

// ---- ps play ----

/** An arm moving over a second (samples at 0, 0.5 and 1 s) and a box set down at 0.5 s. */
const record = {
  schemaVersion: 3,
  frame: { frameId: 'site', up: '+Y', unit: 'm' },
  equipment: {
    site: { id: 'rec-site' },
    devices: [
      { id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } },
      { id: 'box', type: 'item', parent: 'site', pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } },
    ],
  },
  names: { arm: 'arm', box: 'box' },
  traces: [
    { deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 0.5, joints: { j: 0.5 } }, { t: 1, joints: { j: 1 } }] },
    { deviceId: 'box', samples: [{ t: 0.5, position: [1, 0, 0.2] }] },
  ],
  markers: [],
  routes: [],
};

const playFlow = (extra: Record<string, unknown> = {}) => [
  { id: 'play', type: 'ps play', name: '', source: 'inline', record: JSON.stringify(record), ref: '', loop: false, speed: 1, wires: [['out']], ...extra },
  { id: 'out', type: 'helper' },
];

const START = 1_000_000;

test('ps play plays the record\'s states in time: out on its output and into the hub from the record', async () => {
  const clock = fakeClock(START);
  const hub = stubHub({ clock, site: 'farm' });
  await helper.load(withHub(hub), playFlow());
  const out = collect('out');
  const node = helper.getNode('play');
  const seen = statuses(node);
  node.receive({ payload: 'start' });
  await settle();
  assert.deepEqual(out.map((m) => [m.topic, m.payload]), [['ps/farm/arm/state', { at: START, joints: { j: 0 } }]]);
  assert.equal(out[0].retain, undefined, 'retaining is mqtt out\'s choice');
  clock.advance(499);
  await settle();
  assert.equal(out.length, 1);
  clock.advance(1);
  await settle();
  assert.deepEqual(out.slice(1).map((m) => [m.topic, m.payload]), [
    ['ps/farm/arm/state', { at: START + 500, joints: { j: 0.5 } }],
    ['ps/farm/box/state', { at: START + 500, type: 'item', parent: 'site', xyz: [1, 0, 0.2] }],
  ]);
  clock.advance(500);
  await settle();
  assert.equal(out.length, 4);
  assert.deepEqual(out[3].payload, { at: START + 1000, joints: { j: 1 } });
  assert.deepEqual(hub.pushed.map((p) => [p.message, p.from]), out.map((m) => [{ topic: m.topic, payload: m.payload }, 'record']));
  assert.ok(seen.some((s) => s.text === '再生中 1/4'), JSON.stringify(seen));
  assert.equal(seen.at(-1).text, '再生終了 4/4');
  clock.advance(5000);
  await settle();
  assert.equal(out.length, 4, 'nothing after the end');
});

test('ps play: stop keeps where it was, start begins again from the start, rewind goes back without sending', async () => {
  const clock = fakeClock(START);
  const hub = stubHub({ clock });
  await helper.load(withHub(hub), playFlow());
  const out = collect('out');
  const node = helper.getNode('play');
  const seen = statuses(node);
  node.receive({ payload: 'start' });
  clock.advance(600);
  await settle();
  assert.equal(out.length, 3);
  node.receive({ payload: 'stop' });
  await settle();
  assert.equal(seen.at(-1).text, '停止 3/4');
  clock.advance(5000);
  await settle();
  assert.equal(out.length, 3, 'nothing while stopped');

  node.receive({ payload: { command: 'start' } });
  await settle();
  assert.equal(out.length, 4);
  assert.deepEqual(out[3].payload, { at: START + 5600, joints: { j: 0 } }, 'from the start again');
  clock.advance(500);
  await settle();
  assert.equal(out.length, 6);

  node.receive({ payload: 'start' }); // while playing: from the start again
  await settle();
  assert.deepEqual(out.slice(6).map((m) => m.payload.joints?.j), [0]);

  node.receive({ payload: 'rewind' });
  await settle();
  assert.equal(out.length, 7, 'rewind sends nothing');
  assert.equal(seen.at(-1).text, '先頭 0/4');
  clock.advance(5000);
  await settle();
  assert.equal(out.length, 7);
});

test('ps play takes speed and loop with the command, over its settings', async () => {
  const clock = fakeClock(START);
  const hub = stubHub({ clock });
  await helper.load(withHub(hub), playFlow());
  const out = collect('out');
  const node = helper.getNode('play');
  node.receive({ payload: { command: 'start', speed: 2, loop: true } });
  await settle();
  clock.advance(250);
  await settle();
  assert.deepEqual(out.map((m) => m.payload.at - START), [0, 250, 250]);
  clock.advance(250); // the end, and round again
  await settle();
  assert.deepEqual(out.map((m) => m.payload.joints?.j ?? null), [0, 0.5, null, 1, 0]);
  assert.equal(out[4].payload.at, START + 500);
  node.receive({ payload: 'stop' });
  clock.advance(5000);
  await settle();
  assert.equal(out.length, 5);
});

test('ps play plays its loop setting, and leaves alone what is not a command', async () => {
  const clock = fakeClock(START);
  const hub = stubHub({ clock });
  await helper.load(withHub(hub), playFlow({ loop: true }));
  const out = collect('out');
  const node = helper.getNode('play');
  const warnings: unknown[] = [];
  node.on('call:warn', (call: any) => warnings.push(call.args[0]));
  node.receive({ payload: 1731300000000 }); // an inject's timestamp
  node.receive({ payload: 'play' });
  await settle();
  assert.deepEqual(out, []);
  assert.equal(warnings.length, 2);
  node.receive({ payload: 'start' });
  clock.advance(1000);
  await settle();
  assert.equal(out.length, 5, 'round again at the end');
});

test('ps play with a broken inline record says so in red and sends nothing', async () => {
  const hub = stubHub();
  await helper.load(withHub(hub), playFlow({ record: '{"traces": [' }));
  const out = collect('out');
  const node = helper.getNode('play');
  const seen = statuses(node);
  node.receive({ payload: 'start' });
  await settle();
  assert.deepEqual(out, []);
  assert.deepEqual(seen.at(-1), { fill: 'red', shape: 'ring', text: '記録の JSON を読み込めませんでした' });
});

test('ps play without the plugin says so with a red status', async () => {
  await helper.load(withHub(null), playFlow());
  const out = collect('out');
  const node = helper.getNode('play');
  const seen = statuses(node);
  node.receive({ payload: 'start' });
  await settle();
  assert.deepEqual(out, []);
  assert.deepEqual(seen.at(-1), { fill: 'red', shape: 'ring', text: 'プラグインが読み込まれていません' });
});

test('ps play reads a record source through the plugin\'s client, once; a private one signed out answers in red', async () => {
  const fake = await new FakePsCom().start();
  try {
    fake.seed('ada', 'walk', '2', record, { visibility: 'public' });
    fake.seed('ada', 'secret', '1', record, { visibility: 'private' });
    const client = new PsComClient({ base: fake.base, tokenFile: join(mkdtempSync(join(tmpdir(), 'ps-play-')), 'token.json') });
    let opened = 0;
    const counting = Object.assign(Object.create(client), {
      openRecord: (ref: string) => { opened += 1; return client.openRecord(ref); },
    });
    const clock = fakeClock(START);
    const hub = stubHub({ clock, client: counting });
    await helper.load(withHub(hub), [
      ...playFlow({ source: 'record', ref: 'ada/walk' }),
      { id: 'secret', type: 'ps play', name: '', source: 'record', record: '', ref: 'ada/secret:1', loop: false, speed: 1, wires: [['out']] },
    ]);
    const out = collect('out');
    const node = helper.getNode('play');
    const seen = statuses(node);
    node.receive({ payload: 'start' });
    for (let i = 0; i < 50 && !out.length; i += 1) await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(out.map((m) => m.payload), [{ at: clock.now(), joints: { j: 0 } }]);
    assert.ok(seen.some((s) => s.text === '記録を取得中'));
    node.receive({ payload: 'start' });
    await settle();
    assert.equal(out.length, 2, 'the second start plays at once');
    assert.equal(opened, 1, 'the record is read once');

    const secret = helper.getNode('secret');
    const secretSeen = statuses(secret);
    const errors: unknown[] = [];
    secret.on('call:error', (call: any) => errors.push(call.args[0]));
    secret.receive({ payload: 'start' });
    for (let i = 0; i < 50 && !secretSeen.some((s) => s.fill === 'red'); i += 1) await new Promise((done) => setTimeout(done, 10));
    const red = secretSeen.find((s) => s.fill === 'red');
    assert.match(red?.text ?? '', /記録が見つかりませんでした（ada\/secret:1）/);
    assert.match(red.text, /PS\.com にログイン/);
    assert.equal(errors.length, 1, 'the error goes to catch nodes too');
    assert.equal(out.length, 2);
  } finally { await fake.stop(); }
});

test('ps play with PS.com out of reach says so in red', async () => {
  const client = new PsComClient({ base: 'http://127.0.0.1:9', tokenFile: join(mkdtempSync(join(tmpdir(), 'ps-play-')), 'token.json') });
  const hub = stubHub({ client });
  await helper.load(withHub(hub), playFlow({ source: 'record', ref: 'ada/walk' }));
  const node = helper.getNode('play');
  const seen = statuses(node);
  node.on('call:error', () => {});
  node.receive({ payload: 'start' });
  for (let i = 0; i < 100 && !seen.some((s) => s.fill === 'red'); i += 1) await new Promise((done) => setTimeout(done, 10));
  assert.equal(seen.find((s) => s.fill === 'red')?.text, 'PS.com に接続できませんでした');
});

test('ps play plays at the speed of its settings, kept between 0.1 and 10', async () => {
  for (const [speed, steps] of [
    [2, [[249, 1], [1, 3], [250, 4]]],
    ['50', [[99, 3], [1, 4]]],          // 10 times
    [0.01, [[4999, 1], [1, 3]]],        // a tenth
  ] as const) {
    const clock = fakeClock(START);
    const hub = stubHub({ clock });
    await helper.load(withHub(hub), playFlow({ speed }));
    const out = collect('out');
    helper.getNode('play').receive({ payload: 'start' });
    await settle();
    for (const [ms, count] of steps) {
      clock.advance(ms);
      await settle();
      assert.equal(out.length, count, `speed ${speed}, at ${clock.now() - START} ms`);
    }
    await helper.unload();
  }
});

test('ps play stops playing when it is closed (a deploy or a removal)', async () => {
  const clock = fakeClock(START);
  const hub = stubHub({ clock });
  await helper.load(withHub(hub), playFlow({ loop: true }));
  const out = collect('out');
  const node = helper.getNode('play');
  node.receive({ payload: 'start' });
  await settle();
  assert.equal(out.length, 1);
  await node.close();
  assert.equal(clock.pending(), 0, 'no timer left');
  clock.advance(5000);
  await settle();
  assert.equal(out.length, 1);
  assert.equal(hub.pushed.length, 1);
});

test('ps play with a record that has no motion says so in yellow', async () => {
  const hub = stubHub();
  await helper.load(withHub(hub), playFlow({ record: JSON.stringify({ ...record, traces: [] }) }));
  const out = collect('out');
  const node = helper.getNode('play');
  const seen = statuses(node);
  node.receive({ payload: 'start' });
  await settle();
  assert.deepEqual(out, []);
  assert.deepEqual(seen.at(-1), { fill: 'yellow', shape: 'ring', text: '記録に再生できる動きがありません' });
});

test('ps play with a ref that is not handle/name[:version] says so in red without asking PS.com', async () => {
  for (const ref of ['walk', 'ada/Walk', 'ada/walk:1:2', 'ada/w']) {
    let asked = 0;
    const hub = stubHub({ client: { openRecord: async () => { asked += 1; return { record }; }, status: () => ({ signedIn: false, handle: null }) } });
    await helper.load(withHub(hub), playFlow({ source: 'record', ref }));
    const node = helper.getNode('play');
    const seen = statuses(node);
    const errors: unknown[] = [];
    node.on('call:error', (call: any) => errors.push(call.args[0]));
    node.receive({ payload: 'start' });
    await settle();
    assert.equal(asked, 0, ref);
    assert.deepEqual(seen.at(-1), { fill: 'red', shape: 'ring', text: '記録の名前は handle/name か handle/name:バージョン で指定してください' }, ref);
    assert.equal(errors.length, 1);
    await helper.unload();
  }
});

test('ps play shows other failures as they are: a TypeError from the client, a throw while starting', async () => {
  const cases: [string, () => unknown, () => unknown][] = [
    ['boom', async () => { throw new TypeError('boom'); }, () => ({ site: 'local' })],
    ['no scene', async () => ({ record }), () => { throw new Error('no scene'); }],
  ];
  for (const [text, openRecord, scene] of cases) {
    const hub = { ...stubHub({ client: { openRecord, status: () => ({ signedIn: true, handle: 'ada' }) } }), scene };
    await helper.load(withHub(hub), playFlow({ source: 'record', ref: 'ada/walk' }));
    const node = helper.getNode('play');
    const seen = statuses(node);
    const errors: any[] = [];
    node.on('call:error', (call: any) => errors.push(call.args[0]));
    node.receive({ payload: 'start' });
    for (let i = 0; i < 50 && !errors.length; i += 1) await new Promise((done) => setTimeout(done, 5));
    assert.deepEqual(seen.at(-1), { fill: 'red', shape: 'ring', text }, text);
    assert.equal(errors.length, 1, text);
    await helper.unload();
  }
});
