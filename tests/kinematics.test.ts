// Joints from bundle.json: tests for src/core/kinematics.ts. The forward pose is checked against a
// MuJoCo reference stored in the so101 fixture and against PS.com's drawing (robot-build.js), which
// must put every link where the solver thinks it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { Robot } from '../src/pscom/robot-build.js';
import { chainOf, forward, solvePosition, toBaseFrame, type KinematicBundle } from '../src/core/kinematics.js';

const fixture = (name: string): any => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
const so101 = fixture('so101-bundle.json');
const openarm = fixture('openarm-bundle.json');

const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Where robot-build.js draws `link` (position and quaternion in the root link's frame) for these joint values. */
function drawn(bundle: any, link: string, joints: Record<string, number>): { xyz: number[]; quat: number[] } {
  const robot: any = new Robot(bundle);
  robot.resetJoints();
  for (const [name, value] of Object.entries(joints)) robot.setJoint(name, value);
  robot.rosRoot.removeFromParent();
  robot.rosRoot.updateMatrixWorld(true);
  const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
  robot.linkGroups.get(link).matrixWorld.decompose(p, q, s);
  return { xyz: p.toArray(), quat: [q.x, q.y, q.z, q.w] };
}

/** The angle between two orientations [rad]. */
const turn = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

function withinLimits(bundle: KinematicBundle, joints: Record<string, number>): void {
  for (const [name, value] of Object.entries(joints)) {
    assert.ok(Number.isFinite(value), `${name} is ${value}`);
    const joint = bundle.joints.find((j) => j.name === name)!;
    if (joint.type === 'revolute' || joint.type === 'prismatic') {
      assert.ok(value >= joint.lower! - 1e-12 && value <= joint.upper! + 1e-12, `${name} ${value} outside [${joint.lower}, ${joint.upper}]`);
    }
  }
}

/** A small arm: a continuous base, a revolute shoulder, an elbow that follows the shoulder (mimic), a prismatic slide. */
function mimicArm(): any {
  const origin = (xyz: number[], rpy = [0, 0, 0]) => ({ xyz, rpy });
  return {
    rootLink: 'base',
    links: Object.fromEntries(['base', 'l0', 'l1', 'l2', 'l3', 'tool'].map((n) => [n, { visuals: [] }])),
    joints: [
      { name: 'yaw', type: 'continuous', parent: 'base', child: 'l0', origin: origin([0, 0, 0.05]), axis: [0, 0, 1], lower: 0, upper: 0 },
      { name: 'shoulder', type: 'revolute', parent: 'l0', child: 'l1', origin: origin([0, 0, 0.1], [0.1, 0, 0]), axis: [0, 1, 0], lower: -1.5, upper: 1.5 },
      { name: 'elbow', type: 'revolute', parent: 'l1', child: 'l2', origin: origin([0.2, 0, 0]), axis: [0, 1, 0], lower: -2, upper: 2,
        mimic: { joint: 'shoulder', multiplier: 2, offset: 0.1 } },
      { name: 'slide', type: 'prismatic', parent: 'l2', child: 'l3', origin: origin([0.15, 0, 0]), axis: [1, 0, 0], lower: 0, upper: 0.1 },
      { name: 'tool_joint', type: 'fixed', parent: 'l3', child: 'tool', origin: origin([0.03, 0, 0], [0, 0.3, 0]), axis: [0, 0, 0], lower: 0, upper: 0 },
    ],
    chains: [{ name: 'arm', baseLink: 'base', tipLink: 'tool', joints: ['yaw', 'shoulder', 'slide'] }],
  };
}

test('chainOf: the chain\'s joints in order, from bundle.chains or from the profile\'s chains (jointNames)', () => {
  const arm = chainOf(so101, 'arm');
  assert.deepEqual(arm.joints.map((j) => j.name), ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll']);
  assert.equal(arm.tipLink, 'gripper_frame_link');
  // the path goes on to the tip through the fixed joint
  assert.deepEqual(arm.path.map((j) => j.name), ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper_frame_joint']);

  const { chains: _gone, ...noChains } = openarm;
  const profile = { chains: [{ name: 'right_arm', baseLink: 'openarm_right_base_link', tipLink: 'openarm_right_ee_base_link', jointNames: openarm.chains[1].joints }] };
  const right = chainOf({ ...noChains, profile }, 'right_arm');
  assert.deepEqual(right.joints.map((j) => j.name), openarm.chains[1].joints);
  // from the root link (world) through the body and the mount
  assert.deepEqual(right.path.slice(0, 2).map((j) => j.name), ['openarm_body_link0_mount_joint', 'openarm_right_base_link_mount_joint']);

  assert.throws(() => chainOf(so101, 'leg'), /leg/);
  assert.throws(() => chainOf({ ...so101, chains: [{ name: 'arm', baseLink: 'base_link', tipLink: 'nowhere', joints: [] }] }, 'arm'), /nowhere/);
  assert.throws(() => chainOf({ ...so101, chains: [{ name: 'arm', baseLink: 'base_link', tipLink: 'gripper_frame_link', joints: ['ghost'] }] }, 'arm'), /ghost/);
});

test('forward: so101\'s tip matches the MuJoCo reference within 1 mm', () => {
  const arm = chainOf(so101, 'arm');
  assert.equal(so101.forwardReference.length, 4);
  for (const { joints, tip } of so101.forwardReference) {
    const { xyz, quat } = forward(so101, arm, joints);
    assert.ok(distance(xyz, tip) <= 0.001, `${JSON.stringify(joints)}: ${xyz} vs ${tip}`);
    assert.ok(Math.abs(Math.hypot(...quat) - 1) < 1e-9);
  }
});

test('forward agrees with robot-build.js (position and orientation) on so101, both OpenArm arms and a mimic arm', () => {
  const cases: [any, string, Record<string, number>][] = [
    ...so101.forwardReference.map((r: any) => [so101, 'arm', r.joints] as [any, string, Record<string, number>]),
    [openarm, 'left_arm', {}],
    [openarm, 'left_arm', { openarm_left_joint1: -1.2, openarm_left_joint2: -0.9, openarm_left_joint3: 0.4, openarm_left_joint4: 1.3, openarm_left_joint5: -0.6, openarm_left_joint6: 0.5, openarm_left_joint7: 1.1 }],
    [openarm, 'right_arm', { openarm_right_joint1: 0.7, openarm_right_joint2: 1.4, openarm_right_joint3: -1.0, openarm_right_joint4: 2.0, openarm_right_joint5: 0.9, openarm_right_joint6: -0.3, openarm_right_joint7: -1.4 }],
    // beyond the limits: both clamp
    [openarm, 'left_arm', { openarm_left_joint4: -1, openarm_left_joint6: 2 }],
    [mimicArm(), 'arm', { yaw: 4, shoulder: 0.6, slide: 0.05 }],
    [mimicArm(), 'arm', { yaw: -0.3, shoulder: 1.2, slide: 0.5 }],
  ];
  for (const [bundle, name, joints] of cases) {
    const chain = chainOf(bundle, name);
    const mine = forward(bundle, chain, joints);
    const theirs = drawn(bundle, chain.tipLink, joints);
    assert.ok(distance(mine.xyz, theirs.xyz) < 1e-6, `${name} ${JSON.stringify(joints)}: ${mine.xyz} vs ${theirs.xyz}`);
    assert.ok(turn(mine.quat, theirs.quat) < 1e-6, `${name} ${JSON.stringify(joints)}: ${mine.quat} vs ${theirs.quat}`);
  }
});

test('a joint that follows another (mimic) moves with its leader', () => {
  const bundle = mimicArm();
  const chain = chainOf(bundle, 'arm');
  const at = (shoulder: number) => forward(bundle, chain, { shoulder }).xyz;
  // the elbow at 2·0.5+0.1 = 1.1 bends the forearm: the tip is not where a straight arm puts it
  const unbent = { ...bundle, joints: bundle.joints.map((j: any) => (j.name === 'elbow' ? { ...j, mimic: undefined } : j)) };
  const straight = forward(unbent, chainOf(unbent, 'arm'), { shoulder: 0.5 }).xyz;
  assert.ok(distance(at(0.5), straight) > 0.05);
  // giving the follower a value of its own changes nothing: it follows
  assert.deepEqual(forward(bundle, chain, { shoulder: 0.5, elbow: -1 }).xyz, at(0.5));

  const target = forward(bundle, chain, { yaw: 0.4, shoulder: 0.3, slide: 0.02 }).xyz;
  const solved = solvePosition(bundle, chain, target);
  assert.equal(solved.reached, true, JSON.stringify(solved));
  assert.deepEqual(Object.keys(solved.joints).sort(), ['elbow', 'shoulder', 'slide', 'yaw']);
  assert.ok(Math.abs(solved.joints.elbow - (2 * solved.joints.shoulder + 0.1)) < 1e-12);
  withinLimits(bundle, solved.joints);
});

test('solvePosition reaches a reachable target within 2 mm and stays within the limits (so101, OpenArm)', () => {
  const cases: [any, string, Record<string, number>][] = [
    [so101, 'arm', so101.forwardReference[1].joints],
    [so101, 'arm', so101.forwardReference[2].joints],
    [openarm, 'left_arm', { openarm_left_joint1: -1.2, openarm_left_joint2: -0.9, openarm_left_joint3: 0.4, openarm_left_joint4: 1.3, openarm_left_joint5: -0.6, openarm_left_joint6: 0.5, openarm_left_joint7: 1.1 }],
    [openarm, 'right_arm', { openarm_right_joint1: 0.7, openarm_right_joint2: 1.4, openarm_right_joint3: -1.0, openarm_right_joint4: 2.0, openarm_right_joint5: 0.9, openarm_right_joint6: -0.3, openarm_right_joint7: -1.4 }],
  ];
  for (const [bundle, name, joints] of cases) {
    const chain = chainOf(bundle, name);
    const target = forward(bundle, chain, joints).xyz;
    const solved = solvePosition(bundle, chain, target);
    assert.equal(solved.reached, true, `${name}: ${JSON.stringify(solved)}`);
    assert.ok(solved.errorM <= 0.002);
    assert.ok(distance(forward(bundle, chain, solved.joints).xyz, target) <= 0.002);
    assert.deepEqual(Object.keys(solved.joints).sort(), chain.joints.map((j) => j.name).sort(), 'the chain\'s joints only');
    withinLimits(bundle, solved.joints);
  }
});

test('solvePosition starts from the seed and returns at once when the seed is already there', () => {
  const chain = chainOf(so101, 'arm');
  const seed = so101.forwardReference[3].joints;
  const target = forward(so101, chain, seed).xyz;
  const solved = solvePosition(so101, chain, target, { seed, maxIterations: 0 });
  assert.equal(solved.reached, true);
  assert.deepEqual(solved.joints, seed);
});

test('a target out of reach: reached false, the closest joints found, finite and within the limits', () => {
  for (const [bundle, name, target] of [
    [so101, 'arm', [3, 2, 1]],
    [so101, 'arm', [0, 0, -10]],
    [openarm, 'left_arm', [0, 4, 0.5]],
    [openarm, 'right_arm', [-0.01, -0.01, -0.01]],
    [mimicArm(), 'arm', [1e6, -1e6, 1e6]],
  ] as [any, string, number[]][]) {
    const chain = chainOf(bundle, name);
    const solved = solvePosition(bundle, chain, target);
    assert.equal(solved.reached, false, name);
    assert.ok(Number.isFinite(solved.errorM) && solved.errorM > 0.002, `${name}: ${solved.errorM}`);
    withinLimits(bundle, solved.joints);
    // the error is the real distance of those joints' tip
    assert.ok(Math.abs(distance(forward(bundle, chain, solved.joints).xyz, target) - solved.errorM) < 1e-9);
  }
  // nearer than the start: the arm stretches toward a target beyond its reach
  const chain = chainOf(so101, 'arm');
  const far = [0, 1, 0.2];
  const start = distance(forward(so101, chain, {}).xyz, far);
  assert.ok(solvePosition(so101, chain, far).errorM < start - 0.1);
});

test('toBaseFrame: a site-frame point into the robot base frame of a device placed at xyz, turned by yaw', () => {
  const near = (a: number[], b: number[]) => assert.ok(distance(a, b) < 1e-12, `${a} vs ${b}`);
  near(toBaseFrame([1, 2, 3], { xyz: [0, 0, 0], yaw: 0 }), [1, 2, 3]);
  near(toBaseFrame([1, 2, 0.5], { xyz: [1, 1, 0], yaw: 0 }), [0, 1, 0.5]);
  // turned a quarter left: the site's +y is the robot's +x
  near(toBaseFrame([2, 3, 0.2], { xyz: [2, 2, 0], yaw: Math.PI / 2 }), [1, 0, 0.2]);
  near(toBaseFrame([0, 0, 0], { xyz: [1, 0, 0], yaw: Math.PI }), [1, 0, 0]);
});
