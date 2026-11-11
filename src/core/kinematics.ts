/**
 * A robot's joints from its bundle.json, without meshes: where a chain's tip is for given joint
 * values (`forward`), and joint values that put the tip at a point (`solvePosition`).
 *
 * The joint math is robot-build.js's (PS.com's drawing, src/pscom): each joint's child frame is
 * origin · motion(q), the origin's rpy is R = Rz(yaw)·Ry(pitch)·Rx(roll), a revolute or continuous
 * joint turns about its axis by q, a prismatic one slides along it; revolute and prismatic values
 * are clamped to their limits; a joint with `mimic` takes `multiplier · leader + offset` (clamped
 * to its own limits) whatever it is given. So the tip is where the pane draws it.
 *
 * Frames: everything is in the robot base frame, which is the bundle's root link (`rootLink`),
 * the frame a device's pose places in the site. ROS metres and radians, z up.
 */

export type Vec3 = [number, number, number];
/** A quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];

export interface Joint {
  name: string;
  type: string;
  parent: string;
  child: string;
  origin?: { xyz?: number[]; rpy?: number[] };
  axis?: number[];
  lower?: number;
  upper?: number;
  mimic?: { joint: string; multiplier?: number; offset?: number };
}

/** A chain as bundle.json has it (`joints`) or as a catalog profile has it (`jointNames`). */
export interface ChainSpec { name: string; baseLink: string; tipLink: string; joints?: string[]; jointNames?: string[] }

export interface KinematicBundle {
  rootLink: string;
  joints: Joint[];
  chains?: ChainSpec[];
  /** The catalog manifest's profile: its chains are used when the bundle has none. */
  profile?: { chains?: ChainSpec[] };
}

export interface Chain {
  name: string;
  baseLink: string;
  tipLink: string;
  /** The joints the chain moves, in its order. */
  joints: Joint[];
  /** Every joint from the root link to the tip link, root first (fixed ones and mounts included). */
  path: Joint[];
}

export interface SolveOptions {
  /** Where to start: joint values by name (the chain's, and any other joint on the path, which stays as given). */
  seed?: Record<string, number>;
  maxIterations?: number;
  /** The tip is there when it is this close [m]. */
  tolM?: number;
}

export interface Solved {
  /** The chain's joints, and the joints that follow one of them (mimic). */
  joints: Record<string, number>;
  /** How far the tip of those joints is from the target [m]. */
  errorM: number;
  reached: boolean;
}

export const IK_DEFAULTS = { maxIterations: 200, tolM: 0.002, lambda: 0.05 };
/** The largest change of one joint in one step [rad or m]: big steps overshoot where the arm bends. */
const MAX_STEP = 0.3;
/** The finite difference of the numerical Jacobian. */
const H = 1e-6;

// ---- 3×3 rotations (row-major) and frames ----

type Mat3 = number[];
interface Frame { r: Mat3; t: Vec3 }

const IDENTITY: Frame = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function mul3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9);
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return out;
}
const apply3 = (r: Mat3, v: number[]): Vec3 => [
  r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
  r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
  r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
];
const compose = (a: Frame, b: Frame): Frame => {
  const moved = apply3(a.r, b.t);
  return { r: mul3(a.r, b.r), t: [a.t[0] + moved[0], a.t[1] + moved[1], a.t[2] + moved[2]] };
};

/** R = Rz(yaw)·Ry(pitch)·Rx(roll), URDF's fixed-axis roll-pitch-yaw. */
function fromRpy(rpy: number[]): Mat3 {
  const [cr, sr] = [Math.cos(rpy[0]), Math.sin(rpy[0])];
  const [cp, sp] = [Math.cos(rpy[1]), Math.sin(rpy[1])];
  const [cy, sy] = [Math.cos(rpy[2]), Math.sin(rpy[2])];
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
    -sp, cp * sr, cp * cr,
  ];
}

/** A turn by `angle` about the unit `axis` (Rodrigues). */
function aboutAxis(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = axis;
  const c = Math.cos(angle); const s = Math.sin(angle); const k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

function quatOf(r: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = r;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return q.map((v) => v / n) as Quat;
}

const vec3 = (v: unknown, fallback: Vec3 = [0, 0, 0]): Vec3 =>
  (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : fallback);

function unitAxis(joint: Joint): Vec3 {
  const a = vec3(joint.axis, [1, 0, 0]);
  const n = Math.hypot(...a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [1, 0, 0];
}

const limited = (joint: Joint): boolean => (joint.type === 'revolute' || joint.type === 'prismatic')
  && Number.isFinite(joint.lower) && Number.isFinite(joint.upper);

/** A value within the joint's limits (revolute and prismatic; continuous ones turn freely). */
export function clampJoint(joint: Joint, value: number): number {
  return limited(joint) ? Math.min(joint.upper!, Math.max(joint.lower!, value)) : value;
}

// ---- chains ----

/** The bundle's chains, or its catalog profile's when the bundle has none. */
export function chainSpecsOf(bundle: KinematicBundle): ChainSpec[] {
  const own = Array.isArray(bundle?.chains) && bundle.chains.length > 0 ? bundle.chains : bundle?.profile?.chains;
  return Array.isArray(own) ? own.filter((c) => c && typeof c.name === 'string') : [];
}

/**
 * A chain of the bundle by name: its joints in order, and the path of joints from the root link
 * to its tip link. Throws when there is no such chain, when the tip link does not hang from the
 * root link, or when the chain names a joint the bundle does not have.
 */
export function chainOf(bundle: KinematicBundle, chainName: string): Chain {
  const specs = chainSpecsOf(bundle);
  const spec = specs.find((c) => c?.name === chainName);
  if (!spec) throw new Error(`no chain ${chainName} (chains: ${specs.map((c) => c?.name).join(', ') || 'none'})`);
  const joints = Array.isArray(bundle.joints) ? bundle.joints : [];
  const byChild = new Map(joints.map((j) => [j.child, j]));
  const path: Joint[] = [];
  const seen = new Set<string>();
  for (let link = spec.tipLink; link !== bundle.rootLink;) {
    const joint = byChild.get(link);
    if (!joint || seen.has(link)) throw new Error(`chain ${chainName}: the tip link ${spec.tipLink} does not hang from the root link ${bundle.rootLink}`);
    seen.add(link);
    path.unshift(joint);
    link = joint.parent;
  }
  const names = spec.joints ?? spec.jointNames ?? [];
  const chainJoints = names.map((name) => {
    const joint = joints.find((j) => j.name === name);
    if (!joint) throw new Error(`chain ${chainName}: no joint ${name}`);
    return joint;
  });
  return { name: spec.name, baseLink: spec.baseLink, tipLink: spec.tipLink, joints: chainJoints, path };
}

/** The joints that follow one of `leaders` (mimic), anywhere in the bundle. */
export function followersOf(bundle: KinematicBundle, leaders: Joint[]): Joint[] {
  const names = new Set(leaders.map((j) => j.name));
  return (bundle.joints ?? []).filter((j) => j.mimic && names.has(j.mimic.joint));
}

// ---- forward ----

/**
 * The value each joint takes: its own (clamped), or a follower's from its leader's (clamped, then
 * clamped again to its own limits, as robot-build.js does). `clamp: false` is for the Jacobian,
 * which needs the smooth map also at a limit.
 */
function valueOf(bundle: KinematicBundle, joint: Joint, given: Record<string, number>, clamp: boolean): number {
  const own = (j: Joint): number => {
    const v = Number.isFinite(given[j.name]) ? given[j.name] : 0;
    return clamp ? clampJoint(j, v) : v;
  };
  if (!joint.mimic) return own(joint);
  const leader = bundle.joints.find((j) => j.name === joint.mimic!.joint);
  const lead = leader ? own(leader) : 0;
  const v = lead * (joint.mimic.multiplier ?? 1) + (joint.mimic.offset ?? 0);
  return clamp ? clampJoint(joint, v) : v;
}

function tipFrame(bundle: KinematicBundle, chain: Chain, given: Record<string, number>, clamp: boolean): Frame {
  let frame = IDENTITY;
  for (const joint of chain.path) {
    frame = compose(frame, { r: fromRpy(vec3(joint.origin?.rpy)), t: vec3(joint.origin?.xyz) });
    if (joint.type === 'fixed' || joint.type === 'floating' || joint.type === 'planar') continue;
    const q = valueOf(bundle, joint, given, clamp);
    const axis = unitAxis(joint);
    frame = joint.type === 'prismatic'
      ? compose(frame, { r: IDENTITY.r, t: [axis[0] * q, axis[1] * q, axis[2] * q] })
      : compose(frame, { r: aboutAxis(axis, q), t: [0, 0, 0] });
  }
  return frame;
}

/** The chain's tip link in the robot base frame (the root link) for these joint values (missing ones are 0). */
export function forward(bundle: KinematicBundle, chain: Chain, joints: Record<string, number> = {}): { xyz: Vec3; quat: Quat } {
  const frame = tipFrame(bundle, chain, joints, true);
  return { xyz: frame.t, quat: quatOf(frame.r) };
}

// ---- inverse, position only ----

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** x of (A)x = b for a 3×3 A (Cramer); null when A is singular. */
function solve3(a: Mat3, b: Vec3): Vec3 | null {
  const det = (m: Mat3) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const d = det(a);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
  const column = (i: number): Mat3 => a.map((v, k) => (k % 3 === i ? b[Math.floor(k / 3)] : v));
  return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d];
}

/** The middle of a joint's limits (0 for one without limits): a start away from the straight, singular poses. */
const middleOf = (joint: Joint): number => (limited(joint) ? (joint.lower! + joint.upper!) / 2 : 0);

/** Where the later starts put each joint, as a fraction of its range (one row per start). */
const OTHER_STARTS = [[0.25, 0.75], [0.75, 0.25], [0.1, 0.9]];

/**
 * Joint values that put the chain's tip at `target` (robot base frame), position only: damped
 * least squares on a numerical Jacobian (λ = 0.05), each step clamped to the joints' limits.
 * It starts from the seed (the chain's joints not in it at the middle of their limits); when that
 * does not reach the target it starts again from a few other poses (each up to `maxIterations`
 * steps) and keeps the closest. Joints on the path outside the chain stay as the seed gives them.
 * It never throws for a target out of reach: it answers the closest joints it found, with
 * `reached: false`.
 */
export function solvePosition(bundle: KinematicBundle, chain: Chain, target: Vec3 | number[], opts: SolveOptions = {}): Solved {
  if (!Array.isArray(target) || target.length !== 3 || !target.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new TypeError('the target must be three finite numbers');
  }
  const maxIterations = opts.maxIterations ?? IK_DEFAULTS.maxIterations;
  const tolM = opts.tolM ?? IK_DEFAULTS.tolM;
  const movers = chain.joints.filter((j) => j.type !== 'fixed' && !j.mimic);
  const given: Record<string, number> = {};
  for (const [name, v] of Object.entries(opts.seed ?? {})) if (typeof v === 'number' && Number.isFinite(v)) given[name] = v;
  const first = { ...given };
  for (const j of movers) first[j.name] = clampJoint(j, given[j.name] ?? middleOf(j));

  let best = descend(bundle, chain, movers, target, first, maxIterations, tolM);
  for (const fractions of OTHER_STARTS) {
    if (best.error <= tolM) break;
    const start = { ...given };
    movers.forEach((j, i) => {
      const f = fractions[i % fractions.length];
      start[j.name] = limited(j) ? j.lower! + (j.upper! - j.lower!) * f : (f - 0.5) * 2 * Math.PI;
    });
    const tried = descend(bundle, chain, movers, target, start, maxIterations, tolM);
    if (tried.error < best.error) best = tried;
  }

  const joints: Record<string, number> = {};
  for (const j of chain.joints) joints[j.name] = valueOf(bundle, j, best.values, true);
  for (const j of followersOf(bundle, chain.joints)) joints[j.name] = valueOf(bundle, j, best.values, true);
  return { joints, errorM: best.error, reached: best.error <= tolM };
}

/** One descent from `start`: the closest values it passed and their error. */
function descend(bundle: KinematicBundle, chain: Chain, movers: Joint[], target: number[], start: Record<string, number>,
  maxIterations: number, tolM: number): { values: Record<string, number>; error: number } {
  const lambda2 = IK_DEFAULTS.lambda ** 2;
  const tipOf = (v: Record<string, number>, clamp = true): Vec3 => tipFrame(bundle, chain, v, clamp).t;
  const values = { ...start };
  let tip = tipOf(values);
  let best = { values: { ...values }, error: dist(tip, target) };

  for (let iteration = 0; iteration < maxIterations && best.error > tolM; iteration += 1) {
    // J (3×n) by central differences, on the unclamped map
    const columns = movers.map((j) => {
      const plus = tipOf({ ...values, [j.name]: values[j.name] + H }, false);
      const minus = tipOf({ ...values, [j.name]: values[j.name] - H }, false);
      return [(plus[0] - minus[0]) / (2 * H), (plus[1] - minus[1]) / (2 * H), (plus[2] - minus[2]) / (2 * H)];
    });
    const e: Vec3 = [target[0] - tip[0], target[1] - tip[1], target[2] - tip[2]];
    // Δq = Jᵀ (J Jᵀ + λ² I)⁻¹ e, over the joints free to move: one held at a limit that the step
    // pushes further out is left out and the step worked out again without it
    const free = movers.map(() => true);
    let steps: number[] = [];
    for (let round = 0; round <= movers.length; round += 1) {
      const jjt: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      columns.forEach((c, i) => { if (free[i]) for (let r = 0; r < 3; r += 1) for (let s = 0; s < 3; s += 1) jjt[r * 3 + s] += c[r] * c[s]; });
      for (let r = 0; r < 3; r += 1) jjt[r * 4] += lambda2;
      const y = solve3(jjt, e);
      if (!y) { steps = []; break; }
      steps = columns.map((c, i) => (free[i] ? c[0] * y[0] + c[1] * y[1] + c[2] * y[2] : 0));
      const blocked = movers.map((j, i) => free[i] && limited(j)
        && ((values[j.name] <= j.lower! && steps[i] < 0) || (values[j.name] >= j.upper! && steps[i] > 0)));
      if (!blocked.some(Boolean)) break;
      blocked.forEach((b, i) => { if (b) free[i] = false; });
    }
    const largest = Math.max(0, ...steps.map(Math.abs));
    if (steps.length === 0 || !Number.isFinite(largest) || largest < 1e-9) break; // nowhere left to go
    if (largest > MAX_STEP) steps = steps.map((s) => (s * MAX_STEP) / largest);
    movers.forEach((j, i) => { values[j.name] = clampJoint(j, values[j.name] + steps[i]); });
    tip = tipOf(values);
    const error = dist(tip, target);
    if (!Number.isFinite(error)) break;
    if (error < best.error) best = { values: { ...values }, error };
  }
  return best;
}

// ---- placement ----

/** A point of the site frame in the robot base frame of a device placed at `xyz` and turned by `yaw` about z. */
export function toBaseFrame(point: Vec3 | number[], placement: { xyz: Vec3 | number[]; yaw?: number }): Vec3 {
  const yaw = placement.yaw ?? 0;
  const d = [point[0] - placement.xyz[0], point[1] - placement.xyz[1], point[2] - placement.xyz[2]];
  const c = Math.cos(yaw); const s = Math.sin(yaw);
  return [c * d[0] + s * d[1], -s * d[0] + c * d[1], d[2]];
}
