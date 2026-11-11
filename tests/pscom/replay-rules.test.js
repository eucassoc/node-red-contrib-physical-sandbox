import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frameFor, replayPlan, replayStarts, runReplayStart, replayIsOver, withoutTraceOf, deviceSeries, deviceSampleAt,
  newClock, clockElapsedS, pauseClock, resumeClock, seekClock, speedClock, seekable, replayWalkIds, runReplayStop, replayBar,
  rollBetween, ROLL_MAX_DT_S,
} from '../../src/pscom/replay-rules.js';

// A stand-in frame: frameFor never looks inside it, only passes it through unchanged.
const A_FRAME = { origin: { x: 0, y: 0, z: 0 }, yaw: -Math.PI / 2 };

const SCOUT = { id: 'scout-1', product: 'scout', owner: 'viewer', parent: 'site', pose: { xyz: [1, -2, 0], rpy: [0, 0, 0.5] } };
// An older recording's robot, upgraded: it kept the asset id it had
const UPGRADED = { id: 'a1', product: 'go2', owner: 'viewer', parent: 'site', pose: { xyz: [0, 1, 0], rpy: [0, 0, -1] } };
const ARM_TRACE = { deviceId: 'so101', samples: [{ t: 0, joints: { a: 0 } }, { t: 1, joints: { a: 1 } }] };
const MOVER_TRACE = { deviceId: 'drone-1', samples: [{ t: 0, position: [0, 0, 1], yaw: 0 }] };
const SCOUT_TRACE = { deviceId: 'scout-1', samples: [{ t: 0, position: [1, -2, 0], yaw: 0.5 }] };

const recording = () => ({
  schemaVersion: 3,
  equipment: {
    site: { id: 'yard' },
    devices: [
      { id: 'gate-1', type: 'equipment', owner: 'viewer' },
      { id: 'so101', product: 'so101', owner: 'external', parent: 'site', pose: { xyz: [0, 0, 0] } },
      { id: 'drone-1', product: 'quadrotor', owner: 'viewer', parent: 'site', pose: { xyz: [2, 2, 1] } },
      SCOUT,
      UPGRADED,
    ],
  },
  names: {},
  routes: [
    // Its device is not in the equipment: nothing stands to walk it (schema rule 10)
    { routeId: 'r-other-1', deviceId: 'other-1', waypoints: [{ order: 0, t: 0, position: [9, -9, 0] }] },
    { routeId: 'r-scout-1', deviceId: 'scout-1', waypoints: [
      { order: 1, t: 2, position: [3, -3, 0] },
      { order: 0, t: 1, position: [2, -2, 0] },
    ] },
    { routeId: 'r-a1', deviceId: 'a1', waypoints: [{ order: 0, t: 0, position: [4, 1, 0] }] },
  ],
  traces: [ARM_TRACE, SCOUT_TRACE, MOVER_TRACE],
});

test('every device with a route replays from its recorded pose, its points in the order they were given', () => {
  const { plan, problem } = replayPlan(recording());
  assert.equal(problem, null);
  // ROS, as written: the stage lays them onto its frame
  assert.deepEqual(plan.routes, [
    { deviceId: 'scout-1', pose: SCOUT.pose, points: [{ position: [2, -2, 0] }, { position: [3, -3, 0] }] },
    { deviceId: 'a1', pose: UPGRADED.pose, points: [{ position: [4, 1, 0] }] },
  ]);
});

test('a route whose device is not in the equipment is skipped', () => {
  const { plan } = replayPlan(recording());
  assert.ok(!plan.routes.some((route) => route.deviceId === 'other-1'));
  assert.ok(!plan.deviceIds.includes('other-1'));
});

test('a device with both a route and a trace replays its route only; the traces of devices without one are device traces', () => {
  const { plan } = replayPlan(recording());
  assert.deepEqual(plan.deviceTraces, [ARM_TRACE, MOVER_TRACE]);
  assert.deepEqual(plan.deviceIds, ['scout-1', 'a1', 'so101', 'drone-1']);
});

test('a route with no waypoints is not a route to replay', () => {
  const project = recording();
  project.routes[2].waypoints = [];
  const { plan } = replayPlan(project);
  assert.deepEqual(plan.routes.map((route) => route.deviceId), ['scout-1']);
});

test('a recording with only a device trace can be replayed, and the plan carries the trace', () => {
  const { plan, problem } = replayPlan({ traces: [ARM_TRACE] });
  assert.equal(problem, null);
  assert.deepEqual(plan.routes, []);
  assert.deepEqual(plan.deviceTraces, [ARM_TRACE]);
});

test('no route and no device trace: nothing to replay, and the reason is a key', () => {
  assert.equal(replayPlan({}).problem, 'ar.noReplayPath');
  assert.equal(replayPlan(null).plan, null);
  assert.equal(replayPlan({ equipment: { site: { id: 's' }, devices: [SCOUT] } }).problem, 'ar.noReplayPath');
  // A route of a device that is not there, an empty route, an empty trace: none of them count
  const nothing = recording();
  nothing.routes = [nothing.routes[0], { deviceId: 'a1', waypoints: [] }];
  nothing.traces = [{ deviceId: 'so101', samples: [] }];
  assert.equal(replayPlan(nothing).problem, 'ar.noReplayPath');
  // A robot's own trace with its route gone is a trace like any other
  const walked = { ...recording(), routes: [], traces: [SCOUT_TRACE] };
  assert.deepEqual(replayPlan(walked).plan.deviceTraces, [SCOUT_TRACE]);
});

test('the start: what is replayed stops first, each standing route device is put at its pose and sent along its points', () => {
  const { plan } = replayPlan(recording());
  const standing = new Set(['scout-1', 'a1', 'so101']);
  const starts = replayStarts(plan, (id) => standing.has(id));
  // A running drive is not left to fight the replay — of a route device or of a traced one
  assert.deepEqual(starts.stops, ['scout-1', 'a1', 'so101']);
  assert.deepEqual(starts.starts, [
    { deviceId: 'scout-1', place: { position: [1, -2, 0], yaw: 0.5 }, points: [[2, -2, 0], [3, -3, 0]], target: [3, -3, 0] },
    { deviceId: 'a1', place: { position: [0, 1, 0], yaw: -1 }, points: [[4, 1, 0]], target: [4, 1, 0] },
  ]);
  // Not standing here: nothing to pose
  assert.deepEqual(starts.traces, [ARM_TRACE]);
  assert.deepEqual(starts.skipped, []);
});

test('a route device that is not standing is skipped and named; one with no turn faces 0, one with no pose starts where it is', () => {
  const plan = {
    routes: [
      { deviceId: 'gone', pose: { xyz: [0, 0, 0] }, points: [{ position: [1, 0, 0] }] },
      { deviceId: 'flat', pose: { xyz: [1, 1, 0] }, points: [{ position: [2, 0, 0] }] },
      { deviceId: 'loose', points: [{ position: [3, 0, 0] }] },
    ],
    deviceTraces: [],
    deviceIds: ['gone', 'flat', 'loose'],
  };
  const starts = replayStarts(plan, (id) => id !== 'gone');
  assert.deepEqual(starts.skipped, ['gone']);
  assert.deepEqual(starts.stops, ['flat', 'loose']);
  assert.deepEqual(starts.starts.map((s) => s.place), [{ position: [1, 1, 0], yaw: 0 }, null]);
});

test('the start copies the plan: moving what it hands out does not move the recording', () => {
  const { plan } = replayPlan(recording());
  const { starts } = replayStarts(plan, () => true);
  starts[0].place.position[0] = 99;
  starts[0].points[0][0] = 99;
  assert.deepEqual(SCOUT.pose.xyz, [1, -2, 0]);
  assert.deepEqual(plan.routes[0].points[0].position, [2, -2, 0]);
});

// A page stand-in: the state app.js keeps, its finishReplayIfDone over replayIsOver, and an
// onObserved that records only when no replay is running — the calls the start makes go here.
function fakePage({ nowhere = [] } = {}) {
  const page = { replaying: false, starting: false, walks: new Map(), deviceReplay: null, recorded: [], said: [] };
  const observed = (id) => { if (!page.replaying) page.recorded.push(id); };
  page.observe = observed;
  page.finish = ({ say = true } = {}) => {
    if (!replayIsOver(page)) return false;
    page.replaying = false;
    if (say) page.said.push('ar.replayDone');
    return true;
  };
  page.io = {
    begin() { page.deviceReplay = null; page.replaying = true; },
    setStarting(starting) { page.starting = starting; },
    stop(id) { page.walks.delete(id); observed(id); },
    beginTraces(traces) { page.deviceReplay = { parts: traces.map((trace) => ({ id: trace.deviceId })) }; },
    place(id) { observed(id); },
    // As driveTo: a drive that goes nowhere asks whether the replay is over, at once
    drive({ deviceId }) {
      observed(deviceId);
      if (nowhere.includes(deviceId)) { page.finish(); return; }
      page.walks.set(deviceId, { replay: true });
    },
    settle() { return !page.finish({ say: false }); },
  };
  return page;
}

test('a route that goes nowhere does not end the replay while the next one is still to start', () => {
  const plan = {
    routes: [
      { deviceId: 'held', pose: { xyz: [0, 0, 0] }, points: [{ position: [1, 0, 0] }] },
      { deviceId: 'scout-1', pose: { xyz: [1, 0, 0] }, points: [{ position: [2, 0, 0] }] },
    ],
    deviceTraces: [],
    deviceIds: ['held', 'scout-1'],
  };
  const page = fakePage({ nowhere: ['held'] });
  assert.equal(runReplayStart(replayStarts(plan, () => true), page.io), true);
  assert.equal(page.replaying, true);
  assert.equal(page.starting, false);
  assert.deepEqual(page.said, []);
  // Frames go by while scout-1 drives: still a replay, and what it reports is not recorded
  page.observe('scout-1');
  assert.equal(page.finish(), false);
  page.walks.delete('scout-1');
  assert.equal(page.finish(), true);
  assert.deepEqual(page.said, ['ar.replayDone']);
  assert.deepEqual(page.recorded, []);
});

test('when nothing could start, the start ends the replay once and says nothing of it finishing', () => {
  const plan = {
    routes: [{ deviceId: 'held', pose: { xyz: [0, 0, 0] }, points: [{ position: [1, 0, 0] }] }],
    deviceTraces: [],
    deviceIds: ['held'],
  };
  const page = fakePage({ nowhere: ['held'] });
  assert.equal(runReplayStart(replayStarts(plan, () => true), page.io), false);
  assert.equal(page.replaying, false);
  assert.deepEqual(page.said, []);
  assert.deepEqual(page.recorded, []);
});

test('the traces start before the drives, so a drive that goes nowhere leaves them running', () => {
  const plan = {
    routes: [{ deviceId: 'held', pose: { xyz: [0, 0, 0] }, points: [{ position: [1, 0, 0] }] }],
    deviceTraces: [ARM_TRACE],
    deviceIds: ['held', 'so101'],
  };
  const page = fakePage({ nowhere: ['held'] });
  assert.equal(runReplayStart(replayStarts(plan, () => true), page.io), true);
  assert.deepEqual(page.deviceReplay.parts.map((part) => part.id), ['so101']);
});

test('a replay is over only when it runs, is not starting, nothing it sent is going and no trace runs', () => {
  const quiet = { replaying: true, starting: false, walks: new Map(), deviceReplay: null };
  assert.equal(replayIsOver(quiet), true);
  assert.equal(replayIsOver({ ...quiet, replaying: false }), false);
  assert.equal(replayIsOver({ ...quiet, starting: true }), false);
  assert.equal(replayIsOver({ ...quiet, deviceReplay: { parts: [] } }), false);
  assert.equal(replayIsOver({ ...quiet, walks: new Map([['a', { replay: true }]]) }), false);
  // A person's own drive is not part of the replay
  assert.equal(replayIsOver({ ...quiet, walks: new Map([['a', { replay: false }]]) }), true);
});

test('a person\'s drive takes its device out of the trace replay; the rest keeps running', () => {
  const replay = { startedAt: 5, parts: [{ id: 'drone-1', series: {} }, { id: 'so101', series: {} }] };
  assert.deepEqual(withoutTraceOf(replay, 'drone-1'), { startedAt: 5, parts: [{ id: 'so101', series: {} }] });
  assert.equal(replay.parts.length, 2);
  // Not a traced device: the replay is the same one
  assert.equal(withoutTraceOf(replay, 'scout-1'), replay);
  // The last trace taken out: nothing of the device replay is left
  assert.equal(withoutTraceOf({ startedAt: 5, parts: [{ id: 'so101', series: {} }] }, 'so101'), null);
  assert.equal(withoutTraceOf(null, 'so101'), null);
});

test('the frame is whatever windowFrame the caller passes, unchanged', () => {
  assert.deepEqual(frameFor({ windowFrame: A_FRAME }).frame, A_FRAME);
  const moved = { origin: { x: 3, y: 0, z: 4 }, yaw: 1 };
  assert.equal(frameFor({ windowFrame: moved }).frame, moved);
});

test('with no window frame, the frame comes from the two markers, and one marker is not enough', () => {
  const markers = [{ position: { x: 0, y: 0, z: 0 } }, { position: { x: 2, y: 0, z: 0 } }];
  const { frame, problem } = frameFor({ markers });
  assert.equal(problem, null);
  assert.equal(frame.spanM, 2);
  assert.equal(frameFor({ markers: markers.slice(0, 1) }).problem, 'ar.markerNeedTwo');
});

const DEVICE_TRACE = { deviceId: 'so101', samples: [
  { t: 0, position: [0, 0, 0], joints: { a: 0, b: 1 } },
  { t: 1, joints: { a: 1 } },
  { t: 2, position: [2, 0, 0], joints: { a: 2, b: 3 } },
] };

test('the series splits what each sample carried, and the end is the last time', () => {
  const series = deviceSeries(DEVICE_TRACE.samples);
  assert.deepEqual(series.position.map((p) => p.t), [0, 2]);
  assert.deepEqual(series.joints.a.map((p) => p.t), [0, 1, 2]);
  assert.deepEqual(series.joints.b.map((p) => p.t), [0, 2]);
  assert.deepEqual(series.yaw, []);
  assert.equal(series.endT, 2);
});

test('a sample at a time is interpolated per field, and held at the ends', () => {
  const series = deviceSeries(DEVICE_TRACE.samples);
  assert.deepEqual(deviceSampleAt(series, 1), { position: [1, 0, 0], yaw: null, joints: { a: 1, b: 2 } });
  assert.deepEqual(deviceSampleAt(series, -5), { position: [0, 0, 0], yaw: null, joints: { a: 0, b: 1 } });
  assert.deepEqual(deviceSampleAt(series, 9), { position: [2, 0, 0], yaw: null, joints: { a: 2, b: 3 } });
});

test('a device that never said where it is gives no position', () => {
  const series = deviceSeries([{ t: 0, joints: { a: 0 } }, { t: 1, joints: { a: 2 } }]);
  assert.deepEqual(deviceSampleAt(series, 0.5), { position: null, yaw: null, joints: { a: 1 } });
});

test('a mover\'s yaw is a run of its own, turned the short way round between two samples', () => {
  const series = deviceSeries([
    { t: 0, position: [0, 0, 0], yaw: 0 },
    { t: 1, position: [1, 0, 0], yaw: 1 },
    { t: 2, position: [1, 1, 0], yaw: 3 },
    { t: 3, yaw: -3 },
  ]);
  assert.deepEqual(series.yaw.map((p) => p.t), [0, 1, 2, 3]);
  assert.equal(deviceSampleAt(series, 0.5).yaw, 0.5);
  // From 3 to -3 is 0.28 rad through ±π, not 6 rad back through 0
  const across = deviceSampleAt(series, 2.5).yaw;
  assert.ok(Math.abs(Math.abs(across) - Math.PI) < 1e-9, `${across}`);
  assert.equal(deviceSampleAt(series, 9).yaw, -3);
});

test('the replay clock runs, pauses, seeks and changes speed without touching the given one', () => {
  const c0 = newClock(1000);
  assert.deepEqual(c0, { startedAt: 1000, speed: 1, pausedAt: null, offsetS: 0 });
  assert.equal(clockElapsedS(c0, 3000), 2);
  const paused = pauseClock(c0, 3000);
  assert.equal(clockElapsedS(paused, 9000), 2);
  const resumed = resumeClock(paused, 9000);
  assert.equal(clockElapsedS(resumed, 10000), 3);
  const sought = seekClock(c0, 12.5, 3000);
  assert.equal(clockElapsedS(sought, 4000), 13.5);
  const fast = speedClock(c0, 2, 3000);
  assert.equal(clockElapsedS(fast, 4000), 4); // 2 s at 1x, then 1 s at 2x
  assert.equal(speedClock(c0, 0, 3000), c0); // refused: unchanged
  assert.equal(speedClock(c0, 10.5, 3000), c0);
  assert.equal(speedClock(c0, Number.NaN, 3000), c0);
  assert.equal(c0.pausedAt, null); // never mutated
  assert.deepEqual(c0, { startedAt: 1000, speed: 1, pausedAt: null, offsetS: 0 });
});

test('a paused clock stays paused through a seek and a change of speed, and pausing twice changes nothing', () => {
  const paused = pauseClock(newClock(0), 2000);
  assert.equal(pauseClock(paused, 5000), paused);
  const sought = seekClock(paused, 7, 6000);
  assert.equal(clockElapsedS(sought, 60000), 7);
  const fast = speedClock(sought, 4, 61000);
  assert.equal(clockElapsedS(fast, 90000), 7);
  assert.equal(clockElapsedS(resumeClock(fast, 100000), 101000), 11); // 7 s, then 1 s at 4x
  const running = newClock(0);
  assert.equal(resumeClock(running, 5000), running); // not paused: nothing to resume
});

test('a recording with a route is not seekable; one with only traces is', () => {
  assert.equal(seekable(replayPlan(recording()).plan), false);
  assert.equal(seekable(replayPlan({ traces: [ARM_TRACE, MOVER_TRACE] }).plan), true);
});

test('the replay\'s own walks are the ones it sent, read without changing the walks', () => {
  const walks = new Map([['scout-1', { replay: true }], ['go2-1', { replay: false }], ['a1', { replay: true }]]);
  assert.deepEqual(replayWalkIds(walks), ['scout-1', 'a1']);
  assert.equal(walks.size, 3);
});

test('stopping a replay stops the drives it sent, not a person\'s, drops the traces and then asks whether it is over', () => {
  const walks = new Map([['scout-1', { replay: true }], ['go2-1', { replay: false }], ['a1', { replay: true }]]);
  const page = { replaying: true, walks, deviceReplay: { clock: pauseClock(newClock(0), 1), parts: [] } };
  const calls = [];
  const io = {
    stop(id) { calls.push(['stop', id]); page.walks.delete(id); },
    dropTraces() { calls.push(['dropTraces']); page.deviceReplay = null; },
    finish() {
      calls.push(['finish']);
      if (replayIsOver({ replaying: page.replaying, starting: false, walks: page.walks, deviceReplay: page.deviceReplay })) page.replaying = false;
    },
  };
  // A paused trace replay holds the replay on until it is stopped
  assert.equal(replayIsOver({ ...page, starting: false }), false);
  assert.deepEqual(runReplayStop({ replaying: page.replaying, walks }, io), { problem: null });
  assert.deepEqual(calls, [['stop', 'scout-1'], ['stop', 'a1'], ['dropTraces'], ['finish']]);
  assert.equal(page.replaying, false);
  assert.deepEqual([...walks.keys()], ['go2-1']);
});

test('stopping with nothing replaying touches nothing', () => {
  const calls = [];
  const io = { stop: (id) => calls.push(id), dropTraces: () => calls.push('drop'), finish: () => calls.push('finish') };
  assert.deepEqual(runReplayStop({ replaying: false, walks: new Map([['a1', { replay: true }]]) }, io), { problem: 'replay.notReplaying' });
  assert.deepEqual(calls, []);
});

test('the bar offers Replay when nothing replays, nothing while one runs, and Resume with Stop while one is paused', () => {
  assert.deepEqual(replayBar({ replaying: false, paused: false }), { replay: 'replay', stop: false });
  assert.deepEqual(replayBar({ replaying: true, paused: false }), { replay: 'busy', stop: false });
  assert.deepEqual(replayBar({ replaying: true, paused: true }), { replay: 'resume', stop: true });
  // A paused flag with no replay behind it is stale: the bar starts a new one
  assert.deepEqual(replayBar({ replaying: false, paused: true }), { replay: 'replay', stop: false });
});

test('rollBetween gives the travel along the heading and the turn since the frame before', () => {
  const r = rollBetween({ position: [0, 0, 0], yaw: Math.PI }, { position: [-0.5, 0, 0], yaw: Math.PI }, 0.1);
  assert.ok(Math.abs(r.forward - 0.5) < 1e-9);
  assert.ok(Math.abs(r.turn) < 1e-9);
  // Backing up rolls backwards
  assert.ok(rollBetween({ position: [0, 0, 0], yaw: 0 }, { position: [-0.2, 0, 0], yaw: 0 }, 0.1).forward < 0);
  // A turn across ±π is the short way
  const across = rollBetween({ position: [0, 0, 0], yaw: Math.PI - 0.05 }, { position: [0, 0, 0], yaw: -Math.PI + 0.05 }, 0.1);
  assert.ok(Math.abs(across.turn - 0.1) < 1e-9);
});

test('rollBetween rolls nothing on the first frame, while paused, or over a seek', () => {
  const a = { position: [0, 0, 0], yaw: 0 };
  const b = { position: [5, 0, 0], yaw: 0 };
  assert.equal(rollBetween(null, b, 0.1), null);
  assert.equal(rollBetween(a, b, 0), null);
  assert.equal(rollBetween(a, b, ROLL_MAX_DT_S + 0.1), null);
  assert.equal(rollBetween({ position: null, yaw: 0 }, b, 0.1), null);
});
