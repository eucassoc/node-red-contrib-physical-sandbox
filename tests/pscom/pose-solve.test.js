import test from 'node:test';
import assert from 'node:assert/strict';
import { intrinsicsFromFov, extrinsicsFromPose, projectPoint } from '../../src/pscom/camera-model.js';
import { refinePose, poseFromFloorQuad, floorScaleFromEdge, floorFromClicks, MIN_POINTS } from '../../src/pscom/pose-solve.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const FRAME = { origin: { x: 0, y: 0, z: 0 }, yaw: 0 };
const TRUTH_POSE = { fovDeg: 60, pitchDeg: 35, rollDeg: 0, heightM: 2.5 };

// A 4 x 3 m floor in front of the camera, corners 1..4 going round it.
const FLOOR = [
  { x: -2, y: 0, z: -2 },
  { x: 2, y: 0, z: -2 },
  { x: 2, y: 0, z: -5 },
  { x: -2, y: 0, z: -5 },
];
const COLUMN_TOP = { x: 1.5, y: 2.2, z: -4.5 };

const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

const angleBetweenDeg = (R1, R2) => {
  let trace = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) trace += R1[i * 3 + k] * R2[i * 3 + k];
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
};
const cameraCentre = ({ R, t }) => [0, 1, 2].map((j) => -(R[j] * t[0] + R[3 + j] * t[1] + R[6 + j] * t[2]));
const centreGap = (a, b) => Math.hypot(...cameraCentre(a).map((c, i) => c - cameraCentre(b)[i]));
const vfovDeg = (intr) => (2 * Math.atan(intr.height / 2 / intr.fy) * 180) / Math.PI;

const pixelsOf = (intr, extr, worlds) => worlds.map((w) => {
  const p = projectPoint(intr, extr, w);
  return { u: p.u, v: p.v };
});
const pointsOf = (intr, extr, worlds) =>
  worlds.map((world, i) => ({ id: `p${i + 1}`, world, pixel: pixelsOf(intr, extr, [world])[0] }));

// A small deterministic random sequence, so a noisy test always sees the same noise.
const seeded = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const truth = () => ({ intr: intrinsicsFromFov(TRUTH_POSE.fovDeg, WIDTH, HEIGHT), extr: extrinsicsFromPose(TRUTH_POSE, FRAME) });
const offset = (extr, dt) => ({ R: [...extr.R], t: extr.t.map((c, i) => c + dt[i]) });

test('four corners of a 4 x 3 m floor seen from 2.5 m up at 35° give back the camera within 0.3° and 3 cm, and its field of view within 2°', () => {
  const { intr, extr } = truth();
  const solved = poseFromFloorQuad(pixelsOf(intr, extr, FLOOR), FLOOR, { width: WIDTH, height: HEIGHT });
  assert.ok(solved, 'a pose');
  near(angleBetweenDeg(solved.extr.R, extr.R), 0, 0.3, 'rotation (deg)');
  near(centreGap(solved.extr, extr), 0, 0.03, 'camera centre (m)');
  near(vfovDeg(solved.intr), TRUTH_POSE.fovDeg, 2, 'vertical fov (deg)');
  assert.ok(solved.residualPx < 0.1, `residualPx ${solved.residualPx}`);
  assert.ok(solved.residualM < 0.01, `residualM ${solved.residualM}`);
});

test('a floor seen nearly head-on (no perspective) refuses to guess the field of view', () => {
  const intr = intrinsicsFromFov(TRUTH_POSE.fovDeg, WIDTH, HEIGHT);
  const extr = extrinsicsFromPose({ ...TRUTH_POSE, pitchDeg: 89 }, FRAME);
  const below = [{ x: -2, y: 0, z: 1.5 }, { x: 2, y: 0, z: 1.5 }, { x: 2, y: 0, z: -1.5 }, { x: -2, y: 0, z: -1.5 }];
  assert.equal(poseFromFloorQuad(pixelsOf(intr, extr, below), below, { width: WIDTH, height: HEIGHT }), null);
});

test('with a known intr only the pose is solved and the residual is reported', () => {
  const { intr, extr } = truth();
  const random = seeded(7);
  const pixels = pixelsOf(intr, extr, FLOOR).map(({ u, v }) => ({ u: u + (random() - 0.5) * 2, v: v + (random() - 0.5) * 2 }));
  const solved = poseFromFloorQuad(pixels, FLOOR, { width: WIDTH, height: HEIGHT, intr });
  assert.ok(solved, 'a pose');
  assert.deepEqual(solved.intr, intr);
  near(angleBetweenDeg(solved.extr.R, extr.R), 0, 0.5, 'rotation (deg)');
  assert.ok(Number.isFinite(solved.residualPx) && solved.residualPx > 0, `residualPx ${solved.residualPx}`);
  assert.ok(Number.isFinite(solved.residualM) && solved.residualM > 0, `residualM ${solved.residualM}`);
});

test('floorScaleFromEdge lays corner 1 at the origin, corner 2 at edge12M along +x and corner 3 edge23M further along +z', () => {
  const pixels = [{ u: 400, v: 900 }, { u: 1500, v: 900 }, { u: 1300, v: 500 }, { u: 600, v: 500 }];
  const corners = floorScaleFromEdge(pixels, 4, 3);
  assert.equal(corners.length, 4);
  assert.deepEqual(corners[0], { x: 0, y: 0, z: 0 });
  assert.deepEqual(corners[1], { x: 4, y: 0, z: 0 });
  assert.deepEqual(corners[2], { x: 4, y: 0, z: 3 });
  assert.deepEqual(corners[3], { x: 0, y: 0, z: 3 });
});

// The same 4 x 3 m floor laid as a new floor lays it: corner 1 -> 2 along +x, 2 -> 3 along +z.
const NEW_FLOOR = [{ x: -2, y: 0, z: -5 }, { x: 2, y: 0, z: -5 }, { x: 2, y: 0, z: -2 }, { x: -2, y: 0, z: -2 }];
// Where the truth camera stands in that new floor's coordinates (corner 1 at the origin).
const inNewFloor = (extr) => {
  const c = cameraCentre(extr);
  return [c[0] + 2, c[1], c[2] + 5];
};

test('a 4 x 3 m new floor with both lengths gives back the camera and its field of view', () => {
  const { intr, extr } = truth();
  const pixels = pixelsOf(intr, extr, NEW_FLOOR);
  const solved = poseFromFloorQuad(pixels, floorScaleFromEdge(pixels, 4, 3), { width: WIDTH, height: HEIGHT });
  assert.ok(solved?.extr, 'a pose');
  near(vfovDeg(solved.intr), TRUTH_POSE.fovDeg, 2, 'vertical fov (deg)');
  const gap = Math.hypot(...cameraCentre(solved.extr).map((c, i) => c - inNewFloor(extr)[i]));
  near(gap, 0, 0.03, 'camera centre (m)');
  assert.equal(solved.mirrored, false);
});

// The same floor turned 30° about its centre, so the camera sees it at an angle: two vanishing
// points, and the picture tells the lens and the depth
const TURNED_FLOOR = NEW_FLOOR.map(({ x, z }) => {
  const a = (30 * Math.PI) / 180;
  const [cx, cz] = [0, -3.5];
  return { x: cx + (x - cx) * Math.cos(a) - (z - cz) * Math.sin(a), y: 0, z: cz + (x - cx) * Math.sin(a) + (z - cz) * Math.cos(a) };
});

test('floorFromClicks reads the depth and the lens off a floor seen at an angle, from the length of 1→2 alone', () => {
  const { intr, extr } = truth();
  const pixels = pixelsOf(intr, extr, TURNED_FLOOR);
  const found = floorFromClicks(pixels, 4, { width: WIDTH, height: HEIGHT });
  assert.equal(found?.derived, true);
  near(found.edge23M, 3, 0.05, 'depth (m)');
  near(vfovDeg(found.intr), TRUTH_POSE.fovDeg, 1, 'vertical fov (deg)');
});

test('the solve with what floorFromClicks found leaves every corner on its click', () => {
  const { intr, extr } = truth();
  const pixels = pixelsOf(intr, extr, TURNED_FLOOR);
  const found = floorFromClicks(pixels, 4, { width: WIDTH, height: HEIGHT });
  const solved = poseFromFloorQuad(pixels, floorScaleFromEdge(pixels, 4, found.edge23M), { width: WIDTH, height: HEIGHT, intr: found.intr, allowMirror: true });
  assert.ok(solved?.extr, 'a pose');
  solved.siteCorners.forEach((corner, i) => {
    const p = projectPoint(solved.intr, solved.extr, corner);
    near(Math.hypot(p.u - pixels[i].u, p.v - pixels[i].v), 0, 0.05, `corner ${i + 1} (px)`);
  });
});

test('a floor seen straight on cannot tell its depth: depth-needed, and with the depth typed the lens follows', () => {
  const { intr, extr } = truth();
  const pixels = pixelsOf(intr, extr, NEW_FLOOR);
  assert.deepEqual(floorFromClicks(pixels, 4, { width: WIDTH, height: HEIGHT }), { reason: 'depth-needed' });
  const found = floorFromClicks(pixels, 4, { width: WIDTH, height: HEIGHT, edge23M: 3 });
  assert.equal(found?.derived, false);
  assert.equal(found.edge23M, 3);
  near(vfovDeg(found.intr), TRUTH_POSE.fovDeg, 1, 'vertical fov (deg)');
});

test('with a calibrated lens the depth is read off the picture even straight on', () => {
  const { intr, extr } = truth();
  const pixels = pixelsOf(intr, extr, NEW_FLOOR);
  const found = floorFromClicks(pixels, 4, { width: WIDTH, height: HEIGHT, intr });
  assert.equal(found?.derived, true);
  near(found.edge23M, 3, 0.02, 'depth (m)');
  assert.equal(found.intr, intr);
});

test('four corners on one line fix nothing', () => {
  const line = [0, 1, 2, 3].map((i) => ({ u: 200 + 300 * i, v: 700 }));
  assert.equal(floorFromClicks(line, 4, { width: WIDTH, height: HEIGHT }), null);
  assert.equal(floorFromClicks(line, 4, { width: WIDTH, height: HEIGHT, edge23M: 3 }), null);
});

test('corners clicked the other way round are refused for a recording\'s floor', () => {
  const { intr, extr } = truth();
  const square = [{ x: -2, y: 0, z: -2 }, { x: 2, y: 0, z: -2 }, { x: 2, y: 0, z: -6 }, { x: -2, y: 0, z: -6 }];
  const [p1, p2, p3, p4] = pixelsOf(intr, extr, square);
  // Clicked 1, 4, 3, 2: the same place, going round the other way
  const solved = poseFromFloorQuad([p1, p4, p3, p2], square, { width: WIDTH, height: HEIGHT });
  assert.ok(solved, 'an answer');
  assert.equal(solved.extr, null);
  assert.equal(solved.reason, 'mirrored');
  // With the lens known it is refused just the same
  assert.equal(poseFromFloorQuad([p1, p4, p3, p2], square, { width: WIDTH, height: HEIGHT, intr }).reason, 'mirrored');
});

test('corners clicked the other way round are mirrored back for a new floor', () => {
  const { intr, extr } = truth();
  const [p1, p2, p3, p4] = pixelsOf(intr, extr, NEW_FLOOR);
  // Clicked 1, 4, 3, 2: the lengths given are 1 -> 4 (3 m) and then 4 -> 3 (4 m)
  const clicked = [p1, p4, p3, p2];
  const solved = poseFromFloorQuad(clicked, floorScaleFromEdge(clicked, 3, 4), { width: WIDTH, height: HEIGHT, allowMirror: true });
  assert.ok(solved?.extr, 'a pose');
  assert.equal(solved.mirrored, true);
  // The camera is above the floor, and the floor it stands on is the clicked one, the right way round
  assert.ok(cameraCentre(solved.extr)[1] > 2, `camera y ${cameraCentre(solved.extr)[1]}`);
  near(cameraCentre(solved.extr)[1], 2.5, 0.03, 'camera height (m)');
  near(vfovDeg(solved.intr), TRUTH_POSE.fovDeg, 2, 'vertical fov (deg)');
  assert.ok(solved.residualPx < 0.1, `residualPx ${solved.residualPx}`);
  assert.deepEqual(solved.siteCorners[0], { x: 0, y: 0, z: 0 });
  assert.deepEqual(solved.siteCorners[1], { x: 3, y: 0, z: 0 });
  solved.siteCorners.forEach((corner, i) => {
    const p = projectPoint(solved.intr, solved.extr, corner);
    assert.ok(Math.hypot(p.u - clicked[i].u, p.v - clicked[i].v) < 0.5, `corner ${i + 1}`);
  });
});

test('from a pose a few degrees and centimetres off, four floor points bring it back within 0.1 px', () => {
  const { intr, extr } = truth();
  const start = offset(extrinsicsFromPose({ ...TRUTH_POSE, pitchDeg: 38, rollDeg: 2, heightM: 2.55 }, FRAME), [0.04, -0.03, 0.05]);
  const result = refinePose(intr, pointsOf(intr, extr, FLOOR), start);
  assert.ok(result, 'a result');
  assert.ok(result.residualPx < 0.1, `residualPx ${result.residualPx}`);
  assert.equal(result.perPoint.length, 4);
  assert.deepEqual(result.perPoint.map((p) => p.id), ['p1', 'p2', 'p3', 'p4']);
  for (const p of result.perPoint) assert.ok(p.errPx < 0.1, `${p.id} ${p.errPx}`);
  assert.ok(result.iterations >= 1 && result.iterations <= 30, `iterations ${result.iterations}`);
  near(angleBetweenDeg(result.extr.R, extr.R), 0, 0.05, 'rotation (deg)');
});

test('a raised point (a column top) with four floor points pins the tilt', () => {
  const { intr, extr } = truth();
  const start = extrinsicsFromPose({ ...TRUTH_POSE, pitchDeg: TRUTH_POSE.pitchDeg + 5 }, FRAME);
  const result = refinePose(intr, pointsOf(intr, extr, [...FLOOR, COLUMN_TOP]), start);
  assert.ok(result, 'a result');
  near(angleBetweenDeg(result.extr.R, extr.R), 0, 0.2, 'rotation (deg)');
  assert.ok(result.residualPx < 0.1, `residualPx ${result.residualPx}`);
  assert.ok(result.residualM < 0.01, `residualM ${result.residualM}`);
});

test('noisy pixels report a residual, not zero', () => {
  const { intr, extr } = truth();
  const random = seeded(42);
  const worlds = [];
  for (const x of [-2, -1, 0, 1, 2]) for (const z of [-2, -3.5, -5]) worlds.push({ x, y: 0, z });
  worlds.push(COLUMN_TOP);
  const points = pointsOf(intr, extr, worlds).map((p) => ({
    ...p, pixel: { u: p.pixel.u + (random() - 0.5) * 4, v: p.pixel.v + (random() - 0.5) * 4 },
  }));
  const result = refinePose(intr, points, extr);
  assert.ok(result, 'a result');
  assert.ok(result.residualPx > 0.5 && result.residualPx < 4, `residualPx ${result.residualPx}`);
  assert.ok(result.residualM > 0, `residualM ${result.residualM}`);
});

test('fewer than four points is null', () => {
  const { intr, extr } = truth();
  assert.equal(MIN_POINTS, 4);
  assert.equal(refinePose(intr, pointsOf(intr, extr, FLOOR.slice(0, 3)), extr), null);
  assert.equal(refinePose(intr, [], extr), null);
});

test('three points are taken when the caller allows it (a fixed point left out), from a start near the truth', () => {
  const { intr, extr } = truth();
  const start = offset(extrinsicsFromPose({ ...TRUTH_POSE, pitchDeg: 36 }, FRAME), [0.02, 0, 0.02]);
  const result = refinePose(intr, pointsOf(intr, extr, [FLOOR[0], FLOOR[1], COLUMN_TOP]), start, { minPoints: 3 });
  assert.ok(result, 'a result');
  assert.ok(result.residualPx < 0.1, `residualPx ${result.residualPx}`);
  assert.equal(refinePose(intr, pointsOf(intr, extr, FLOOR.slice(0, 2)), start, { minPoints: 3 }), null);
});

test('a diverging start is damped, not NaN', () => {
  const { intr, extr } = truth();
  const start = extrinsicsFromPose({ ...TRUTH_POSE, rollDeg: 60 }, FRAME);
  const result = refinePose(intr, pointsOf(intr, extr, [...FLOOR, COLUMN_TOP]), start);
  assert.ok(result, 'a result');
  assert.ok(Number.isFinite(result.residualPx), `residualPx ${result.residualPx}`);
  assert.ok(result.extr.R.every(Number.isFinite) && result.extr.t.every(Number.isFinite), 'a finite pose');
  for (const p of result.perPoint) assert.ok(Number.isFinite(p.errPx), `${p.id} ${p.errPx}`);
});
