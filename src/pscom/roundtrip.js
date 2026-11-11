// Copied from app/src/roundtrip.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * The coordinate frame set by two markers on site.
 *
 * **An AR session's origin changes every time.** Come back to the same room tomorrow and
 * yesterday's coordinates do not reproduce, so anything written out is in this frame. The
 * origin is marker 1, +X is the horizontal direction from marker 1 to marker 2, +Y is up.
 *
 * The same definition lives in tools/twin_align.py (the twin's side). **These two places are
 * as far as the formula is ever copied.**
 *
 * **A low layer too.** Reasons thrown become tError, and whichever screen catches them
 * (app.js, project-ui.js) translates with describeError (built like the note in i18n.js).
 */

import { tError } from './i18n.js';

/** Markers close together magnify the error in heading. Keep them at least this far apart [m]. */
const MIN_SPAN = 0.2;

export function siteFrame(markerA, markerB, scale = 1) {
  const dx = markerB.x - markerA.x;
  const dz = markerB.z - markerA.z;
  const spanM = Math.hypot(dx, dz);

  if (spanM < MIN_SPAN * Math.min(1, scaleOf({ scale }))) {
    throw tError('err.markersTooClose', { span: spanM.toFixed(2), min: MIN_SPAN });
  }

  const frame = { origin: { x: markerA.x, y: markerA.y, z: markerA.z }, yaw: Math.atan2(dz, dx), spanM };
  // **A miniature** (a recorded floor lined up on a smaller patch of the real one): the site is
  // drawn `scale` times its size. Real size writes nothing, so every frame before is as it was
  if (scaleOf({ scale }) !== 1) frame.scale = scale;
  return frame;
}

/** A frame's scale: how many world metres one site metre is drawn as (1 when it has none). */
export function scaleOf(frame) {
  const s = frame?.scale;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

export function toSite(point, frame) {
  const k = scaleOf(frame);
  const dx = (point.x - frame.origin.x) / k;
  const dz = (point.z - frame.origin.z) / k;
  const c = Math.cos(-frame.yaw);
  const s = Math.sin(-frame.yaw);

  return { x: dx * c - dz * s, y: (point.y - frame.origin.y) / k, z: dx * s + dz * c };
}

export function fromSite(point, frame) {
  const k = scaleOf(frame);
  const c = Math.cos(frame.yaw);
  const s = Math.sin(frame.yaw);

  return {
    x: frame.origin.x + k * (point.x * c - point.z * s),
    y: frame.origin.y + k * point.y,
    z: frame.origin.z + k * (point.x * s + point.z * c),
  };
}

/**
 * The difference between the marker spacing AR measured and the tape measure.
 * **If they disagree, throw the whole recording away.** It is evidence that tracking drifted,
 * and going on with it means nothing.
 */
export function checkScale(spanM, measuredDistanceM, toleranceM = 0.05) {
  const errorM = spanM - measuredDistanceM;
  return { ok: Math.abs(errorM) <= toleranceM, errorM };
}

/**
 * Cap a move target by horizontal distance from the robot.
 *
 * With no limit, a far-off point pointed at near level is recorded as "the path a person
 * showed". It leaves the twin's reconstruction range, so driving it returns nothing meaningful.
 *
 * **Height keeps the target's value as it is.** The floor's height where it was pulled back to
 * is unknown, so changing it would sink the robot wherever there is a step.
 */
/**
 * Read a recording saved on the device. **Never throws, however broken it is.**
 *
 * On the device, an unreadable recording left in storage made a top-level JSON.parse throw and
 * every bit of the page's logic stopped (buttons did nothing and showed nothing). So that one
 * unreadable value cannot kill a screen, return the reason and let the caller judge.
 *
 * @returns {{ project: object|null, error: string|null }}
 */
export function readProject(raw) {
  if (!raw) return { project: null, error: null };

  try {
    return { project: JSON.parse(raw), error: null };
  } catch (error) {
    return { project: null, error: error.message };
  }
}

/**
 * After exporting, put the tape measure's figure in and check again.
 *
 * **The measured figure goes in after leaving AR.** On site the marker spacing differs every
 * time, so it is never a constant in the code. In site coordinates marker 1 is the origin and
 * marker 2 is at (span, 0, 0), so the spacing AR measured can be read from the recording itself.
 */
export function applyMeasuredDistance(project, measuredDistanceM) {
  const spanM = project.markers?.[1]?.x;
  if (!(spanM > 0)) throw tError('err.needTwoMarkers');

  return { ...project, measuredDistanceM, scaleCheck: checkScale(spanM, measuredDistanceM) };
}

export function clampTarget(from, to, maxM) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);

  if (distance <= maxM) return { point: { x: to.x, y: to.y, z: to.z }, clamped: false, distanceM: distance };

  const ratio = maxM / distance;
  return {
    point: { x: from.x + dx * ratio, y: to.y, z: from.z + dz * ratio },
    clamped: true,
    distanceM: maxM,
  };
}
