// A stream of state messages and a record are the same thing: tests for src/core/stream.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messagesToRecord, recordToMessages, mergeStreamInto } from '../src/core/stream.js';
import type { Message, Scene } from '../src/core/stream.js';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** JSON with every object's keys sorted, so two records compare byte for byte whatever their key order. */
function sortedJson(value: unknown): string {
  const sort = (v: any): any => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

const state = (site: string, name: string, payload: Record<string, unknown> & { at: number }): Message => ({
  topic: `ps/${site}/${name}/state`, payload, at: payload.at,
});

function emptyScene(over: Partial<Scene> = {}): Scene {
  return {
    site: 'local', siteFrameId: null, background: null, camera: null, floor: null,
    devices: [{ id: 'arm-1', product: 'physical-sandbox/so101:1', owner: 'external', parent: 'site',
      pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }],
    names: { 'arm-1': 'arm-1' },
    ...over,
  };
}

// The app record as the PS.com app writes one, plus what the copied fixture lacks: a floor, an item
// device with a trace (an item moves by position samples), and a key no reader here knows.
function appRecordWithItem(): any {
  const record = fixture('app-record-v3.json');
  record.floor = { source: 'corners', corners: [
    { x: 0, y: 0, z: 0, note: 'gate post' }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 1.5 }, { x: 0, y: 0, z: 1.5 }] };
  record.equipment.devices.push({ id: 'box-1', type: 'item', parent: 'site', shape: { kind: 'box', sizeM: [0.2, 0.2, 0.2] } });
  record.names['box-1'] = 'box-1';
  record.traces.push({ deviceId: 'box-1', samples: [
    { t: 0, position: [1, 0.5, 0] }, { t: 0.25, position: [1.1, 0.5, 0.05] }] });
  record._mine = { kept: ['as', 'it', 'was'] };
  return record;
}

test('a psbx record goes to messages and back with every joint sample as it was', () => {
  const record = fixture('psbx-record.json');
  const { scene, messages } = recordToMessages(record);
  assert.equal(scene.site, 'lab-1');
  assert.equal(scene.siteFrameId, 'lab-1');
  assert.deepEqual(scene.devices, record.equipment.devices);
  assert.equal(messages.length, 6);
  assert.deepEqual(messages.map((m) => m.topic), Array(6).fill('ps/lab-1/so101-1/state'));
  assert.deepEqual(messages.map((m) => m.at), [0, 100, 200, 300, 400, 500]);
  for (const m of messages) assert.equal(m.payload.at, m.at);

  const { record: back, skipped } = messagesToRecord(scene, messages);
  assert.deepEqual(skipped, []);
  assert.equal(back.traces.length, 1);
  assert.equal(back.traces[0].deviceId, 'so101-1');
  const want = record.traces[0].samples;
  assert.equal(back.traces[0].samples.length, want.length);
  want.forEach((sample: any, i: number) => assert.deepEqual(back.traces[0].samples[i], sample, `sample ${i}`));
  assert.deepEqual(back.equipment.devices, record.equipment.devices);
  assert.deepEqual(back.names, record.names);
});

test('messages start at the time the caller gives', () => {
  const { messages } = recordToMessages(fixture('psbx-record.json'), { startAt: 1_800_000_000_000, site: 'bench' });
  assert.equal(messages[0].topic, 'ps/bench/so101-1/state');
  assert.deepEqual(messages.map((m) => m.at - 1_800_000_000_000), [0, 100, 200, 300, 400, 500]);
});

test('an app record keeps its position and yaw samples and its item device', () => {
  const record = appRecordWithItem();
  const { scene, messages } = recordToMessages(record);
  assert.equal(scene.site, 'yard');
  assert.deepEqual(scene.floor?.corners, [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 1.5 }, { x: 0, y: 0, z: 1.5 }]);
  assert.deepEqual(scene.floor?.edgesM, [2, 1.5]);
  // so101-1 has a trace but no outside name in the record: it answers to its own id, on this stream only
  assert.deepEqual(scene.names, record.names);
  assert.deepEqual(scene.streamNames, { 'so101-1': 'so101-1' });

  const item = messages.filter((m) => m.topic === 'ps/yard/box-1/state');
  assert.deepEqual(item.map((m) => m.payload), [
    { at: 0, type: 'item', parent: 'site', xyz: [1, 0.5, 0] },
    { at: 250, type: 'item', parent: 'site', xyz: [1.1, 0.5, 0.05] }]);
  const mover = messages.find((m) => m.topic === 'ps/yard/a1/state');
  assert.deepEqual(mover?.payload, { at: 0, position: [0.3, -0.2, 0], yaw: 0.5 });

  const { record: back, skipped } = messagesToRecord(scene, messages);
  assert.deepEqual(skipped, []);
  const traceOf = (r: any, id: string) => r.traces.find((t: any) => t.deviceId === id)?.samples;
  for (const id of ['a1', 'so101-1', 'box-1']) assert.deepEqual(traceOf(back, id), traceOf(record, id), id);
  assert.ok(back.equipment.devices.some((d: any) => d.id === 'box-1' && d.type === 'item'));
  assert.deepEqual(back.names, record.names, 'a name given for the stream only is not written');
  assert.deepEqual(back.equipment.devices, record.equipment.devices, 'devices as the record wrote them');
  assert.deepEqual(back.floor.corners, [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 1.5 }, { x: 0, y: 0, z: 1.5 }]);
});

test('command and event messages are not kept', () => {
  const scene = emptyScene();
  const { record } = messagesToRecord(scene, [
    { topic: 'ps/local/arm-1/command', payload: { at: 0, joints: { a: 1 } }, at: 0 },
    { topic: 'ps/local/arm-1/event', payload: { at: 50, joints: { a: 1 } }, at: 50 },
    state('local', 'arm-1', { at: 100, joints: { a: 0.5 } }),
  ]);
  assert.deepEqual(record.traces, [{ deviceId: 'arm-1', samples: [{ t: 0, joints: { a: 0.5 } }] }]);
});

test('at most thirty samples a second per device', () => {
  const scene = emptyScene();
  const every10ms = Array.from({ length: 101 }, (_, i) => state('local', 'arm-1', { at: i * 10, joints: { a: i } }));
  const { record } = messagesToRecord(scene, every10ms);
  const ts = record.traces[0].samples.map((s: any) => s.t);
  assert.equal(ts[0], 0);
  assert.equal(ts[1], 0.04);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 0.033 - 1e-9);
  assert.equal(ts.length, 26);

  // A 30/s stream, and one read back from a record (its times kept to the millisecond), lose nothing
  const at30 = Array.from({ length: 31 }, (_, i) => state('local', 'arm-1', { at: (i * 1000) / 30, joints: { a: i } }));
  assert.equal(messagesToRecord(scene, at30).record.traces[0].samples.length, 31);
  const rounded = at30.map((m) => state('local', 'arm-1', { ...m.payload, at: Math.round(m.at) }));
  assert.equal(messagesToRecord(scene, rounded).record.traces[0].samples.length, 31);
});

test('at most 100000 samples per device', () => {
  const scene = emptyScene();
  const many = Array.from({ length: 100_005 }, (_, i) => state('local', 'arm-1', { at: i * 40, joints: { a: 0 } }));
  assert.equal(messagesToRecord(scene, many).record.traces[0].samples.length, 100_000);
});

test('t is seconds from the first at of each device', () => {
  const scene = emptyScene({
    devices: [
      { id: 'arm-1', product: 'physical-sandbox/so101:1', owner: 'external', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } },
      { id: 'cart-1', product: 'physical-sandbox/scout:1', owner: 'external', parent: 'site', pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } }],
    names: { 'arm-1': 'arm-1', 'cart-1': 'cart-1' },
  });
  const { record } = messagesToRecord(scene, [
    state('local', 'arm-1', { at: 1000, joints: { a: 0 } }),
    state('local', 'arm-1', { at: 1500, joints: { a: 0.1234 } }),
    state('local', 'cart-1', { at: 2000, position: [1, 0.00049, 0], yaw: 1.0006 }),
    state('local', 'arm-1', { at: 2250.4, joints: { a: 0.2 } }),
    state('local', 'cart-1', { at: 2100, position: [1.2, 0, 0] }),
  ]);
  assert.deepEqual(record.traces, [
    { deviceId: 'arm-1', samples: [{ t: 0, joints: { a: 0 } }, { t: 0.5, joints: { a: 0.123 } }, { t: 1.25, joints: { a: 0.2 } }] },
    { deviceId: 'cart-1', samples: [{ t: 0, position: [1, 0, 0], yaw: 1.001 }, { t: 0.1, position: [1.2, 0, 0] }] },
  ]);
});

test('an older at never wins', () => {
  const { record } = messagesToRecord(emptyScene(), [
    state('local', 'arm-1', { at: 500, joints: { a: 1 } }),
    state('local', 'arm-1', { at: 100, joints: { a: 2 } }),
    state('local', 'arm-1', { at: 900, joints: { a: 3 } }),
  ]);
  assert.deepEqual(record.traces[0].samples, [{ t: 0, joints: { a: 1 } }, { t: 0.4, joints: { a: 3 } }]);
});

test('an outside name goes to its device, and a name with no device is reported once', () => {
  const scene = emptyScene({ names: { left: 'arm-1' } });
  const { record, skipped } = messagesToRecord(scene, [
    state('local', 'left', { at: 0, joints: { a: 1 } }),
    state('local', 'ghost', { at: 0, joints: { a: 1 } }),
    state('local', 'ghost', { at: 100, joints: { a: 2 } }),
    state('local', 'arm-1', { at: 100, joints: { a: 2 } }),       // a device id that is not an outside name
    state('local', '__proto__', { at: 100, joints: { a: 2 } }),
  ]);
  assert.deepEqual(skipped, ['ghost', 'arm-1', '__proto__']);
  assert.deepEqual(record.traces, [{ deviceId: 'arm-1', samples: [{ t: 0, joints: { a: 1 } }] }]);
});

test('rubbish and other sites move nothing', () => {
  const { record, skipped } = messagesToRecord(emptyScene(), [
    { topic: 'not/ours', payload: { at: 0, joints: { a: 1 } }, at: 0 },
    { topic: 'ps/local/arm-1/state', payload: { joints: { a: 1 } } as any, at: 0 },
    { topic: 'ps/local/arm-1/state', payload: null as any, at: 0 },
    state('local', 'arm-1', { at: 0, yaw: 1 }),                    // a yaw needs a position or joints
    state('local', 'arm-1', { at: 0, position: [1, 2] }),
    state('other', 'arm-1', { at: 0, joints: { a: 1 } }),
  ]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(record.traces, []);
});

test('the record carries its frame, floor, markers, site and names', () => {
  const scene = emptyScene({
    site: 'yard', siteFrameId: 'yard-frame',
    floor: { corners: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 3, y: 0, z: 2 }, { x: 0, y: 0, z: 2 }], edgesM: [3, 2] },
  });
  const { record } = messagesToRecord(scene, [], { title: 'morning run', basedOn: 'someone/run:2' });
  assert.equal(record.schemaVersion, 3);
  assert.deepEqual(record.frame, { frameId: 'site', up: '+Y', unit: 'm' });
  assert.deepEqual(record.markers, [{ id: '1', x: 0, y: 0, z: 0 }, { id: '2', x: 3, y: 0, z: 0 }]);
  assert.deepEqual(record.floor, { source: 'corners', corners: scene.floor!.corners });
  assert.equal(record.siteFrameId, 'yard-frame');
  assert.deepEqual(record.equipment, { site: { id: 'yard' }, devices: scene.devices });
  assert.deepEqual(record.names, scene.names);
  assert.deepEqual(record.traces, []);
  assert.deepEqual(record.routes, []);
  assert.equal(record.name, 'morning run');
  assert.equal(record.basedOn, 'someone/run:2');

  const bare = messagesToRecord(emptyScene(), []).record;
  assert.deepEqual(bare.markers, []);
  assert.equal('floor' in bare, false);
  assert.equal('siteFrameId' in bare, false);
  assert.equal('name' in bare, false);
});

test('saving over a record replaces only the traces the stream carried and the poses the scene moved', () => {
  const base = appRecordWithItem();
  base.equipment.devices[0].pose = { xyz: [0.3, -0.2, 0.75], rpy: [0.02, 0.03, 0.5] };   // a1 on a table, tilted
  const before = sortedJson(base);
  const { scene } = recordToMessages(base);

  // The scene moved a1 (x, y and yaw; its z, roll and pitch say something else here) and the stream
  // carried so101-1 only
  const a1 = scene.devices.find((d) => d.id === 'a1')!;
  a1.pose = { xyz: [1.25, 0.5, 0], rpy: [0, 0, -1.2] };
  const stream = [
    state('yard', 'so101-1', { at: 10_000, joints: { turn: 0.3 } }),
    state('yard', 'so101-1', { at: 10_500, joints: { turn: 0.4 } }),
  ];
  const merged = mergeStreamInto(base, scene, stream);

  assert.equal(sortedJson(base), before, 'the base is not changed');
  const want = JSON.parse(JSON.stringify(base));
  want.equipment.devices[0].pose = { xyz: [1.25, 0.5, 0.75], rpy: [0.02, 0.03, -1.2] };
  want.traces.find((t: any) => t.deviceId === 'so101-1').samples = [{ t: 0, joints: { turn: 0.3 } }, { t: 0.5, joints: { turn: 0.4 } }];
  assert.equal(sortedJson(merged), sortedJson(want));
});

test('saving over keeps a pose the scene did not move, and adds the trace of a device that had none', () => {
  const base = fixture('psbx-record.json');
  base.traces = [];
  const before = sortedJson(base);
  const { scene } = recordToMessages(base);
  const merged = mergeStreamInto(base, scene, [
    state('lab-1', 'so101-1', { at: 0, joints: { shoulder_pan: 1 } }),
  ]);
  const want = JSON.parse(before);
  want.traces = [{ deviceId: 'so101-1', samples: [{ t: 0, joints: { shoulder_pan: 1 } }] }];
  assert.equal(sortedJson(merged), sortedJson(want));

  const untouched = mergeStreamInto(fixture('psbx-record.json'), recordToMessages(fixture('psbx-record.json')).scene, []);
  assert.equal(sortedJson(untouched), sortedJson(fixture('psbx-record.json')));
});

test('a bare product names a local machine and stays bare, new or saved over', () => {
  const record = fixture('psbx-record.json');
  record.equipment.devices[0].product = 'so101';
  record.equipment.devices[0].endEffector = 'gripper';
  const { scene, messages } = recordToMessages(record);
  assert.equal(scene.devices[0].product, 'so101');
  assert.equal(scene.devices[0].endEffector, 'gripper');
  const { record: asNew } = messagesToRecord(scene, messages);
  assert.equal(asNew.equipment.devices[0].product, 'so101');
  assert.equal(asNew.equipment.devices[0].endEffector, 'gripper');
  const over = mergeStreamInto(record, scene, messages);
  assert.equal(over.equipment.devices[0].product, 'so101');
  assert.equal(over.equipment.devices[0].endEffector, 'gripper');

  // A version 2 record: a device of the equipment and a robot placed by hand, both bare
  const v2 = {
    schemaVersion: 2,
    markers: [{ id: 'm1', x: 0, y: 0, z: 0 }, { id: 'm2', x: 1, y: 0, z: 0 }],
    equipment: { site: { id: 'yard' }, devices: [{ id: 'cam-1', product: 'mycam', parent: 'site' }] },
    placements: [{ assetId: 'a1', robotId: 'mybot', x: 1, y: 0, z: 0, yaw: 0 }],
    traces: [],
  };
  const old = recordToMessages(v2);
  assert.deepEqual(old.scene.devices.map((d) => d.product), ['mycam', 'mybot']);
  const merged = mergeStreamInto(v2, old.scene, [state('yard', 'a1', { at: 0, position: [1, 0, 0] })]);
  assert.deepEqual(merged.equipment.devices.map((d: any) => d.product), ['mycam', 'mybot']);
  assert.equal(merged.schemaVersion, 3);
  assert.deepEqual(merged.traces, [{ deviceId: 'a1', samples: [{ t: 0, position: [1, 0, 0] }] }]);
  assert.equal(v2.equipment.devices[0].product, 'mycam', 'the record given is not changed');
});
