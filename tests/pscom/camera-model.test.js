import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intrinsicsFromFov, extrinsicsFromPose, projectPoint, rayThroughPixel, floorHit, parseCameraInfo, sizeProblem, frustumOf,
} from '../../src/pscom/camera-model.js';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';

const WIDTH = 1920;
const HEIGHT = 1080;

const RAD_PER_DEG = Math.PI / 180;

const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

test('a pixel on the floor goes back to the same floor point', () => {
  const pose = { fovDeg: 70, pitchDeg: 40, rollDeg: 8, heightM: 3 };
  const intr = intrinsicsFromFov(pose.fovDeg, WIDTH, HEIGHT);
  const extr = extrinsicsFromPose(pose, { origin: { x: 0, y: 0, z: 0 }, yaw: 0 });
  const point = { x: -1.2, y: 0, z: -3.5 };
  const px = projectPoint(intr, extr, point);
  const hit = floorHit(rayThroughPixel(intr, extr, px.u, px.v));
  near(hit.x, point.x, 0.001, 'x');
  near(hit.y, 0, 0.001, 'y');
  near(hit.z, point.z, 0.001, 'z');
});

test('a point behind the camera projects to null', () => {
  const pose = { fovDeg: 60, pitchDeg: 30, rollDeg: 0, heightM: 2.5 };
  const intr = intrinsicsFromFov(pose.fovDeg, WIDTH, HEIGHT);
  const extr = extrinsicsFromPose(pose, { origin: { x: 0, y: 0, z: 0 }, yaw: 0 });
  assert.equal(projectPoint(intr, extr, { x: 0, y: 0, z: 5 }), null);
  // A ray that never reaches the floor (looking above the horizon) hits nothing
  assert.equal(floorHit(rayThroughPixel(intr, extr, WIDTH / 2, 0)), null);
});

test('distortion bends a point off centre and the ray undoes it', () => {
  const pose = { fovDeg: 60, pitchDeg: 30, rollDeg: 0, heightM: 2.5 };
  const plain = intrinsicsFromFov(pose.fovDeg, WIDTH, HEIGHT);
  const bent = { ...plain, dist: [-0.2, 0.03, 0.001, -0.001, 0] };
  const extr = extrinsicsFromPose(pose, { origin: { x: 0, y: 0, z: 0 }, yaw: 0 });
  const point = { x: 2.5, y: 0, z: -3 };
  const a = projectPoint(plain, extr, point);
  const b = projectPoint(bent, extr, point);
  assert.ok(Math.hypot(a.u - b.u, a.v - b.v) > 1, 'distortion should move the point by more than a pixel');
  const ray = rayThroughPixel(bent, extr, b.u, b.v);
  const back = projectPoint(bent, extr, { x: ray.origin.x + ray.dir.x * b.depth * 1.7, y: ray.origin.y + ray.dir.y * b.depth * 1.7, z: ray.origin.z + ray.dir.z * b.depth * 1.7 });
  near(back.u, b.u, 0.01, 'u');
  near(back.v, b.v, 0.01, 'v');
  const hit = floorHit(ray);
  near(hit.x, point.x, 0.01, 'x');
  near(hit.z, point.z, 0.01, 'z');
});

test('parseCameraInfo refuses K that is not nine numbers and an unknown distortion model', () => {
  const good = { width: 640, height: 480, K: [500, 0, 320, 0, 500, 240, 0, 0, 1], D: [0, 0, 0, 0, 0] };
  const shortK = parseCameraInfo({ ...good, K: [1, 2, 3] });
  assert.equal(shortK.intr, null);
  assert.ok(shortK.problems.length > 0);
  const model = parseCameraInfo({ ...good, distortion_model: 'fisheye' });
  assert.equal(model.intr, null);
  assert.ok(model.problems.length > 0);
  assert.equal(parseCameraInfo({ ...good, D: [0, 0, 0] }).intr, null);
  assert.equal(parseCameraInfo({ K: good.K, D: good.D }).intr, null);
});

test('parseCameraInfo accepts a plumb_bob camera with extrinsics', () => {
  const R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const info = parseCameraInfo({
    width: 640, height: 480, K: [500, 0, 320, 0, 510, 240, 0, 0, 1],
    D: [-0.1, 0.01, 0, 0, 0], distortion_model: 'plumb_bob', extrinsics: { R, t: [0, 0, 1] },
  });
  assert.deepEqual(info.problems, []);
  assert.deepEqual(info.intr, { fx: 500, fy: 510, cx: 320, cy: 240, width: 640, height: 480, dist: [-0.1, 0.01, 0, 0, 0] });
  assert.deepEqual(info.extr, { R, t: [0, 0, 1] });
  assert.equal(parseCameraInfo({ width: 640, height: 480, K: [500, 0, 320, 0, 510, 240, 0, 0, 1], D: [0, 0, 0, 0, 0] }).extr, null);
});

const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/camera-info.sample.json', import.meta.url), 'utf8'));

test('the sample camera info parses with no problems and its size is 1280x720', () => {
  const info = parseCameraInfo(SAMPLE);
  assert.deepEqual(info.problems, []);
  assert.equal(info.intr.width, 1280);
  assert.equal(info.intr.height, 720);
  assert.ok(info.extr, 'the sample carries extrinsics');
  // Its extrinsics are the ones extrinsicsFromPose gives for 1.2 m up, 45° down, the lens of its fy
  const fovDeg = (2 * Math.atan(info.intr.height / 2 / info.intr.fy)) / RAD_PER_DEG;
  const expected = extrinsicsFromPose({ fovDeg, pitchDeg: 45, rollDeg: 0, heightM: 1.2 }, null);
  expected.R.forEach((v, i) => near(info.extr.R[i], v, 1e-6, `R${i}`));
  expected.t.forEach((v, i) => near(info.extr.t[i], v, 1e-6, `t${i}`));
  assert.equal(sizeProblem(info.intr, { width: 1280, height: 720 }), null);
});

test('a camera info whose size differs from the picture is refused with camera.infoSize', () => {
  const { intr } = parseCameraInfo(SAMPLE);
  assert.deepEqual(sizeProblem(intr, { width: 1920, height: 1080 }), {
    key: 'camera.infoSize', params: { w: 1280, h: 720, mw: 1920, mh: 1080 },
  });
  assert.equal(sizeProblem(intr, { width: 1280, height: 720 }), null);
});

test('a camera with an off-centre principal point and fx != fy draws through three where it measures', () => {
  const intr = { fx: 1000, fy: 950, cx: 700, cy: 330, width: 1280, height: 720, dist: [0, 0, 0, 0, 0] };
  const extr = extrinsicsFromPose({ fovDeg: 50, pitchDeg: 30, rollDeg: 2, heightM: 2.4 }, null);
  const f = frustumOf(intr);
  const camera = new THREE.PerspectiveCamera(f.fovDeg, f.aspect, 0.05, 600);
  // setViewOffset sets the aspect to the full frame's: the stretched one goes in after it
  camera.setViewOffset(f.view.fullWidth, f.view.fullHeight, f.view.offsetX, f.view.offsetY, f.view.width, f.view.height);
  camera.aspect = f.aspect;
  camera.updateProjectionMatrix();
  // Placed as video-view.js's applyCamera places it: at -R^T t, turned by R^T diag(1, -1, -1)
  const r = extr.R;
  camera.position.set(
    -(r[0] * extr.t[0] + r[3] * extr.t[1] + r[6] * extr.t[2]),
    -(r[1] * extr.t[0] + r[4] * extr.t[1] + r[7] * extr.t[2]),
    -(r[2] * extr.t[0] + r[5] * extr.t[1] + r[8] * extr.t[2]),
  );
  camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(r[0], r[1], r[2]), new THREE.Vector3(-r[3], -r[4], -r[5]), new THREE.Vector3(-r[6], -r[7], -r[8]),
  ));
  camera.updateMatrixWorld(true);
  for (const world of [{ x: 0, y: 0, z: -3 }, { x: 1.5, y: 0, z: -2 }, { x: -1, y: 1.2, z: -5 }]) {
    const want = projectPoint(intr, extr, world);
    const ndc = new THREE.Vector3(world.x, world.y, world.z).project(camera);
    const u = ((ndc.x + 1) / 2) * intr.width;
    const v = ((1 - ndc.y) / 2) * intr.height;
    assert.ok(Math.hypot(u - want.u, v - want.v) < 1e-6, `${JSON.stringify(world)}: three ${u}, ${v} vs ${want.u}, ${want.v}`);
  }
});
