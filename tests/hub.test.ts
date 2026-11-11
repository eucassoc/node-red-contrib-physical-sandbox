// The hub: the scene, the stream and the panes. Tests for src/plugin/hub.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, normalizeScene, SNAPSHOT_MS } from '../src/plugin/hub.js';
import { messagesToRecord, recordToMessages } from '../src/core/stream.js';
import { readSettings } from '../src/plugin/settings.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ps-hub-'));

function setup(userDir = tmp(), settings: Record<string, unknown> = {}) {
  const red = fakeRed({ userDir });
  const clock = fakeClock();
  const hub = createHub(red.RED, { userDir, settings: readSettings(settings, { userDir, env: {} }), clock, fetchImpl: async () => { throw new Error('no network in this test'); } });
  return { red, clock, hub, userDir };
}

const arm = { id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } };
const box = { id: 'box', product: 'physical-sandbox/crate:1', owner: 'viewer', parent: 'site', type: 'item', shape: { sizeM: [0.2, 0.2, 0.2] }, pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } };
const states = (published: { topic: string; data: any }[]) => published.filter((p) => p.topic === 'ps-pane/state').map((p) => p.data);

test('settings: defaults, settings.js values, and PS_CATALOG_URL winning', () => {
  assert.deepEqual(readSettings(undefined, { userDir: '/u', env: {} }), { catalogBase: 'https://physicalsandbox.com', localMachineDirs: [], site: 'local' });
  assert.deepEqual(
    readSettings({ catalogBase: 'https://ps.test/', localMachineDirs: ['robots', '/abs', 3], site: 'yard' }, { userDir: '/u', env: {} }),
    { catalogBase: 'https://ps.test', localMachineDirs: ['/u/robots', '/abs'], site: 'yard' },
  );
  assert.equal(readSettings({ catalogBase: 'https://a.test' }, { userDir: '/u', env: { PS_CATALOG_URL: 'https://b.test' } }).catalogBase, 'https://b.test');
  assert.equal(readSettings({ site: 'a/b' }, { userDir: '/u', env: {} }).site, 'local');
});

test('a new hub has an empty scene on the configured site and tells the panes at once', () => {
  const { red, hub } = setup(tmp(), { site: 'yard' });
  assert.deepEqual(hub.scene(), { site: 'yard', siteFrameId: null, background: null, camera: null, floor: null, devices: [], names: {} });
  assert.deepEqual(red.retained('ps-pane/scene'), hub.scene());
  assert.deepEqual(red.retained('ps-pane/snapshot'), []);
  assert.deepEqual(red.retained('ps-pane/status'), {
    login: { signedIn: false, handle: null }, unsent: [], playing: null, agentFrames: false, recorded: 0, opened: null, defaultSite: 'yard', full: false,
  });
});

test('push drops bad topics and payloads without throwing', () => {
  const { red, hub } = setup();
  const bad: unknown[] = [
    null, 'ps/local/arm/state', {}, { topic: 1, payload: { at: 1 } },
    { topic: 'ps/local/arm', payload: { at: 1, joints: { j: 1 } } },
    { topic: 'xx/local/arm/state', payload: { at: 1, joints: { j: 1 } } },
    { topic: 'ps/local/arm/other', payload: { at: 1, joints: { j: 1 } } },
    { topic: 'ps/local/$arm/state', payload: { at: 1, joints: { j: 1 } } },
    { topic: `ps/local/${'a'.repeat(81)}/state`, payload: { at: 1, joints: { j: 1 } } },
    { topic: 'ps/local/__proto__/state', payload: { at: 1, joints: { j: 1 } } },
    { topic: 'ps/local/arm/state', payload: [1, 2] },
    { topic: 'ps/local/arm/state', payload: { joints: { j: 1 } } },
    { topic: 'ps/local/arm/state', payload: { at: 'soon', joints: { j: 1 } } },
    { topic: 'ps/local/arm/state', payload: 'not json' },
    { topic: 'ps/local/arm/state', payload: '[1]' },
    { topic: 'ps/local/arm/state', payload: { at: 1 } }, // a state with nothing to apply
    { topic: 'ps/local/arm/state', payload: { at: 1, big: 10n } },
  ];
  for (const message of bad) assert.equal(hub.push(message, 'mqtt'), false, JSON.stringify(message, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  assert.deepEqual(states(red.published), []);
  assert.deepEqual(hub.streamBuffer(), []);
  // JSON text and a Buffer are taken as the payload they hold
  assert.equal(hub.push({ topic: 'ps/local/arm/state', payload: '{"at":5,"joints":{"j":1}}' }, 'mqtt'), true);
  assert.equal(hub.push({ topic: 'ps/local/arm/state', payload: Buffer.from('{"at":6,"joints":{"j":2}}') }, 'mqtt'), true);
  assert.deepEqual(states(red.published).map((m) => [m.topic, m.payload, m.at, m.from]), [
    ['ps/local/arm/state', { at: 5, joints: { j: 1 } }, 5, 'mqtt'],
    ['ps/local/arm/state', { at: 6, joints: { j: 2 } }, 6, 'mqtt'],
  ]);
});

test('an older at is ignored: not sent, not kept, the latest stays', () => {
  const { red, hub, clock } = setup();
  assert.equal(hub.push({ topic: 'ps/local/arm/state', payload: { at: 2000, joints: { j: 2 } } }, 'mqtt'), true);
  assert.equal(hub.push({ topic: 'ps/local/arm/state', payload: { at: 1000, joints: { j: 1 } } }, 'mqtt'), false);
  clock.advance(SNAPSHOT_MS);
  assert.equal(states(red.published).length, 1);
  assert.equal(hub.streamBuffer().length, 1);
  assert.deepEqual(red.retained('ps-pane/snapshot'), [{ topic: 'ps/local/arm/state', payload: { at: 2000, joints: { j: 2 } }, at: 2000 }]);
});

test('commands and events reach the panes but are neither kept in the stream nor in the snapshot', () => {
  const { red, hub, clock } = setup();
  assert.equal(hub.push({ topic: 'ps/local/arm/command', payload: { at: 1, go: 'home' } }, 'agent'), true);
  assert.equal(hub.push({ topic: 'ps/local/arm/event', payload: { at: 2, done: true } }, 'mqtt'), true);
  clock.advance(SNAPSHOT_MS);
  assert.deepEqual(states(red.published).map((m) => m.topic), ['ps/local/arm/command', 'ps/local/arm/event']);
  assert.deepEqual(hub.streamBuffer(), []);
  assert.deepEqual(red.retained('ps-pane/snapshot'), []);
});

test('the snapshot holds the latest state of every device, merged as the pane merges, at most ten times a second', () => {
  const { red, hub, clock } = setup();
  hub.setScene({ devices: [arm, box] as any, names: { arm: 'arm', box: 'box' } });
  const snapshots = () => red.published.filter((p) => p.topic === 'ps-pane/snapshot').length;
  const before = snapshots();
  hub.push({ topic: 'ps/local/arm/state', payload: { at: 10, joints: { a: 1, b: 2 } } }, 'mqtt');
  assert.equal(snapshots(), before + 1, 'the first change goes at once');
  hub.push({ topic: 'ps/local/arm/state', payload: { at: 20, joints: { b: 3 }, position: [1, 2, 0], yaw: 0.5 } }, 'mqtt');
  hub.push({ topic: 'ps/local/box/state', payload: { at: 30, parent: 'site', xyz: [1, 1, 0] } }, 'mqtt');
  assert.equal(snapshots(), before + 1, 'the next ones wait for the 100 ms');
  clock.advance(SNAPSHOT_MS);
  assert.equal(snapshots(), before + 2);
  assert.deepEqual(red.retained('ps-pane/snapshot'), [
    { topic: 'ps/local/arm/state', payload: { at: 20, position: [1, 2, 0], yaw: 0.5, joints: { a: 1, b: 3 } }, at: 20 },
    { topic: 'ps/local/box/state', payload: { at: 30, parent: 'site', xyz: [1, 1, 0], type: 'item' }, at: 30 },
  ]);
  // with the stream count in the status
  assert.equal(red.retained('ps-pane/status').recorded, 3);
  hub.clearStream();
  assert.equal(red.retained('ps-pane/status').recorded, 0);
  assert.deepEqual(red.retained('ps-pane/snapshot'), [], 'clearing the stream forgets the latest states too');
  assert.equal(hub.push({ topic: 'ps/local/arm/state', payload: { at: 5, joints: { a: 0 } } }, 'mqtt'), true, 'an earlier at than before the clear is taken again');
});

test('two panes see the same scene and stream; a pane opened late gets the scene and the latest state at once', () => {
  const { red, hub, clock } = setup();
  const early = red.pane();
  hub.setScene({ devices: [arm] as any, names: { arm: 'arm' } });
  hub.push({ topic: 'ps/local/arm/state', payload: { at: 10, joints: { a: 1 } } }, 'mqtt');
  hub.push({ topic: 'ps/local/arm/state', payload: { at: 20, joints: { a: 2 } } }, 'mqtt');
  clock.advance(SNAPSHOT_MS);

  const late = red.pane();
  assert.deepEqual(late.latest('ps-pane/scene'), hub.scene());
  assert.deepEqual(late.latest('ps-pane/snapshot'), [{ topic: 'ps/local/arm/state', payload: { at: 20, joints: { a: 2 } }, at: 20 }]);
  assert.equal(late.latest('ps-pane/status').recorded, 2);
  assert.deepEqual(early.latest('ps-pane/scene'), late.latest('ps-pane/scene'));

  hub.push({ topic: 'ps/local/arm/state', payload: { at: 30, joints: { a: 3 } } }, 'mqtt');
  for (const pane of [early, late]) assert.deepEqual(pane.latest('ps-pane/state').payload, { at: 30, joints: { a: 3 } });
});

test('the scene survives a restart: a new hub on the same user directory has it, written atomically', () => {
  const userDir = tmp();
  const first = setup(userDir);
  first.hub.setScene({ site: 'yard', siteFrameId: 'sf-1', devices: [arm] as any, names: { outside: 'arm' }, streamNames: { arm: 'arm' } });
  first.hub.close();
  const dir = join(userDir, 'physical-sandbox');
  assert.deepEqual(readdirSync(dir), ['scene.json']);
  const second = setup(userDir);
  assert.deepEqual(second.hub.scene(), first.hub.scene());
  assert.deepEqual(second.red.retained('ps-pane/scene'), first.hub.scene());
});

test('a background whose file is gone is not restored; one whose file is there is', () => {
  const userDir = tmp();
  const first = setup(userDir);
  first.hub.setScene({ background: { kind: 'still', name: 'site.png' } });
  assert.equal(setup(userDir).hub.scene().background, null);
  mkdirSync(join(userDir, 'physical-sandbox', 'backgrounds'), { recursive: true });
  writeFileSync(join(userDir, 'physical-sandbox', 'backgrounds', 'site.png'), 'png');
  assert.deepEqual(setup(userDir).hub.scene().background, { kind: 'still', name: 'site.png' });
});

test('a scene.json that is not one gives an empty scene', () => {
  const userDir = tmp();
  mkdirSync(join(userDir, 'physical-sandbox'), { recursive: true });
  writeFileSync(join(userDir, 'physical-sandbox', 'scene.json'), '{not json');
  assert.deepEqual(setup(userDir).hub.scene().devices, []);
});

const twoDeviceRecord = {
  schemaVersion: 3,
  frame: { frameId: 'site', up: '+Y', unit: 'm' },
  markers: [],
  equipment: { site: { id: 'local' }, devices: [arm, box] },
  names: { arm: 'arm', box: 'box' },
  traces: [
    { deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 0.5, joints: { j: 0.5 } }, { t: 1, joints: { j: 1 } }] },
    { deviceId: 'box', samples: [{ t: 0, position: [1, 0, 0] }, { t: 0.25, position: [1.5, 0, 0] }] },
  ],
  routes: [],
};

test('playing a record sends its states in time order, each when it falls due, then ends', () => {
  const { red, hub, clock } = setup();
  hub.open(twoDeviceRecord, { file: 'two.record.json', record: twoDeviceRecord });
  const start = clock.now();
  const played = hub.play(twoDeviceRecord, { source: 'two.record.json' });
  assert.deepEqual(played, { count: 5, duration: 1 });
  assert.deepEqual(red.retained('ps-pane/status').playing, { source: 'two.record.json', t: 0, duration: 1 });
  const sent = () => states(red.published).map((m) => [m.topic.split('/')[2], m.at - start, m.from]);
  assert.deepEqual(sent(), [['arm', 0, 'record'], ['box', 0, 'record']]);
  clock.advance(249);
  assert.equal(sent().length, 2, 'nothing before it falls due');
  clock.advance(1);
  assert.deepEqual(sent().slice(2), [['box', 250, 'record']]);
  clock.advance(750);
  assert.deepEqual(sent(), [
    ['arm', 0, 'record'], ['box', 0, 'record'], ['box', 250, 'record'], ['arm', 500, 'record'], ['arm', 1000, 'record'],
  ]);
  assert.equal(red.retained('ps-pane/status').playing, null);
  assert.equal(clock.pending(), 0, 'nothing is left waiting');
  // the stream holds the opened record on its own time (loaded when it was opened), never what was played
  assert.deepEqual(hub.streamBuffer(), recordToMessages(twoDeviceRecord).messages);
  assert.deepEqual(messagesToRecord(hub.scene(), hub.streamBuffer()).record.traces, twoDeviceRecord.traces);
  assert.deepEqual(states(red.published)[4].payload, { at: start + 1000, joints: { j: 1 } });
});

test('stop ends a play; loop goes round again; speed 2 plays in half the time', () => {
  const { red, hub, clock } = setup();
  hub.open(twoDeviceRecord, { file: 'two', record: twoDeviceRecord });
  hub.play(twoDeviceRecord, { speed: 2 });
  clock.advance(250);
  assert.equal(states(red.published).length, 4, 'arm at 0.5 s is due at 250 ms');
  hub.stop();
  clock.advance(5000);
  assert.equal(states(red.published).length, 4);
  assert.equal(red.retained('ps-pane/status').playing, null);

  const count = states(red.published).length;
  hub.play(twoDeviceRecord, { loop: true });
  clock.advance(1000);
  assert.equal(states(red.published).length - count, 5 + 2, 'one round, and the next has begun');
  assert.notEqual(red.retained('ps-pane/status').playing, null);
  hub.stop();
  hub.close();
  assert.equal(clock.pending(), 0);
});

test('opening a record takes its devices, names and floor, keeps the background, loads its states as the stream', () => {
  const { red, hub } = setup();
  hub.setScene({ background: { kind: 'still', name: 'x.png' }, camera: { intr: { fx: 1 }, extr: { R: [] } } });
  hub.push({ topic: 'ps/local/old/state', payload: { at: 1, joints: { j: 1 } } }, 'mqtt');
  const floor = { source: 'corners', corners: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 0, z: 3 }, { x: 0, y: 0, z: 3 }] };
  const scene = hub.open({ ...twoDeviceRecord, floor, siteFrameId: 'sf-9' }, { ref: 'ada/walk', version: '2', latest: '2', own: true, record: twoDeviceRecord });
  assert.deepEqual(scene.devices.map((d) => d.id), ['arm', 'box']);
  assert.deepEqual(scene.names, { arm: 'arm', box: 'box' });
  assert.deepEqual(scene.background, { kind: 'still', name: 'x.png' });
  assert.equal(scene.camera, null, 'a camera fitted to another floor no longer fits');
  assert.deepEqual(scene.floor?.edgesM, [4, 3]);
  assert.equal(scene.siteFrameId, 'sf-9');
  assert.equal(hub.floorIsKnown(), true);
  assert.deepEqual(hub.streamBuffer(), recordToMessages(twoDeviceRecord).messages, 'the old stream is gone; the record\'s states are on its own time');
  assert.equal(red.retained('ps-pane/status').recorded, 5);
  assert.deepEqual(red.retained('ps-pane/snapshot'), []);
  assert.deepEqual(red.retained('ps-pane/status').opened, { ref: 'ada/walk', version: '2', own: true });
});

test('a kept copy shows in the status as unsent', () => {
  const userDir = tmp();
  const dir = join(userDir, 'physical-sandbox', 'unsent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'walk.record.json'), '{}');
  writeFileSync(join(dir, 'walk.send.json'), JSON.stringify({ ref: 'walk', mode: 'new', base: null }));
  const { red } = setup(userDir);
  assert.deepEqual(red.retained('ps-pane/status').unsent, [{ name: 'walk', ref: 'walk', mode: 'new' }]);
  assert.ok(existsSync(join(dir, 'walk.send.json')));
});

test('played messages never go into the stream again: half a play, speed 2 and loops leave the opened record as it was', () => {
  const { hub, clock } = setup();
  hub.open(twoDeviceRecord, { file: 'two', record: twoDeviceRecord });
  const loaded = hub.streamBuffer();
  hub.play(twoDeviceRecord);
  clock.advance(400);
  hub.stop();
  assert.deepEqual(hub.streamBuffer(), loaded, 'half a play');
  hub.play(twoDeviceRecord, { speed: 2 });
  clock.advance(2000);
  assert.deepEqual(hub.streamBuffer(), loaded, 'speed 2');
  hub.play(twoDeviceRecord, { loop: true });
  clock.advance(3500);
  hub.stop();
  assert.deepEqual(hub.streamBuffer(), loaded, 'three rounds and a half');
  // a ps play node's messages are played ones as well
  assert.equal(hub.push({ topic: 'ps/local/arm/state', payload: { at: clock.now() + 1, joints: { j: 9 } } }, 'record'), true);
  assert.deepEqual(hub.streamBuffer(), loaded);
  hub.close();
});

test('a live or agent state while a record is open takes the place of that device\'s loaded states only', () => {
  const { hub, clock } = setup();
  hub.open(twoDeviceRecord, { file: 'two', record: twoDeviceRecord });
  const at = clock.now();
  hub.push({ topic: 'ps/local/arm/state', payload: { at, joints: { j: 2 } } }, 'mqtt');
  hub.push({ topic: 'ps/local/arm/state', payload: { at: at + 500, joints: { j: 3 } } }, 'agent');
  const buffer = hub.streamBuffer();
  assert.deepEqual(buffer.filter((m) => m.topic === 'ps/local/box/state'), recordToMessages(twoDeviceRecord).messages.filter((m) => m.topic === 'ps/local/box/state'));
  assert.deepEqual(buffer.filter((m) => m.topic === 'ps/local/arm/state').map((m) => m.at), [at, at + 500]);
  const traces = messagesToRecord(hub.scene(), buffer).record.traces;
  assert.deepEqual(traces, [
    { deviceId: 'arm', samples: [{ t: 0, joints: { j: 2 } }, { t: 0.5, joints: { j: 3 } }] },
    twoDeviceRecord.traces[1],
  ]);
});

test('the status keeps the unsent list and the login it last read, until it is told to read them again', () => {
  const userDir = tmp();
  const { red, hub } = setup(userDir);
  const dir = join(userDir, 'physical-sandbox', 'unsent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'walk.record.json'), '{}');
  writeFileSync(join(dir, 'walk.send.json'), JSON.stringify({ ref: 'walk', mode: 'new', base: null }));
  hub.push({ topic: 'ps/local/arm/state', payload: { at: 1, joints: { j: 1 } } }, 'mqtt'); // publishes the status
  assert.equal(red.retained('ps-pane/status').recorded, 1);
  assert.deepEqual(red.retained('ps-pane/status').unsent, [], 'no file is read for a status about the stream');
  hub.refreshStatus();
  assert.deepEqual(red.retained('ps-pane/status').unsent, [{ name: 'walk', ref: 'walk', mode: 'new' }]);
});

test('a scene\'s background name with a path separator or .. is not taken', () => {
  for (const name of ['../x.png', 'a/b.png', 'a\\b.png', '..', 'x..png']) {
    assert.equal(normalizeScene({ background: { kind: 'still', name } }, 'local').background, null, name);
  }
  assert.deepEqual(normalizeScene({ background: { kind: 'still', name: 'site photo.png' } }, 'local').background, { kind: 'still', name: 'site photo.png' });
});

test('a message for another site than the scene\'s moves nothing: not sent, not counted, not kept, not in the snapshot', () => {
  const { red, hub, clock } = setup(tmp(), { site: 'yard' });
  for (const kind of ['state', 'command', 'event']) {
    assert.equal(hub.push({ topic: `ps/local/arm/${kind}`, payload: { at: 1, joints: { j: 1 } } }, 'mqtt'), false, kind);
  }
  clock.advance(SNAPSHOT_MS);
  assert.deepEqual(states(red.published), []);
  assert.deepEqual(hub.streamBuffer(), []);
  assert.equal(hub.status().recorded, 0);
  assert.deepEqual(red.retained('ps-pane/snapshot'), []);
  assert.equal(hub.push({ topic: 'ps/yard/arm/state', payload: { at: 1, joints: { j: 1 } } }, 'mqtt'), true);
  assert.equal(hub.status().defaultSite, 'yard', 'the status says the plugin\'s site');
});

test('a full stream says so in the status: later live states move the panes but are not kept', () => {
  const userDir = tmp();
  const red = fakeRed({ userDir });
  const clock = fakeClock();
  const hub = createHub(red.RED, { userDir, settings: readSettings({}, { userDir, env: {} }), clock, streamMax: 3, fetchImpl: async () => { throw new Error('no network'); } });
  for (let at = 1; at <= 3; at += 1) hub.push({ topic: 'ps/local/arm/state', payload: { at, joints: { j: at } } }, 'mqtt');
  assert.equal(hub.status().full, true);
  assert.equal(hub.push({ topic: 'ps/local/arm/state', payload: { at: 4, joints: { j: 4 } } }, 'mqtt'), true);
  assert.equal(hub.streamBuffer().length, 3);
  assert.equal(states(red.published).at(-1).payload.at, 4);
  clock.advance(SNAPSHOT_MS);
  assert.equal(red.retained('ps-pane/status').full, true);
  hub.clearStream();
  assert.equal(hub.status().full, false);
});

// ---- the agent's messages (playMessages) ----

test('playMessages plays the agent\'s messages from now, their at taken from the first one; bad ones by index, another site\'s skipped', () => {
  const { red, hub, clock } = setup();
  hub.open(twoDeviceRecord, { file: 'two', record: twoDeviceRecord });
  const start = clock.now();
  const played = hub.playMessages([
    { topic: 'ps/local/arm/state', payload: { at: 5066, joints: { j: 0.2 } } },
    { topic: 'ps/local/arm/state', payload: { at: 5000, joints: { j: 0.1 } } },
    'not a message',
    { topic: 'ps/local/arm', payload: { at: 1, joints: { j: 1 } } },
    { topic: 'ps/local/arm/state', payload: { joints: { j: 1 } } },
    { topic: 'ps/local/arm/state', payload: { at: 5033, joints: 'up' } },
    { topic: 'ps/yard/arm/state', payload: { at: 5000, joints: { j: 1 } } },
    { topic: 'ps/local/box/state', payload: JSON.stringify({ at: 5033, type: 'item', parent: 'site', xyz: [2, 0, 0] }) },
  ], {});
  assert.deepEqual(played.invalid.map((p) => p.index), [2, 3, 4, 5]);
  for (const p of played.invalid) assert.ok(typeof p.reason === 'string' && p.reason.length > 5, JSON.stringify(p));
  assert.match(played.invalid[1].reason, /topic/);
  assert.match(played.invalid[2].reason, /\bat\b/);
  assert.match(played.invalid[3].reason, /joints|position/);
  assert.deepEqual(played.skipped, [{ index: 6, site: 'yard' }]);
  assert.deepEqual([played.count, played.duration], [3, 0.066]);
  assert.deepEqual(red.retained('ps-pane/status').playing, { source: 'agent', t: 0, duration: 0.066 });
  const sent = () => states(red.published).map((m) => [m.topic.split('/')[2], m.at - start, m.from]);
  assert.deepEqual(sent(), [['arm', 0, 'agent']]);
  clock.advance(33);
  assert.deepEqual(sent().slice(1), [['box', 33, 'agent']]);
  clock.advance(33);
  assert.deepEqual(sent().slice(2), [['arm', 66, 'agent']]);
  assert.equal(red.retained('ps-pane/status').playing, null, 'it ends');
  // the agent's states are kept, on the clock, and take the place of the opened record's traces
  assert.deepEqual(hub.liveBuffer().map((m) => [m.topic, m.at - start]), [['ps/local/arm/state', 0], ['ps/local/box/state', 33], ['ps/local/arm/state', 66]]);
  assert.deepEqual(hub.streamBuffer().length, 3);
});

test('playMessages looping keeps the agent\'s messages once; stop ends it, and a record played or opened stops it too', () => {
  const { red, hub, clock } = setup();
  const wave = [0, 100, 200].map((at, i) => ({ topic: 'ps/local/arm/state', payload: { at, joints: { j: i / 10 } } }));
  const played = hub.playMessages(wave, { loop: true });
  assert.equal(played.count, 3);
  clock.advance(1000);
  assert.ok(states(red.published).length >= 12, 'several rounds have gone to the panes');
  assert.equal(hub.streamBuffer().length, 3, 'kept once, not once a round');
  assert.equal(hub.status().playing?.source, 'agent');
  hub.stop();
  assert.equal(hub.status().playing, null);
  const count = states(red.published).length;
  clock.advance(1000);
  assert.equal(states(red.published).length, count, 'nothing after stop');

  hub.playMessages(wave, { loop: true, speed: 2 });
  clock.advance(60);
  assert.equal(states(red.published).length - count, 2, 'at speed 2, the state at 100 ms goes at 50 ms');
  hub.play(twoDeviceRecord);
  assert.equal(hub.status().playing?.source, 'record');
  hub.stop();
  hub.playMessages(wave, { loop: true });
  hub.open(twoDeviceRecord, { file: 'two', record: twoDeviceRecord });
  assert.equal(hub.status().playing, null);
  hub.close();
  assert.equal(clock.pending(), 0);
});

test('playMessages with nothing playable plays nothing and leaves a play under way as it is', () => {
  const { hub } = setup();
  hub.playMessages([{ topic: 'ps/local/arm/state', payload: { at: 0, joints: { j: 0 } } }, { topic: 'ps/local/arm/state', payload: { at: 1000, joints: { j: 1 } } }], {});
  const played = hub.playMessages([{ topic: 'nope' }], {});
  assert.deepEqual([played.count, played.duration, played.invalid.length], [0, 0, 1]);
  assert.equal(hub.status().playing?.source, 'agent');
  hub.close();
});

test('a 60 s stream of 30 states a second with 16 joints is scheduled without holding the event loop for more than 50 ms at a time', () => {
  const userDir = tmp();
  const red = fakeRed({ userDir });
  const clock = fakeClock();
  // Every timer the hub sets is timed while it runs
  let longest = 0;
  const timed: typeof clock = {
    ...clock,
    setTimeout: (fn: () => void, ms: number) => clock.setTimeout(() => {
      const t0 = performance.now();
      fn();
      longest = Math.max(longest, performance.now() - t0);
    }, ms),
  };
  const hub = createHub(red.RED, { userDir, settings: readSettings({}, { userDir, env: {} }), clock: timed, fetchImpl: async () => { throw new Error('no network'); } });
  const joints = (k: number) => Object.fromEntries(Array.from({ length: 16 }, (_, j) => [`joint_${j + 1}`, Math.round(Math.sin(k / 10 + j) * 1000) / 1000]));
  const messages = Array.from({ length: 60 * 30 }, (_, k) => ({ topic: 'ps/local/openarm-1/state', payload: { at: Math.round(k * 1000 / 30), joints: joints(k) } }));
  const t0 = performance.now();
  const played = hub.playMessages(messages, {});
  const scheduling = performance.now() - t0;
  assert.equal(played.count, 1800);
  assert.ok(scheduling < 50, `scheduling held the loop for ${scheduling.toFixed(1)} ms`);
  for (let t = 0; t <= 60_000; t += 33) clock.advance(33);
  assert.equal(hub.status().playing, null, 'played to the end');
  assert.equal(hub.streamBuffer().length, 1800);
  assert.ok(longest < 50, `one tick held the loop for ${longest.toFixed(1)} ms`);
  hub.close();
});
