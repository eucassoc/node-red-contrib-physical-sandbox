// Copied from app/src/replay-rules.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * What a replay needs, worked out from a recording alone.
 *
 * A recording is one run: the devices of its equipment, where each stood, the points a person
 * gave the ones it drove, and how the others moved — all relative to the site (marker 1 is the
 * origin, marker 2 is +X), written in ROS from version 3 (record-upgrade.js). Replaying it means
 * putting each driven device back where it stood and sending it along the same points through
 * the chain, and posing the others from their traces, on whichever frame the viewer has today:
 * in AR the two markers on the floor, in the preview window the frame the kit stands on (the
 * origin, until the whole kit was moved).
 *
 * **Reasons come back as dictionary keys**, not text: this file knows no language and no DOM.
 */

import { siteFrame } from './roundtrip.js';

/**
 * What there is to replay: every device that has a route, and every other device that has a
 * trace of how it moved.
 *
 * Reads version 3 (record-upgrade.js; every reader upgrades on the way in). **"Placed" is not an
 * id shape**: a robot placed by hand today (`scout-1`) and one an older recording placed (`a1`,
 * upgraded) are both devices with a route, and both replay. A route is replayed when its device
 * is in `equipment.devices` (a route of a device that is not there has nothing to walk it) and
 * it has at least one waypoint; its `pose` is where the device stood as the recording began, and
 * its points come in the order they were given, ROS as written — laying them down is the
 * stage's. One route per device: the first with waypoints.
 *
 * A device with a trace and no route is posed from its trace (`deviceTraces`). One with both
 * replays its route only: its trace is what it drove, and posing it on top would fight the
 * chain. `deviceIds` is every device the replay moves, routes first. A recording with neither
 * a route nor a device trace is "nothing to replay" — one reason, because from the person's side
 * it is one situation.
 *
 * @returns {{ plan: { routes: Array<{deviceId: string, pose: object|undefined, points: Array<{position: number[]}>}>, deviceTraces: Array<{deviceId: string, samples: object[]}>, deviceIds: string[] } | null, problem: string | null }}
 */
export function replayPlan(project) {
  const devices = Array.isArray(project?.equipment?.devices) ? project.equipment.devices : [];
  const byId = new Map(devices.filter((device) => typeof device?.id === 'string').map((device) => [device.id, device]));

  const routes = [];
  for (const route of Array.isArray(project?.routes) ? project.routes : []) {
    const device = byId.get(route?.deviceId);
    if (!device || !Array.isArray(route.waypoints) || route.waypoints.length === 0) continue;
    if (routes.some((r) => r.deviceId === device.id)) continue;
    const points = [...route.waypoints].sort((a, b) => a.order - b.order).map(({ position }) => ({ position }));
    routes.push({ deviceId: device.id, pose: device.pose, points });
  }
  const routed = new Set(routes.map((route) => route.deviceId));

  const deviceTraces = (Array.isArray(project?.traces) ? project.traces : [])
    .filter((trace) => typeof trace?.deviceId === 'string' && Array.isArray(trace.samples) && trace.samples.length > 0)
    .filter((trace) => !routed.has(trace.deviceId));

  if (routes.length === 0 && deviceTraces.length === 0) return { plan: null, problem: 'ar.noReplayPath' };

  const deviceIds = [...new Set([...routed, ...deviceTraces.map((trace) => trace.deviceId)])];
  return { plan: { routes, deviceTraces, deviceIds }, problem: null };
}

/**
 * How a replay starts, given which devices stand here (`stands(id)`): no three, no chain, only
 * the calls the page makes, in order.
 *
 * - `stops` — every standing device the replay moves. Each is stopped first, so a drive a
 *   person started does not fight the replay (a route device's or a traced one's).
 * - `starts` — each standing route device: `place` is where it is put down first (its recorded
 *   pose, ROS, the yaw about +Z, 0 when the pose has no turn; null when the recording gave no
 *   pose — it sets out from where it is), then it is sent along `points` to `target`, the last.
 * - `skipped` — route devices that do not stand here: there is nothing to put down.
 * - `traces` — the device traces of devices that stand here; the others have nothing to pose.
 *
 * What it hands out is a copy: moving it does not move the recording.
 */
export function replayStarts(plan, stands) {
  const stops = plan.deviceIds.filter((id) => stands(id));
  const starts = [];
  const skipped = [];
  for (const route of plan.routes) {
    if (!stands(route.deviceId)) { skipped.push(route.deviceId); continue; }
    const points = route.points.map(({ position }) => [...position]);
    const xyz = route.pose?.xyz;
    const yaw = route.pose?.rpy?.[2];
    starts.push({
      deviceId: route.deviceId,
      place: Array.isArray(xyz) ? { position: [...xyz], yaw: Number.isFinite(yaw) ? yaw : 0 } : null,
      points,
      target: [...points[points.length - 1]],
    });
  }
  const traces = plan.deviceTraces.filter((trace) => stands(trace.deviceId));
  return { stops, starts, skipped, traces };
}

/**
 * Run a replay's start through the page's calls, in order: `begin()` (the replay is on, so the
 * chain is quiet and onObserved records nothing from here), `stop(id)` for each of `stops`,
 * `beginTraces(traces)` when there are any (before the drives, so they share a clock), then
 * `place(id, place)` and `drive(start)` per start. `setStarting(true)` holds for the whole of it:
 * **a drive that goes nowhere asks at once whether the replay is over** (app.js's driveTo), and
 * with a route still to start the answer must be no (replayIsOver). `settle()` asks once more as
 * the start ends and says whether the replay is still on; false means nothing could start, which
 * the caller reports as such — the replay never said it was running, so it never says it finished.
 *
 * @returns {boolean} whether the replay is running after its start
 */
export function runReplayStart({ stops, starts, traces }, io) {
  io.begin();
  io.setStarting(true);
  try {
    for (const id of stops) io.stop(id);
    if (traces.length) io.beginTraces(traces);
    for (const start of starts) {
      if (start.place) io.place(start.deviceId, start.place);
      io.drive(start);
    }
  } finally {
    io.setStarting(false);
  }
  return io.settle();
}

/**
 * Whether a replay can be paused, sought and sped up: one with no route to drive. A route is
 * driven through the chain in real time (bind.js's goto), so only a replay posed from traces
 * alone has a clock of its own to stop and move.
 */
export function seekable(plan) {
  return Array.isArray(plan?.routes) && plan.routes.length === 0;
}

/**
 * The clock a trace replay is posed by (updateDeviceReplay): started at `now` (chainNow's ms),
 * running at 1x. `offsetS` is where it stood, in recording seconds, at `startedAt`; `pausedAt`
 * is when it was stopped, or null while it runs. Every function below returns a new clock and
 * never changes the one given.
 */
export function newClock(now) {
  return { startedAt: now, speed: 1, pausedAt: null, offsetS: 0 };
}

/** Where the clock stands at `now`, in recording seconds. A paused clock stands where it stopped. */
export function clockElapsedS(clock, now) {
  return clock.offsetS + ((clock.pausedAt ?? now) - clock.startedAt) / 1000 * clock.speed;
}

/** The clock stopped at `now`; the same one when it is stopped already. */
export function pauseClock(clock, now) {
  if (clock.pausedAt !== null) return clock;
  return { ...clock, pausedAt: now };
}

/** The clock running again from where it stopped; the same one when it is running. */
export function resumeClock(clock, now) {
  if (clock.pausedAt === null) return clock;
  return { ...clock, offsetS: clockElapsedS(clock, now), startedAt: now, pausedAt: null };
}

/**
 * The clock at `tS` recording seconds from `now`: running on from there, or stopped there when it
 * was stopped. Keeping it within the recording is the caller's (it knows where the traces end).
 */
export function seekClock(clock, tS, now) {
  return { ...clock, offsetS: tS, startedAt: now, pausedAt: clock.pausedAt === null ? null : now };
}

/** The slowest and fastest a clock runs. */
const MIN_SPEED = 0.1;
const MAX_SPEED = 10;

/**
 * The clock running at `speed` from `now`. **Speed is applied from the moment it is set: elapsed
 * so far is folded into offsetS**, so the time already shown does not jump. A speed outside
 * 0.1–10 (or not a number) is refused: the same clock comes back.
 */
export function speedClock(clock, speed, now) {
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) return clock;
  return { ...seekClock(clock, clockElapsedS(clock, now), now), speed };
}

/**
 * The devices a replay sent that are still going (`walks`: id to `{ replay }`), to stop when an
 * agent stops the replay. A person's own drive is not the replay's and goes on.
 */
export function replayWalkIds(walks) {
  return [...walks].filter(([, walk]) => walk.replay).map(([id]) => id);
}

/**
 * Stop a replay through the page's calls, in order: `stop(id)` for each drive it sent
 * (replayWalkIds; the page stops it in the chain and forgets the walk), `dropTraces()` (its traces
 * stop posing, a paused clock with them), then `finish()` (the page asks replayIsOver once more,
 * which is now yes). Every device stays where it is. With nothing replaying nothing is called and
 * the answer is `replay.notReplaying`.
 *
 * @returns {{ problem: string | null }}
 */
export function runReplayStop({ replaying, walks }, io) {
  if (!replaying) return { problem: 'replay.notReplaying' };
  for (const id of replayWalkIds(walks)) io.stop(id);
  io.dropTraces();
  io.finish();
  return { problem: null };
}

/**
 * Whether a replay is over now: it is running, its start is done (runReplayStart), no device it
 * sent is still going (`walks`: id to `{ replay }`, a person's own drive is not the replay's), and
 * no device trace is running (`deviceReplay`).
 */
export function replayIsOver({ replaying, starting, walks, deviceReplay }) {
  if (!replaying || starting || deviceReplay) return false;
  for (const walk of walks.values()) if (walk.replay) return false;
  return true;
}

/**
 * The device replay without the trace of `id`: a person sent that device somewhere, and their
 * drive wins — the trace stops posing it, the rest keeps running. The same replay when `id` is not
 * one of its parts; null when it was the last (or there was none). The one given is not changed.
 */
export function withoutTraceOf(deviceReplay, id) {
  if (!deviceReplay) return null;
  if (!deviceReplay.parts.some((part) => part.id === id)) return deviceReplay;
  const parts = deviceReplay.parts.filter((part) => part.id !== id);
  return parts.length ? { ...deviceReplay, parts } : null;
}

/**
 * A device trace split into what each sample carried: one run of positions, one of yaws (a
 * mover's heading about ROS +Z), one run per joint. A sample that left a field out is not a
 * point of that field's run (state.js keeps what a message leaves out, so between two
 * positions the joints may have been told many times). `endT` is the last time anything was
 * said.
 */
export function deviceSeries(samples) {
  const position = [];
  const yaw = [];
  const joints = {};
  let endT = 0;
  for (const sample of samples) {
    endT = Math.max(endT, sample.t);
    if (Array.isArray(sample.position)) position.push({ t: sample.t, v: sample.position });
    if (Number.isFinite(sample.yaw)) yaw.push({ t: sample.t, v: sample.yaw });
    for (const [name, value] of Object.entries(sample.joints ?? {})) {
      if (!joints[name]) joints[name] = [];
      joints[name].push({ t: sample.t, v: value });
    }
  }
  return { position, yaw, joints, endT };
}

/**
 * The value of a run at t: linear between the two points around it, held at the ends. An
 * angle run turns the short way round, through ±π when that is shorter.
 */
function runAt(run, t, { angle = false } = {}) {
  if (run.length === 0) return null;
  if (t <= run[0].t) return run[0].v;
  const last = run[run.length - 1];
  if (t >= last.t) return last.v;
  let i = 1;
  while (run[i].t < t) i++;
  const a = run[i - 1];
  const b = run[i];
  const f = (t - a.t) / (b.t - a.t || 1);
  if (angle) return a.v + Math.atan2(Math.sin(b.v - a.v), Math.cos(b.v - a.v)) * f;
  return Array.isArray(a.v) ? a.v.map((va, k) => va + (b.v[k] - va) * f) : a.v + (b.v - a.v) * f;
}

/**
 * Where a device was, which way it faced and how its joints stood at t, from its series.
 * Position (or yaw) is null for a device that never said where it is (or which way it faces):
 * it stays as it stands.
 */
export function deviceSampleAt(series, t) {
  const joints = {};
  for (const [name, run] of Object.entries(series.joints)) joints[name] = runAt(run, t);
  return { position: runAt(series.position, t), yaw: runAt(series.yaw ?? [], t, { angle: true }), joints };
}

/**
 * The frame site coordinates are laid onto today.
 *
 * AR's origin changes every session, so the frame is rebuilt from the two markers each time.
 * **The window's frame is whatever the caller passes as `windowFrame`** — it has no markers of
 * its own, so it is not this function's job to know what its kit stands on, or whether the
 * kit has been moved at all. A recording goes down on exactly that frame, over the orange
 * marker rings.
 *
 * @returns {{ frame: { origin: {x,y,z}, yaw: number } | null, problem: string | null }}
 */
export function frameFor({ windowFrame = null, markers = [], scale = 1 }) {
  if (windowFrame) return { frame: windowFrame, problem: null };
  if (markers.length < 2) return { frame: null, problem: 'ar.markerNeedTwo' };
  return { frame: siteFrame(markers[0].position, markers[1].position, scale), problem: null };
}

/**
 * What the video screen's bar offers for the replay's state: "replay" starts one (the record list),
 * "busy" is one running (the button answers that it must end first), and "resume" is one that is
 * paused — then `stop` shows a button to end it. A paused replay holds the screen, so the person
 * must be able to run it on or end it without an agent.
 *
 * @returns {{ replay: 'replay'|'resume'|'busy', stop: boolean }}
 */
export function replayBar({ replaying, paused }) {
  if (!replaying) return { replay: 'replay', stop: false };
  return paused ? { replay: 'resume', stop: true } : { replay: 'busy', stop: false };
}

/** Longer than this between two frames is a seek or a stall, not travel: the wheels do not roll it. */
export const ROLL_MAX_DT_S = 0.5;

/**
 * How a device posed from its trace moved since the frame before: `{ forward, turn }`, metres
 * along the way it faces and radians turned (left positive), for its wheels or legs
 * (drive.js, gait.js). Null when there is nothing to roll: the first frame, a paused or
 * seeking clock (`dtS` not above 0, or above ROLL_MAX_DT_S), or no position on either side.
 * A trace is poses, not wheel turns, so the wheels are turned from what the pose did.
 *
 * @param {{ position: number[]|null, yaw: number|null }|null} before
 * @param {{ position: number[]|null, yaw: number|null }} now
 */
export function rollBetween(before, now, dtS) {
  if (!before || !(dtS > 0) || dtS > ROLL_MAX_DT_S) return null;
  if (!before.position || !now.position) return null;
  const yaw0 = Number.isFinite(before.yaw) ? before.yaw : now.yaw;
  const yaw1 = Number.isFinite(now.yaw) ? now.yaw : yaw0;
  if (!Number.isFinite(yaw0)) return null;
  let turn = yaw1 - yaw0;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn));
  // Along the heading half way through the step, so a turn while moving rolls forward too
  const mid = yaw0 + turn / 2;
  const dx = now.position[0] - before.position[0];
  const dy = now.position[1] - before.position[1];
  return { forward: dx * Math.cos(mid) + dy * Math.sin(mid), turn };
}
