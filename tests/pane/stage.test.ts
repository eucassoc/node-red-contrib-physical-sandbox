// The pane's stage (src/pane/stage.ts), with the WebGL renderer stubbed as PS.com's record page tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as robotBuild from '../../src/pscom/robot-build.js';
import { frustumOf, projectPoint } from '../../src/pscom/camera-model.js';
import { defaultOrbit, orbitEye } from '../../src/pscom/orbit.js';
import { createPaneStage, type PaneScene, type SolvedCamera } from '../../src/pane/stage.js';
import { catalogFetch } from '../pscom/helpers/robot-bundle.js';

function fakeRenderer() {
  const calls = { render: 0, dispose: 0, loop: [] as any[], viewport: [] as number[][], size: [] as number[][] };
  return {
    calls,
    setPixelRatio() {},
    getPixelRatio: () => 1,
    setSize(w: number, h: number) { calls.size.push([w, h]); },
    setViewport(x: number, y: number, w: number, h: number) { calls.viewport.push([x, y, w, h]); },
    setAnimationLoop(fn: any) { calls.loop.push(fn); },
    render() { calls.render += 1; },
    dispose() { calls.dispose += 1; },
  };
}

function fakeCanvas(width = 640, height = 480) {
  const listeners: Record<string, any[]> = {};
  return {
    clientWidth: width,
    clientHeight: height,
    listeners,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener(type: string, fn: any) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type: string, fn: any) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
  };
}

const ARM = '/api/catalog/physical-sandbox/arm/1';
const armResolve = async () => ({ bundleUrl: `${ARM}/files/bundle.json`, meshUrl: (relative: string) => `${ARM}/files/${relative}` });

function makeStage(options: Record<string, any> = {}) {
  const renderer = fakeRenderer();
  const canvas = fakeCanvas();
  const stage = createPaneStage(canvas, {
    resolveBundle: armResolve,
    fetchImpl: catalogFetch(),
    robotBuild: robotBuild as any,
    renderer: () => renderer,
    now: () => 0,
    ...options,
  });
  return { stage, renderer, canvas };
}

const arm = (extra: Record<string, unknown> = {}) => ({ id: 'arm-1', product: 'physical-sandbox/arm:1', owner: 'viewer', parent: 'site', ...extra });

function scene(devices: any[], extra: Partial<PaneScene> = {}): PaneScene {
  return { site: 'local', devices, names: Object.fromEntries(devices.map((d) => [d.id, d.id])), ...extra };
}

const holders = (stage: any) => {
  const found: string[] = [];
  stage.scene.traverse((node: any) => { if (String(node.name).startsWith('device:')) found.push(node.name); });
  return found.sort();
};

const close = (actual: number, expected: number, what: string, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${what}: ${actual} is not ${expected}`);

test('a scene builds one holder per device: a robot from its bundle, an item as a box of its size and colour', async () => {
  const { stage } = makeStage();
  await stage.setScene(scene([
    arm({ pose: { xyz: [1, 2, 0], rpy: [0, 0, 0.5] } }),
    { id: 'crate', type: 'item', parent: 'site', shape: { sizeM: [0.4, 0.3, 0.2] }, render: { colorHex: '#ff0000' }, pose: { xyz: [0, 1, 0.1], rpy: [0, 0, 0] } },
    { id: 'plain', type: 'item', parent: 'site' },
  ]));
  assert.deepEqual(holders(stage), ['device:arm-1', 'device:crate', 'device:plain']);
  assert.deepEqual(stage.placeOf('arm-1')?.position, [1, 2, 0]);
  close(stage.placeOf('arm-1')!.rpy[2], 0.5, 'yaw');
  const holder = stage.scene.getObjectByName('device:arm-1');
  assert.equal(holder.rotation.order, 'ZYX');
  assert.ok(holder.getObjectByName('lift'), 'the robot hangs on a lift');
  assert.equal(holder.parent.name, 'site');

  const crate = stage.scene.getObjectByName('device:crate').getObjectByName('box');
  assert.deepEqual([crate.geometry.parameters.width, crate.geometry.parameters.height, crate.geometry.parameters.depth], [0.4, 0.3, 0.2]);
  assert.equal(crate.material.color.getHex(), 0xff0000);
  const plain = stage.scene.getObjectByName('device:plain').getObjectByName('box');
  assert.deepEqual([plain.geometry.parameters.width, plain.geometry.parameters.height, plain.geometry.parameters.depth], [0.2, 0.2, 0.2]);
  assert.equal(plain.material.color.getHex(), 0x8a8a8a);
  assert.deepEqual(stage.missing(), []);
});

test('a scene again drops the devices it no longer has and keeps the others as they are', async () => {
  const { stage } = makeStage();
  await stage.setScene(scene([arm(), { id: 'box', type: 'item', parent: 'site' }]));
  const before = stage.scene.getObjectByName('device:arm-1');
  await stage.setScene(scene([arm()]));
  assert.deepEqual(holders(stage), ['device:arm-1']);
  assert.equal(stage.scene.getObjectByName('device:arm-1'), before, 'not built again');
});

test('a robot whose bundle cannot be had is listed as missing, and the others are drawn', async () => {
  const { stage } = makeStage({ resolveBundle: async (product: string) => { if (product === 'gone/robot:1') throw new Error('no such robot'); return armResolve(); } });
  await stage.setScene(scene([arm(), { id: 'ghost', product: 'gone/robot:1', parent: 'site' }]));
  assert.deepEqual(stage.missing().map((m) => [m.deviceId, m.product]), [['ghost', 'gone/robot:1']]);
  assert.ok(stage.scene.getObjectByName('device:arm-1').getObjectByName('lift'));
});

test('a state moves the joints and the place; an unknown id, another site, a command or an older state moves nothing', async () => {
  const { stage } = makeStage();
  await stage.setScene(scene([arm()]));
  assert.equal(stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 10, joints: { shoulder: 0.5 }, position: [1, -2, 0], yaw: 0.3 } }), true);
  close(stage.jointOf('arm-1', 'shoulder')!, 0.5, 'shoulder');
  assert.deepEqual(stage.placeOf('arm-1')!.position, [1, -2, 0]);
  close(stage.placeOf('arm-1')!.rpy[2], 0.3, 'yaw');

  assert.equal(stage.applyState({ topic: 'ps/local/nobody/state', payload: { at: 11, joints: { shoulder: 1 } } }), false);
  assert.equal(stage.applyState({ topic: 'ps/other/arm-1/state', payload: { at: 11, joints: { shoulder: 1 } } }), false);
  assert.equal(stage.applyState({ topic: 'ps/local/arm-1/command', payload: { at: 11, joints: { shoulder: 1 } } }), false);
  assert.equal(stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 9, joints: { shoulder: -1 } } }), false);
  close(stage.jointOf('arm-1', 'shoulder')!, 0.5, 'shoulder unchanged');

  // joints only: the place stays where the last state put it
  assert.equal(stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 12, joints: { shoulder: -0.25 } } }), true);
  close(stage.jointOf('arm-1', 'shoulder')!, -0.25, 'shoulder');
  assert.deepEqual(stage.placeOf('arm-1')!.position, [1, -2, 0]);
});

test('a state comes by the outside name the scene gives a device', async () => {
  const { stage } = makeStage();
  await stage.setScene({ site: 'lab', devices: [arm()], names: { left: 'arm-1' }, streamNames: { solo: 'arm-1' } });
  assert.equal(stage.applyState({ topic: 'ps/lab/arm-1/state', payload: { at: 1, joints: { shoulder: 0.2 } } }), false, 'the id itself is not a name here');
  assert.equal(stage.applyState({ topic: 'ps/lab/left/state', payload: { at: 2, joints: { shoulder: 0.4 } } }), true);
  close(stage.jointOf('arm-1', 'shoulder')!, 0.4, 'by names');
  assert.equal(stage.applyState({ topic: 'ps/lab/solo/state', payload: { at: 3, joints: { shoulder: 0.6 } } }), true);
  close(stage.jointOf('arm-1', 'shoulder')!, 0.6, 'by streamNames');
});

test('a state that comes before the robot is built is shown once it is (a pane opened late)', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const { stage } = makeStage({ resolveBundle: async () => { await held; return armResolve(); } });
  const built = stage.setScene(scene([arm()]));
  assert.equal(stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 5, joints: { shoulder: 0.7 }, position: [0.5, 0, 0] } }), true);
  assert.deepEqual(stage.placeOf('arm-1')!.position, [0.5, 0, 0], 'the place at once');
  release();
  await built;
  close(stage.jointOf('arm-1', 'shoulder')!, 0.7, 'the joints once built');
});

test('an item state moves its box, and clearStates puts everything back at its pose', async () => {
  const { stage } = makeStage();
  await stage.setScene(scene([arm({ pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } }), { id: 'crate', type: 'item', parent: 'site', pose: { xyz: [0, 0, 0.1], rpy: [0, 0, 0] } }]));
  assert.equal(stage.applyState({ topic: 'ps/local/crate/state', payload: { at: 1, type: 'item', parent: 'site', xyz: [2, 3, 0.1] } }), true);
  assert.deepEqual(stage.placeOf('crate')!.position, [2, 3, 0.1]);
  // carried by the arm: hung on its holder
  assert.equal(stage.applyState({ topic: 'ps/local/crate/state', payload: { at: 2, type: 'item', parent: 'arm-1', xyz: [0, 0, 0.3] } }), true);
  assert.equal(stage.scene.getObjectByName('device:crate').parent.name, 'device:arm-1');
  stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 3, joints: { shoulder: 0.5 }, position: [4, 4, 0] } });

  stage.clearStates();
  assert.deepEqual(stage.placeOf('arm-1')!.position, [1, 0, 0]);
  assert.equal(stage.jointOf('arm-1', 'shoulder'), 0);
  assert.deepEqual(stage.placeOf('crate')!.position, [0, 0, 0.1]);
  assert.equal(stage.scene.getObjectByName('device:crate').parent.name, 'site');
  // and an old state counts again after it
  assert.equal(stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 1, joints: { shoulder: 0.1 } } }), true);
});

test('a scene that moves a device puts it at its new pose; one that does not keeps the state on it', async () => {
  const { stage } = makeStage();
  const first = scene([arm({ pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } })]);
  await stage.setScene(first);
  stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 1, joints: { shoulder: 0.5 }, position: [3, 3, 0] } });
  await stage.setScene({ ...first, floor: null });
  assert.deepEqual(stage.placeOf('arm-1')!.position, [3, 3, 0], 'the state stays');
  close(stage.jointOf('arm-1', 'shoulder')!, 0.5, 'joints stay');
});

/** A camera 3 m from the origin, turned a little about x and y, with an off-centre principal point. */
function knownCamera(): SolvedCamera {
  const turn = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.4, -0.3, 0.1, 'XYZ'));
  const e = turn.elements; // column-major
  const R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
  return {
    intr: { fx: 900, fy: 880, cx: 660, cy: 340, width: 1280, height: 720, dist: [0, 0, 0, 0, 0] },
    extr: { R, t: [0.2, -0.4, 3] },
  };
}

test('a solved camera is applied as PS.com applies it: position −Rᵀt, basis (r0,r1,r2) (−r3,−r4,−r5) (−r6,−r7,−r8), the lens through frustumOf', () => {
  const { stage } = makeStage();
  const cam = knownCamera();
  stage.setCamera(cam);
  const r = cam.extr.R;
  const t = cam.extr.t;
  const camera = stage.camera;
  close(camera.position.x, -(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]), 'x');
  close(camera.position.y, -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]), 'y');
  close(camera.position.z, -(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]), 'z');
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(r[0], r[1], r[2]), new THREE.Vector3(-r[3], -r[4], -r[5]), new THREE.Vector3(-r[6], -r[7], -r[8]),
  );
  const expected = new THREE.Quaternion().setFromRotationMatrix(basis);
  close(Math.abs(camera.quaternion.dot(expected)), 1, 'quaternion');
  const f = frustumOf(cam.intr);
  close(camera.fov, f.fovDeg, 'fov');
  close(camera.aspect, f.aspect, 'aspect');
  assert.deepEqual([camera.near, camera.far], [0.05, 600]);
  assert.deepEqual(
    [camera.view.fullWidth, camera.view.fullHeight, camera.view.offsetX, camera.view.offsetY, camera.view.width, camera.view.height],
    [f.view.fullWidth, f.view.fullHeight, f.view.offsetX, f.view.offsetY, f.view.width, f.view.height],
  );

  // and so three draws a point where the camera model puts it
  for (const p of [{ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0.2, z: -0.4 }, { x: -0.3, y: 0, z: 0.6 }]) {
    const want = projectPoint(cam.intr, cam.extr, p)!;
    const ndc = new THREE.Vector3(p.x, p.y, p.z).project(camera);
    close((ndc.x + 1) / 2 * 1280, want.u, `u of ${JSON.stringify(p)}`, 1e-6 * 1280);
    close((1 - ndc.y) / 2 * 720, want.v, `v of ${JSON.stringify(p)}`, 1e-6 * 720);
  }
});

test('with no camera the orbit camera of orbit.js is used', () => {
  const { stage } = makeStage();
  stage.setCamera(knownCamera());
  stage.setCamera(null);
  const eye = orbitEye(defaultOrbit());
  assert.equal(stage.camera.view === null || stage.camera.view.enabled === false, true, 'no view offset');
  close(stage.camera.position.x, eye.x, 'x');
  close(stage.camera.position.y, eye.y, 'y');
  close(stage.camera.position.z, eye.z, 'z');
  close(stage.camera.fov, 50, 'fov');
});

test('over a background the 3D is drawn only into the picture\'s rectangle (fitRect), and the picture is laid there', () => {
  const overlay = { style: {} as Record<string, string> };
  const { stage, renderer } = makeStage({ overlay });
  const media = { style: {} as Record<string, string> };
  stage.setBackground(media, { width: 1280, height: 720 });
  // 640 × 480 box, 16:9 picture: 640 × 360 from y = 60
  assert.deepEqual(media.style, { left: '0px', top: '60px', width: '640px', height: '360px' });
  assert.deepEqual(overlay.style, media.style);
  assert.deepEqual(renderer.calls.viewport.at(-1), [0, 60, 640, 360]);
  assert.equal(stage.scene.background, null, 'no sky over a picture');
  stage.setBackground(null, null);
  assert.deepEqual(renderer.calls.viewport.at(-1), [0, 0, 640, 480]);
  assert.ok(stage.scene.background, 'the sky again');
});

test('a point of the page is a pixel of the picture and, through the solved camera, a point on the floor in ROS', () => {
  const { stage } = makeStage();
  const cam = knownCamera();
  stage.setBackground({ style: {} }, { width: 1280, height: 720 });
  stage.setCamera(cam);
  assert.deepEqual(stage.pixelAt(320, 240), { u: 640, v: 360 });
  assert.equal(stage.pixelAt(320, 30), null, 'above the picture');
  // A floor point (site frame, y = 0) seen by the camera, back from the page
  const site = { x: 0.4, y: 0, z: -0.3 };
  const px = projectPoint(cam.intr, cam.extr, site)!;
  const ros = stage.floorPointAt(px.u / 2, px.v / 2 + 60)!;
  close(ros[0], 0.4, 'ROS x', 1e-6);
  close(ros[1], 0.3, 'ROS y (= −z)', 1e-6);
});

test('with no camera a point of the page meets the floor through the orbit camera', () => {
  const { stage } = makeStage();
  // the middle of the view looks through the orbit's target and meets the floor beyond it
  const orbit = defaultOrbit();
  const eye = orbitEye(orbit);
  const dir = { x: orbit.target.x - eye.x, y: orbit.target.y - eye.y, z: orbit.target.z - eye.z };
  const s = -eye.y / dir.y;
  const ros = stage.floorPointAt(320, 240)!;
  close(ros[0], eye.x + dir.x * s, 'ROS x', 1e-6);
  close(ros[1], -(eye.z + dir.z * s), 'ROS y', 1e-6);
  assert.equal(stage.floorPointAt(700, 240), null, 'off the stage');
});

test('frame() draws the picture and then the 3D into one PNG at the picture\'s size', async () => {
  const drawn: any[] = [];
  const made: any = {
    getContext: () => ({ drawImage: (...args: any[]) => drawn.push(args) }),
    toBlob: (done: (b: Blob) => void, type: string) => done(new Blob(['png'], { type })),
  };
  const { stage, renderer, canvas } = makeStage({ makeCanvas: () => made });
  const media = { style: {} };
  stage.setBackground(media, { width: 1280, height: 720 });
  const before = renderer.calls.render;
  const blob = await stage.frame();
  assert.equal(blob.type, 'image/png');
  assert.deepEqual([made.width, made.height], [1280, 720]);
  assert.equal(drawn[0][0], media);
  assert.deepEqual(drawn[1], [canvas, 0, 60, 640, 360, 0, 0, 1280, 720]);
  assert.equal(renderer.calls.render, before + 1, 'rendered right before it was copied');
});

test('frame() with maxSide makes the picture smaller so its longest side fits, keeping its shape', async () => {
  const drawn: any[] = [];
  const made: any = {
    getContext: () => ({ drawImage: (...args: any[]) => drawn.push(args) }),
    toBlob: (done: (b: Blob) => void, type: string) => done(new Blob(['png'], { type })),
  };
  const { stage, canvas } = makeStage({ makeCanvas: () => made });
  const media = { style: {} };
  stage.setBackground(media, { width: 1920, height: 1080 });
  await stage.frame({ maxSide: 1280 });
  assert.deepEqual([made.width, made.height], [1280, 720]);
  assert.deepEqual(drawn[0], [media, 0, 0, 1280, 720]);
  assert.deepEqual(drawn[1], [canvas, 0, 60, 640, 360, 0, 0, 1280, 720]);
  // a smaller picture stays at its own size
  stage.setBackground(media, { width: 800, height: 600 });
  await stage.frame({ maxSide: 1280 });
  assert.deepEqual([made.width, made.height], [800, 600]);
});

test('frame() with states draws them on the stage\'s own copy, then puts back what it showed (the live states, an item\'s parent)', async () => {
  const made: any = { getContext: () => ({ drawImage() {} }), toBlob: (done: (b: Blob) => void, type: string) => done(new Blob(['png'], { type })) };
  const seen: any[] = [];
  let stage: any;
  const renderer = { ...fakeRenderer(), render() { if (stage) seen.push({ shoulder: stage.jointOf('arm-1', 'shoulder'), arm: stage.placeOf('arm-1').position, crate: stage.scene.getObjectByName('device:crate').parent.name }); } };
  stage = createPaneStage(fakeCanvas(), { resolveBundle: armResolve, fetchImpl: catalogFetch(), robotBuild: robotBuild as any, renderer: () => renderer, makeCanvas: () => made });
  await stage.setScene(scene([arm({ pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } }), { id: 'crate', type: 'item', parent: 'site', pose: { xyz: [0, 0, 0.1], rpy: [0, 0, 0] } }]));
  // live: the arm has moved and holds the crate
  stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 50, joints: { shoulder: 0.5 }, position: [4, 4, 0] } });
  stage.applyState({ topic: 'ps/local/crate/state', payload: { at: 50, type: 'item', parent: 'arm-1', xyz: [0, 0, 0.3] } });
  seen.length = 0;

  // at an earlier stream time (older `at` than the live ones): only the arm's joints are known then
  await stage.frame({ states: [{ topic: 'ps/local/arm-1/state', payload: { at: 10, joints: { shoulder: -0.3 } } }] });
  assert.equal(seen.length, 1);
  close(seen[0].shoulder, -0.3, 'shoulder drawn at the time');
  assert.deepEqual(seen[0].arm, [1, 0, 0], 'no place then: the pose');
  assert.equal(seen[0].crate, 'site', 'the crate not carried then');

  close(stage.jointOf('arm-1', 'shoulder'), 0.5, 'live shoulder back');
  assert.deepEqual(stage.placeOf('arm-1').position, [4, 4, 0]);
  assert.equal(stage.scene.getObjectByName('device:crate').parent.name, 'device:arm-1');
  // the live view goes on: an older state than the live one still does not win
  assert.equal(stage.applyState({ topic: 'ps/local/arm-1/state', payload: { at: 20, joints: { shoulder: 1 } } }), false);
  // no states: drawn as it is
  seen.length = 0;
  await stage.frame();
  close(seen[0].shoulder, 0.5, 'as it is');
});

test('dispose stops the loop and lets the renderer go', () => {
  const { stage, renderer, canvas } = makeStage();
  stage.dispose();
  assert.equal(renderer.calls.loop.at(-1), null);
  assert.equal(renderer.calls.dispose, 1);
  assert.equal((canvas.listeners.pointerdown ?? []).length, 0);
});

test('the site hangs in the camera\'s world as PS.com\'s video stage hangs it: ROS (x, y, z) is the site frame\'s (x, z, −y)', async () => {
  const { stage } = makeStage();
  await stage.setScene(scene(
    [{ id: 'crate', type: 'item', parent: 'site', pose: { xyz: [1, -2, 0.5], rpy: [0, 0, 0] } }],
    { floor: { corners: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 3, y: 0, z: 4 }, { x: 0, y: 0, z: 4 }], edgesM: [3, 4] } },
  ));
  stage.scene.updateMatrixWorld(true);
  const at = stage.scene.getObjectByName('device:crate').getWorldPosition(new THREE.Vector3());
  close(at.x, 1, 'site x'); close(at.y, 0.5, 'site y (up)'); close(at.z, 2, 'site z');
  // the floor's line runs through the site corners the camera was solved on
  const line = stage.scene.getObjectByName('floor');
  const positions = line.geometry.getAttribute('position');
  const corner = (i: number) => new THREE.Vector3(positions.getX(i), positions.getY(i), positions.getZ(i)).applyMatrix4(line.matrixWorld);
  for (const [i, [x, z]] of [[0, 0], [3, 0], [3, 4], [0, 4]].entries()) {
    close(corner(i).x, x, `corner ${i + 1} x`); close(corner(i).z, z, `corner ${i + 1} z`); close(corner(i).y, 0.004, `corner ${i + 1} just above`);
  }
  // and a point picked on the floor is that place in ROS
  const cam = knownCamera();
  stage.setBackground({ style: {} }, { width: 1280, height: 720 });
  stage.setCamera(cam);
  const px = projectPoint(cam.intr, cam.extr, { x: 1, y: 0, z: 2 })!;
  const ros = stage.floorPointAt(px.u / 2, px.v / 2 + 60)!;
  close(ros[0], 1, 'ROS x', 1e-6); close(ros[1], -2, 'ROS y', 1e-6);
});
