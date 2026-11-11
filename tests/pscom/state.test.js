import test from 'node:test';
import assert from 'node:assert/strict';
import { topicFor, parseTopic, decode, newStore, applyState, amountOf, amountsOf, stateOf, jointsOf, isTopicName } from '../../src/pscom/state.js';

// PS.com's devices/registry.js is not part of the copied set. The tests only need the device
// objects as the state code reads them, so this stand-in hands the written devices back by id.
const parseDevices = (list) => ({ devices: new Map(list.map((device) => [device.id, device])) });

const { devices } = parseDevices([
  { id: 'gate-1', type: 'equipment', displayName: 'Gate',
    states: { open: {}, closed: {} }, transitionS: 3 },
  { id: 'water-1', type: 'substance', displayName: 'Water',
    render: { kind: 'surface' }, region: { kind: 'box', sizeM: [12, 6, 2.5] },
    unit: 'm', max: 2.5 },
]);
const gate = devices.get('gate-1');
const water = devices.get('water-1');

test('builds and reads back a topic', () => {
  assert.equal(topicFor('yard', 'gate-1', 'command'), 'ps/yard/gate-1/command');
  assert.deepEqual(parseTopic('ps/yard/gate-1/command'), { site: 'yard', id: 'gate-1', kind: 'command' });
});

test('a topic that is not ours comes back as null', () => {
  assert.equal(parseTopic('homeassistant/light/1/set'), null);
  assert.equal(parseTopic('ps/yard/gate-1'), null);
  assert.equal(parseTopic('ps/yard/gate-1/other'), null);
});

// A broker carries whatever anyone publishes. None of it can be trusted to be ours
test('rubbish decodes to null instead of throwing', () => {
  assert.equal(decode('not json'), null);
  assert.equal(decode('[1,2]'), null);
  assert.equal(decode('"a string"'), null);
  assert.equal(decode('{"state":"open"}'), null);        // no at
  assert.equal(decode('{"at":"now","state":"open"}'), null);
  assert.deepEqual(decode('{"at":5,"state":"open"}'), { at: 5, state: 'open' });
});

test('keeps the state of an equipment', () => {
  const store = newStore();
  assert.equal(applyState(store, gate, { at: 5, state: 'closed' }), true);
  assert.equal(stateOf(store, 'gate-1'), 'closed');
});

test('a state an equipment does not have is refused', () => {
  const store = newStore();
  assert.equal(applyState(store, gate, { at: 5, state: 'flying' }), false);
  assert.equal(stateOf(store, 'gate-1'), undefined);
});

// Several of them start at once and the order gets swapped, so an older one must not win
test('drops a state older than the one it has', () => {
  const store = newStore();
  applyState(store, gate, { at: 10, state: 'closed' });
  assert.equal(applyState(store, gate, { at: 9, state: 'open' }), false);
  assert.equal(stateOf(store, 'gate-1'), 'closed');
  assert.equal(applyState(store, gate, { at: 11, state: 'open' }), true);
  assert.equal(stateOf(store, 'gate-1'), 'open');
});

test('keeps the amount of a substance and holds it inside its range', () => {
  const store = newStore();
  applyState(store, water, { at: 1, amount: 0.42 });
  assert.equal(amountOf(store, 'water-1'), 0.42);
  applyState(store, water, { at: 2, amount: 99 });
  assert.equal(amountOf(store, 'water-1'), 2.5);      // max
  applyState(store, water, { at: 3, amount: -1 });
  assert.equal(amountOf(store, 'water-1'), 0);
});

test('an amount that is not a number is refused', () => {
  const store = newStore();
  assert.equal(applyState(store, water, { at: 1, amount: 'deep' }), false);
  assert.equal(amountOf(store, 'water-1'), 0);
});

// --- A substance with outlets keeps a volume each ---

const { devices: withOutlets } = parseDevices([
  { id: 'soil-1', type: 'substance', render: { kind: 'surface' }, region: { kind: 'box', sizeM: [10, 10, 1] },
    phase: 'granular', reposeDeg: 34, max: 10,
    outlets: [{ id: 'a', xy: [0, 0] }, { id: 'b', xy: [2, 0] }] },
]);
const soil = withOutlets.get('soil-1');

test('a substance with outlets keeps a volume per outlet, and its amount is their sum', () => {
  const store = newStore();
  applyState(store, soil, { at: 1, outlets: { a: 2, b: 3 } });
  assert.equal(amountOf(store, 'soil-1'), 5);
  assert.deepEqual(amountsOf(store, 'soil-1'), { total: 5, outlets: { a: 2, b: 3 } });
  // An outlet not named keeps what it had
  applyState(store, soil, { at: 2, outlets: { b: 1 } });
  assert.deepEqual(amountsOf(store, 'soil-1').outlets, { a: 2, b: 1 });
});

test('an amount with no outlets named all goes to the first one', () => {
  const store = newStore();
  applyState(store, soil, { at: 1, amount: 4 });
  assert.deepEqual(amountsOf(store, 'soil-1'), { total: 4, outlets: { a: 4, b: 0 } });
});

// The one that was just added to is the one that stops, not the others
test('the total is held to max by what was just named', () => {
  const store = newStore();
  applyState(store, soil, { at: 1, outlets: { a: 6 } });
  applyState(store, soil, { at: 2, outlets: { b: 9 } });
  assert.deepEqual(amountsOf(store, 'soil-1'), { total: 10, outlets: { a: 6, b: 4 } });
  assert.equal(applyState(store, soil, { at: 3 }), false);
});

test('an item keeps which parent it is on and where on it', async () => {
  const { whereOf } = await import('../../src/pscom/state.js');
  const { devices: withItem } = parseDevices([
    { id: 'box-1', type: 'item', shape: { sizeM: [0.3, 0.3, 0.3] }, parent: 'site', pose: { xyz: [0, 0, 0.15] } },
  ]);
  const box = withItem.get('box-1');
  const store = newStore();
  assert.equal(applyState(store, box, { at: 1, parent: 'conv-1', xyz: [-2, 0, 0.15] }), true);
  assert.deepEqual(whereOf(store, 'box-1'), { at: 1, parent: 'conv-1', xyz: [-2, 0, 0.15] });
  assert.equal(applyState(store, box, { at: 2, parent: '', xyz: [0, 0, 0] }), false);
  assert.equal(applyState(store, box, { at: 2, parent: 'site', xyz: [0, 0] }), false);
  assert.equal(applyState(store, box, { at: 0, parent: 'site', xyz: [0, 0, 0] }), false, 'an older at never wins');
  assert.equal(whereOf(store, 'nobody'), undefined);
});

test('a name is one topic segment: any language, but no level separator, wildcard or control character', () => {
  for (const name of ['gate-1', 'ゲート1', 'cam.2']) assert.equal(isTopicName(name), true, name);
  for (const name of ['', 'a/b', 'a+', '#', '$SYS', 'a\u0000b', '__proto__', 'constructor', 'x'.repeat(81), 7, null]) {
    assert.equal(isTopicName(name), false, JSON.stringify(name));
  }
  assert.equal(isTopicName('x'.repeat(80)), true);
});

// ---- A mover's joints (the design of 2026-10-05) ----

const arm = { id: 'so101', type: 'mover', robotId: 'so101', speedMps: 0.5 };

test('a mover takes joint angles with no position', () => {
  const store = newStore();
  assert.equal(applyState(store, arm, { at: 1, joints: { shoulder_pan: 0.5, gripper: 0.2 } }), true);
  assert.deepEqual(jointsOf(store, 'so101'), { shoulder_pan: 0.5, gripper: 0.2 });
});

test('joints that are not numbers are dropped, the rest kept', () => {
  const store = newStore();
  assert.equal(applyState(store, arm, { at: 1, joints: { a: 1, b: 'x', c: null, d: Infinity } }), true);
  assert.deepEqual(jointsOf(store, 'so101'), { a: 1 });
});

test('a joint not named keeps the angle it had', () => {
  const store = newStore();
  applyState(store, arm, { at: 1, joints: { a: 1, b: 2 } });
  applyState(store, arm, { at: 2, joints: { b: 3 } });
  assert.deepEqual(jointsOf(store, 'so101'), { a: 1, b: 3 });
});

test('a position and joints may come together, and either alone keeps the other', () => {
  const store = newStore();
  applyState(store, arm, { at: 1, position: [1, 2, 3], joints: { a: 1 } });
  applyState(store, arm, { at: 2, joints: { a: 2 } });
  assert.deepEqual(store.get('so101').position, [1, 2, 3]);
  applyState(store, arm, { at: 3, position: [4, 5, 6] });
  assert.deepEqual(jointsOf(store, 'so101'), { a: 2 });
});

test('a mover state with neither a position nor a joint is refused', () => {
  const store = newStore();
  assert.equal(applyState(store, arm, { at: 1 }), false);
  assert.equal(applyState(store, arm, { at: 1, joints: { a: 'x' } }), false);
  assert.equal(applyState(store, arm, { at: 1, joints: [1, 2] }), false);
  assert.equal(applyState(store, arm, { at: 1, position: [1, 2] }), false);
});

test('an older joint state never wins', () => {
  const store = newStore();
  applyState(store, arm, { at: 5, joints: { a: 1 } });
  assert.equal(applyState(store, arm, { at: 4, joints: { a: 9 } }), false);
  assert.deepEqual(jointsOf(store, 'so101'), { a: 1 });
});

test('joint names that would shadow an object are dropped', () => {
  const store = newStore();
  applyState(store, arm, { at: 1, joints: JSON.parse('{"__proto__": 1, "constructor": 2, "a": 3}') });
  assert.deepEqual(jointsOf(store, 'so101'), { a: 3 });
});

// ---- A mover's heading (plan 2/3: a placed robot is a mover) ----

test('a mover state carries its yaw, and a message without one keeps it', () => {
  const store = newStore();
  assert.equal(applyState(store, arm, { at: 1, position: [1, 2, 0], yaw: 0.5 }), true);
  assert.deepEqual(store.get('so101'), { at: 1, position: [1, 2, 0], yaw: 0.5, joints: {} });
  applyState(store, arm, { at: 2, position: [2, 2, 0] });
  assert.equal(store.get('so101').yaw, 0.5);
  applyState(store, arm, { at: 3, joints: { a: 1 } });
  assert.equal(store.get('so101').yaw, 0.5);
  applyState(store, arm, { at: 4, position: [2, 2, 0], yaw: -1 });
  assert.equal(store.get('so101').yaw, -1);
});

test('a yaw that is not a number is refused, and a yaw alone is not a state', () => {
  const store = newStore();
  assert.equal(applyState(store, arm, { at: 1, position: [1, 2, 0], yaw: 'north' }), false);
  assert.equal(applyState(store, arm, { at: 1, position: [1, 2, 0], yaw: Infinity }), false);
  assert.equal(applyState(store, arm, { at: 1, yaw: 0.5 }), false);
  assert.equal(store.get('so101'), undefined);
});
