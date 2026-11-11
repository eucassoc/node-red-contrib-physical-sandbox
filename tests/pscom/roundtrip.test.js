import test from 'node:test';
import assert from 'node:assert/strict';
import {
  siteFrame, toSite, fromSite, checkScale, clampTarget, applyMeasuredDistance, readProject,
} from '../../src/pscom/roundtrip.js';

const A = { x: 1.5, y: 0, z: -2.0 };
const B = { x: 3.5, y: 0, z: -2.0 };

test('marker 2 lands at (span, 0, 0) in site coordinates', () => {
  const frame = siteFrame(A, B);
  const b = toSite(B, frame);
  assert.ok(Math.abs(b.x - 2.0) < 1e-9, `x=${b.x}`);
  assert.ok(Math.abs(b.z) < 1e-9, `z=${b.z}`);
});

test('marker 2 lands on +X however the pair is oriented', () => {
  const frame = siteFrame({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 });
  const b = toSite({ x: 1, y: 0, z: 1 }, frame);
  assert.ok(Math.abs(b.x - Math.SQRT2) < 1e-9, `x=${b.x}`);
  assert.ok(Math.abs(b.z) < 1e-9, `z=${b.z}`);
});

test('toSite and fromSite round-trip', () => {
  const frame = siteFrame(A, B);
  const p = { x: 2.2, y: 0.4, z: -3.1 };
  const back = fromSite(toSite(p, frame), frame);
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(back[axis] - p[axis]) < 1e-9, `${axis}=${back[axis]}`);
  }
});

test('markers too close together throw', () => {
  assert.throws(() => siteFrame(A, { x: 1.55, y: 0, z: -2.0 }),
    (error) => error.i18nKey === 'err.markersTooClose');
});

test('returns the difference from the tape measure', () => {
  // Do not compare the difference exactly. 2.04 - 2.0 is not exactly 0.04 (floating point)
  const near = checkScale(2.04, 2.0, 0.05);
  assert.equal(near.ok, true);
  assert.ok(Math.abs(near.errorM - 0.04) < 1e-9, `errorM=${near.errorM}`);

  assert.equal(checkScale(2.20, 2.0, 0.05).ok, false);
});

test('a point in range comes back unchanged', () => {
  const result = clampTarget({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 8);
  assert.equal(result.clamped, false);
  assert.deepEqual(result.point, { x: 3, y: 0, z: 0 });
});

test('a point too far away is pulled back to the limit', () => {
  const result = clampTarget({ x: 0, y: 0, z: 0 }, { x: 30, y: 0.4, z: 0 }, 8);
  assert.equal(result.clamped, true);
  assert.ok(Math.abs(result.point.x - 8) < 1e-9, `x=${result.point.x}`);
  assert.equal(result.point.y, 0.4);
  assert.equal(result.distanceM, 8);
});

test('pulled back without changing direction', () => {
  const result = clampTarget({ x: 1, y: 0, z: 1 }, { x: 11, y: 0, z: 11 }, 5);
  const dx = result.point.x - 1;
  const dz = result.point.z - 1;
  assert.ok(Math.abs(dx - dz) < 1e-9, `dx=${dx} dz=${dz}`);
  assert.ok(Math.abs(Math.hypot(dx, dz) - 5) < 1e-9);
});

// In site coordinates marker 1 is the origin and marker 2 is at (span, 0, 0), so the
// spacing AR measured can be read from the recording itself.
const RECORDED = {
  schemaVersion: 1,
  measuredDistanceM: null,
  scaleCheck: null,
  markers: [{ id: 'm1', x: 0, y: 0, z: 0 }, { id: 'm2', x: 1.699, y: 0, z: 0 }],
};

test('the measured figure goes in later and the check is re-run', () => {
  const updated = applyMeasuredDistance(RECORDED, 1.7);
  assert.equal(updated.measuredDistanceM, 1.7);
  assert.equal(updated.scaleCheck.ok, true);
  assert.ok(Math.abs(updated.scaleCheck.errorM + 0.001) < 1e-9, `errorM=${updated.scaleCheck.errorM}`);
});

test('ok is false when they disagree', () => {
  assert.equal(applyMeasuredDistance(RECORDED, 2.0).scaleCheck.ok, false);
});

test('the original recording is not modified', () => {
  applyMeasuredDistance(RECORDED, 1.7);
  assert.equal(RECORDED.measuredDistanceM, null);
  assert.equal(RECORDED.scaleCheck, null);
});

test('too few markers throws', () => {
  assert.throws(() => applyMeasuredDistance({ markers: [{ id: 'm1', x: 0, y: 0, z: 0 }] }, 1.7),
    (error) => error.i18nKey === 'err.needTwoMarkers');
});

// One broken value must not kill the page. On the device, an unreadable recording left in
// storage made a top-level JSON.parse throw and every button stopped responding.
test('a readable recording comes back as it is', () => {
  const result = readProject(JSON.stringify(RECORDED));
  assert.equal(result.error, null);
  assert.equal(result.project.markers.length, 2);
});

test('no recording is not an error', () => {
  assert.deepEqual(readProject(null), { project: null, error: null });
});

test('broken input returns a reason instead of throwing', () => {
  const result = readProject('{"schemaVersion":1,"markers":[{"id"');
  assert.equal(result.project, null);
  assert.ok(result.error.length > 0, 'error carries a reason');
});

test('a frame with a scale draws the site smaller (a miniature), and toSite undoes it', () => {
  const frame = siteFrame({ x: 1, y: 0.5, z: 2 }, { x: 1.3, y: 0.5, z: 2 }, 0.1);
  assert.equal(frame.scale, 0.1);
  // 3 m along the site's +x is 0.3 m in the world
  const w = fromSite({ x: 3, y: 1, z: 0 }, frame);
  assert.ok(Math.abs(w.x - 1.3) < 1e-9 && Math.abs(w.y - 0.6) < 1e-9 && Math.abs(w.z - 2) < 1e-9);
  const back = toSite(w, frame);
  assert.ok(Math.abs(back.x - 3) < 1e-9 && Math.abs(back.y - 1) < 1e-9 && Math.abs(back.z) < 1e-9);
  // Real size has no scale written, as before
  assert.equal('scale' in siteFrame({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), false);
  assert.equal('scale' in siteFrame({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 1), false);
});
