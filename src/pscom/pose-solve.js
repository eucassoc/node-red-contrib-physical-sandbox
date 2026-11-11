// Copied from app/src/pose-solve.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * Where a fixed camera is, solved from fixed points: points whose place in the world is known
 * and whose place in the picture a person has clicked.
 *
 * There is nearly always a start: the line-up a person made by eye (floor-pose.js), or the four
 * floor corners clicked on the picture (`poseFromFloorQuad`). So an iterative solve is enough:
 * `refinePose` takes the start to the pose that puts every point on its pixel, by Gauss–Newton
 * damped the Levenberg way, and says how far off the points still are, in pixels and in metres
 * on the floor. The camera itself is camera-model.js's: intrinsics `{ fx, fy, cx, cy, … }` and
 * world→camera extrinsics `{ R, t }`; every projection goes through it, none is redone here.
 *
 * The world is three's world (y up). Points are given in it; a recording's site frame is applied
 * by the callers. The little linear algebra this needs (a Gaussian elimination, a cross product)
 * is kept in this file.
 *
 * **Touches neither the DOM nor three.** Plain objects and numbers; angles in degrees where a person sees them.
 */

import { intrinsicsFromFov, projectPoint, rayThroughPixel, floorHit } from './camera-model.js';

/** Six unknowns need at least four points (eight numbers) to be pinned with something to spare. */
export const MIN_POINTS = 4;

const RAD = Math.PI / 180;
const JACOBIAN_STEP = 1e-6;
const LAMBDA_START = 1e-3;
const LAMBDA_MIN = 1e-12;
const LAMBDA_MAX = 1e12;
// The field of view a camera on site may have (floor-pose.js POSE_LIMITS.fovDeg); a focal
// length outside it means the clicked floor carries too little perspective to tell.
const FOV_RANGE_DEG = [15, 120];
// How far one click may be off. If moving any one clicked corner by this much moves the
// estimated field of view by more than FOV_SPREAD_DEG, the picture does not fix the lens.
const CLICK_PX = 1;
const FOV_SPREAD_DEG = 5;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => a.map((c) => c * s);
const normalise = (a) => scale(a, 1 / Math.hypot(...a));

const mul3 = (a, b) => {
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return out;
};

/** The rotation matrix (row-major) of a rotation vector `w`: about `w`, by |w| radians (Rodrigues). */
function rodrigues(w) {
  const angle = Math.hypot(...w);
  if (angle < 1e-15) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(w, 1 / angle);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const v = 1 - c;
  return [
    c + x * x * v, x * y * v - z * s, x * z * v + y * s,
    y * x * v + z * s, c + y * y * v, y * z * v - x * s,
    z * x * v - y * s, z * y * v + x * s, c + z * z * v,
  ];
}

/**
 * `A·x = b` by Gaussian elimination with partial pivoting; `A` is n rows of n numbers.
 * Null when A is singular (or its numbers are not finite).
 */
function solveLinear(A, b) {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (!(Math.abs(m[pivot][col]) > 1e-300)) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** The pose moved by `delta` = [rotation vector (applied on the camera's side), translation]. */
function moved(extr, delta) {
  const turn = rodrigues(delta.slice(0, 3));
  return { R: mul3(turn, extr.R), t: extr.t.map((c, i) => c + delta[3 + i]) };
}

/** Pixel residuals (projected − clicked), two per point, or null when a point falls behind the camera. */
function residuals(intr, points, extr) {
  const out = [];
  for (const { world, pixel } of points) {
    const p = projectPoint(intr, extr, world);
    if (!p) return null;
    out.push(p.u - pixel.u, p.v - pixel.v);
  }
  return out;
}

const sumSquares = (r) => r.reduce((s, x) => s + x * x, 0);

/** The 2N × 6 Jacobian of the residuals at `extr`, by central differences; null if a nudge loses a point. */
function jacobian(intr, points, extr) {
  const columns = [];
  for (let k = 0; k < 6; k++) {
    const step = new Array(6).fill(0);
    step[k] = JACOBIAN_STEP;
    const plus = residuals(intr, points, moved(extr, step));
    const minus = residuals(intr, points, moved(extr, step.map((s) => -s)));
    if (!plus || !minus) return null;
    columns.push(plus.map((p, i) => (p - minus[i]) / (2 * JACOBIAN_STEP)));
  }
  return columns;
}

/**
 * How far each point lands from where it is, for a solved pose: per point in pixels, the RMS
 * in pixels, and the RMS in metres of each clicked pixel taken back to the plane at its point's
 * height (the floor for a floor point) against the point itself. A pixel whose ray never meets
 * that plane is left out of the metres.
 */
function residualReport(intr, points, extr) {
  const r = residuals(intr, points, extr);
  const perPoint = points.map(({ id }, i) => ({ id, errPx: Math.hypot(r[2 * i], r[2 * i + 1]) }));
  const residualPx = Math.sqrt(sumSquares(r) / points.length);
  let squares = 0;
  let count = 0;
  for (const { world, pixel } of points) {
    const hit = floorHit(rayThroughPixel(intr, extr, pixel.u, pixel.v), world.y);
    if (!hit) continue;
    squares += (hit.x - world.x) ** 2 + (hit.z - world.z) ** 2;
    count += 1;
  }
  return { residualPx, residualM: count ? Math.sqrt(squares / count) : null, perPoint };
}

/**
 * The pose that puts each of `points` (`{ id, world: {x,y,z}, pixel: {u,v} }`) on its pixel,
 * starting from `initExtr`, with `intr` held: `{ extr, residualPx, residualM, perPoint, iterations }`.
 * Six unknowns (a rotation vector and a translation), a numeric Jacobian, and Levenberg's damping:
 * a step that makes things worse is taken back and the damping raised tenfold, so a far-off
 * start stays finite. It stops when a step gains less than `tolPx` of RMS. Null with fewer
 * than MIN_POINTS points, or when the start does not have every point in front of the camera.
 * `minPoints` (never below three) lets a caller solve from three when one fixed point was left
 * out as moved: six numbers for six unknowns, so only from a start already near the truth.
 */
export function refinePose(intr, points, initExtr, { maxIterations = 30, tolPx = 1e-3, minPoints = MIN_POINTS } = {}) {
  if (!Array.isArray(points) || points.length < Math.max(3, minPoints)) return null;
  let extr = { R: [...initExtr.R], t: [...initExtr.t] };
  let r = residuals(intr, points, extr);
  if (!r) return null;
  let cost = sumSquares(r);
  let lambda = LAMBDA_START;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    const J = jacobian(intr, points, extr);
    if (!J) break;
    const A = J.map((a) => J.map((b) => a.reduce((s, x, i) => s + x * b[i], 0)));
    const g = J.map((a) => a.reduce((s, x, i) => s + x * r[i], 0));
    const floorDiag = 1e-12 * Math.max(...A.map((row, i) => row[i]));
    let improved = false;
    while (lambda <= LAMBDA_MAX) {
      const damped = A.map((row, i) => row.map((x, j) => (i === j ? x + lambda * (x + floorDiag) : x)));
      const delta = solveLinear(damped, g.map((x) => -x));
      const trial = delta && moved(extr, delta);
      const trialR = trial && residuals(intr, points, trial);
      const trialCost = trialR ? sumSquares(trialR) : Infinity;
      if (trialCost < cost) {
        const gain = Math.sqrt(cost / points.length) - Math.sqrt(trialCost / points.length);
        [extr, r, cost] = [trial, trialR, trialCost];
        lambda = Math.max(lambda / 10, LAMBDA_MIN);
        improved = gain >= tolPx;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { extr, ...residualReport(intr, points, extr), iterations };
}

/**
 * The plane→picture homography of four floor corners (plane coordinates `[a, b]`) onto four
 * picture points `[x, y]`, by DLT with h33 = 1: nine numbers, row-major, or null.
 */
function homography(plane, picture) {
  const A = [];
  const b = [];
  plane.forEach(([a, c], i) => {
    const [x, y] = picture[i];
    A.push([a, c, 1, 0, 0, 0, -x * a, -x * c]);
    b.push(x);
    A.push([0, 0, 0, a, c, 1, -y * a, -y * c]);
    b.push(y);
  });
  const h = solveLinear(A, b);
  return h ? [...h, 1] : null;
}

const columnOf = (H, j) => [H[j], H[3 + j], H[6 + j]];

/**
 * The focal length (in the units of the picture coordinates, principal point at their origin,
 * square pixels) that makes the homography's first two columns a rotation's: Zhang's two
 * constraints h1ᵀωh2 = 0 and h1ᵀωh1 = h2ᵀωh2 with ω = diag(1/f², 1/f², 1), solved for 1/f² by
 * least squares. Null when they give no positive 1/f².
 */
function focalFromHomography(H) {
  const [a1, b1, c1] = columnOf(H, 0);
  const [a2, b2, c2] = columnOf(H, 1);
  const A = [a1 * a2 + b1 * b2, a1 * a1 + b1 * b1 - a2 * a2 - b2 * b2];
  const B = [c1 * c2, c1 * c1 - c2 * c2];
  const w = -(A[0] * B[0] + A[1] * B[1]) / (A[0] * A[0] + A[1] * A[1]);
  return Number.isFinite(w) && w > 0 ? 1 / Math.sqrt(w) : null;
}

/** The vertical field of view (degrees) of the floor clicked as `picture`, or null. */
function fovOfQuad(plane, picture) {
  const H = homography(plane, picture);
  const f = H && focalFromHomography(H);
  return f ? (2 * Math.atan(0.5 / f)) / RAD : null;
}

/**
 * The pose from four floor corners with the lens in hand: the homography decomposed into a
 * rotation and a translation, then `refinePose` to finish. The floor is the plane at the corners'
 * mean height. Null when it cannot be solved.
 */
function poseOnQuad(pixels4, siteCorners4, lens, height) {
  const mean = ['x', 'y', 'z'].map((k) => siteCorners4.reduce((s, c) => s + c[k], 0) / 4);
  const plane = siteCorners4.map((c) => [c.x - mean[0], c.z - mean[2]]);
  const H = homography(plane, pixels4.map(({ u, v }) => [(u - lens.cx) / height, (v - lens.cy) / height]));
  if (!H) return null;
  // K⁻¹H in the same picture-height units: the lens divides x and y by f.
  const fx = lens.fx / height;
  const fy = lens.fy / height;
  const g = [0, 1, 2].map((j) => {
    const [x, y, z] = columnOf(H, j);
    return [x / fx, y / fy, z];
  });
  // The plane's a and b are world x and z, so g1 and g2 are R's first and third columns (up to
  // scale). h33 = 1 and the scale is positive, so the floor's centre is in front of the camera.
  const s = 2 / (Math.hypot(...g[0]) + Math.hypot(...g[1]));
  const c1 = normalise(g[0]);
  const c3 = normalise(g[1].map((x, i) => x - dot(g[1], c1) * c1[i]));
  const c2 = cross(c3, c1);
  const R = [0, 1, 2].flatMap((i) => [c1[i], c2[i], c3[i]]);
  const centre = scale(g[2], s); // R·mean + t
  const Rmean = [0, 1, 2].map((i) => R[i * 3] * mean[0] + R[i * 3 + 1] * mean[1] + R[i * 3 + 2] * mean[2]);
  const start = { R, t: centre.map((c, i) => c - Rmean[i]) };

  const points = siteCorners4.map((world, i) => ({ id: `corner${i + 1}`, world, pixel: pixels4[i] }));
  const refined = refinePose(lens, points, start);
  if (!refined) return null;
  const { R: r, t } = refined.extr;
  // The camera centre −Rᵀt: a floor clicked the other way round is only met from below
  const cameraY = -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]);
  return { extr: refined.extr, residualPx: refined.residualPx, residualM: refined.residualM, above: cameraY > mean[1] };
}

/** The corners reflected across the line through corners 1 and 2, in the floor plane: 1→2 stays, 3 and 4 go to its other side. */
function mirroredCorners(siteCorners4) {
  const [a, b] = siteCorners4;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  return siteCorners4.map((c) => {
    const along = (c.x - a.x) * ux + (c.z - a.z) * uz;
    const fx = a.x + along * ux;
    const fz = a.z + along * uz;
    return { x: 2 * fx - c.x + 0, y: c.y, z: 2 * fz - c.z + 0 };
  });
}

/**
 * Where the camera is from four floor corners clicked on the picture (`pixels4`, in the order
 * of `siteCorners4`) and where those corners are (`siteCorners4`, world points; the floor is
 * taken as the plane at their mean height): `{ intr, extr, residualPx, residualM, mirrored, siteCorners }`,
 * or null. The entry to the solve: a homography from the floor to the picture (DLT), the lens from it
 * when `intr` is not given (principal point at the picture's centre, square pixels), the pose
 * from the lens and the homography, then `refinePose` to finish. A floor seen with too little
 * perspective (nearly head-on, or nearly a parallelogram) does not fix the lens: when the field
 * of view comes out of 15°–120°, or a one-pixel slip of any click would move it by more than a
 * few degrees, it is null (the screen asks for a camera that looks down at the floor more).
 *
 * **The camera has to be above the floor.** Corners clicked going round the other way fit just
 * as exactly, from under the floor. For a floor that is only being made (`allowMirror`, a new
 * place) the corners are then mirrored across the line 1→2 and solved again: `mirrored: true`,
 * and `siteCorners` are the corners the camera now stands on. For a floor that is known (a
 * recording's) the order is wrong: `{ extr: null, reason: 'mirrored' }`.
 */
export function poseFromFloorQuad(pixels4, siteCorners4, { width, height, intr = null, allowMirror = false } = {}) {
  if (pixels4?.length !== 4 || siteCorners4?.length !== 4) return null;
  const mean = ['x', 'y', 'z'].map((k) => siteCorners4.reduce((s, c) => s + c[k], 0) / 4);
  const plane = siteCorners4.map((c) => [c.x - mean[0], c.z - mean[2]]);
  // Picture coordinates about the centre and in picture heights, so the DLT is well conditioned.
  const toPicture = ({ u, v }) => [(u - width / 2) / height, (v - height / 2) / height];
  const picture = pixels4.map(toPicture);

  let lens = intr;
  if (!lens) {
    // A mirror image of the floor gives the same field of view: the lens is guessed once
    const fov = fovOfQuad(plane, picture);
    if (!(fov >= FOV_RANGE_DEG[0] && fov <= FOV_RANGE_DEG[1])) return null;
    for (let i = 0; i < 4; i++) {
      for (const [du, dv] of [[CLICK_PX, 0], [0, CLICK_PX]]) {
        const slipped = pixels4.map((p, k) => (k === i ? { u: p.u + du, v: p.v + dv } : p));
        const other = fovOfQuad(plane, slipped.map(toPicture));
        if (!(other != null && Math.abs(other - fov) <= FOV_SPREAD_DEG)) return null;
      }
    }
    lens = intrinsicsFromFov(fov, width, height);
  }

  const solved = poseOnQuad(pixels4, siteCorners4, lens, height);
  if (!solved) return null;
  const answer = (s, corners, mirrored) => ({
    intr: lens, extr: s.extr, residualPx: s.residualPx, residualM: s.residualM, mirrored, siteCorners: corners,
  });
  if (solved.above) return answer(solved, siteCorners4, false);
  if (!allowMirror) return { intr: lens, extr: null, residualPx: null, residualM: null, mirrored: false, reason: 'mirrored' };
  const corners = mirroredCorners(siteCorners4);
  const again = poseOnQuad(pixels4, corners, lens, height);
  return again?.above ? answer(again, corners, true) : null;
}

/** The vertical field of view (degrees) of a focal length in picture heights, and the slip check's range. */
const fovOfFocal = (f) => (2 * Math.atan(0.5 / f)) / RAD;
const fovAllowed = (fov) => fov >= FOV_RANGE_DEG[0] && fov <= FOV_RANGE_DEG[1];

/**
 * The lens and the depth of a new floor from its four clicked corners and the length of 1→2,
 * so that **the four clicks are never moved** (2026-11-01: a frame that slid off the clicks
 * and a robot that stood tilted). Four clicks are eight numbers; the lens, the pose and the
 * rectangle's depth are eight unknowns, so they fit exactly — the typed depth was the one number
 * too many, and the solve spent it on moving the clicks.
 *
 * The plane→picture homography of a unit square gives K⁻¹H whose first two columns are a
 * rotation's up to the square's two scales: orthogonal whatever the shape (`h1ᵀωh2 = 0` fixes
 * the lens when none is given), and in the ratio of the two edges (the depth). A floor seen
 * straight on (one vanishing point) leaves the lens and the depth trading off: then the typed
 * `edge23M` fixes the depth and the lens follows from the norms, still through the clicks.
 *
 * @returns {{ intr: object, edge23M: number, derived: boolean } | { reason: 'depth-needed' } | null}
 *   `derived`: the depth came from the picture. `depth-needed`: ask for `edge23M` and call again.
 *   Null: the corners do not fix a lens (too little perspective, a field of view outside
 *   15°–120°, or one that a one-pixel slip of a click moves by more than a few degrees).
 */
export function floorFromClicks(pixels4, edge12M, { width, height, intr = null, edge23M = null } = {}) {
  if (pixels4?.length !== 4 || !(Number.isFinite(edge12M) && edge12M > 0)) return null;
  const plane = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  // With a lens, normalised camera coordinates (ω = I); without, about the centre in picture heights (ω = diag(w, w, 1))
  const toPicture = intr
    ? ({ u, v }) => [(u - intr.cx) / intr.fx, (v - intr.cy) / intr.fy]
    : ({ u, v }) => [(u - width / 2) / height, (v - height / 2) / height];
  const columns = (pixels) => {
    const H = homography(plane, pixels.map(toPicture));
    return H && [columnOf(H, 0), columnOf(H, 1)];
  };
  const depthOf = ([[a1, b1, c1], [a2, b2, c2]], w) => Math.hypot(a2 * Math.sqrt(w), b2 * Math.sqrt(w), c2) / Math.hypot(a1 * Math.sqrt(w), b1 * Math.sqrt(w), c1);
  const cols = columns(pixels4);
  if (!cols) return null;

  if (intr) {
    const ratio = depthOf(cols, 1);
    return Number.isFinite(ratio) && ratio > 0 ? { intr, edge23M: edge12M * ratio, derived: true } : null;
  }

  // The lens from a way of fixing 1/f², and the depth: the picture's, or the typed one as given
  const answer = (wOf, derived) => {
    const w = wOf(cols);
    const ratio = depthOf(cols, w);
    const lens = intrinsicsFromFov(fovOfFocal(1 / Math.sqrt(w)), width, height);
    return Number.isFinite(ratio) && ratio > 0 ? { intr: lens, edge23M: derived ? edge12M * ratio : edge23M, derived } : null;
  };

  // From the picture alone: the two columns are orthogonal
  const byOrthogonality = ([[a1, b1, c1], [a2, b2, c2]]) => -(c1 * c2) / (a1 * a2 + b1 * b2);
  if (steadyWith(byOrthogonality)) return answer(byOrthogonality, true);

  // The picture cannot tell: the typed depth sets the columns' lengths in ratio
  if (!(Number.isFinite(edge23M) && edge23M > 0)) return { reason: 'depth-needed' };
  const k2 = (edge23M / edge12M) ** 2;
  const byDepth = ([[a1, b1, c1], [a2, b2, c2]]) => (c2 * c2 / k2 - c1 * c1) / ((a1 * a1 + b1 * b1) - (a2 * a2 + b2 * b2) / k2);
  return steadyWith(byDepth) ? answer(byDepth, false) : null;

  // A way of fixing 1/f², checked the way poseFromFloorQuad checks: in range, and steady under a slipped click
  function steadyWith(wOf) {
    const w = wOf(cols);
    if (!(Number.isFinite(w) && w > 0)) return false;
    const fov = fovOfFocal(1 / Math.sqrt(w));
    if (!fovAllowed(fov)) return false;
    for (let i = 0; i < 4; i++) {
      for (const [du, dv] of [[CLICK_PX, 0], [0, CLICK_PX]]) {
        const slipped = columns(pixels4.map((p, k) => (k === i ? { u: p.u + du, v: p.v + dv } : p)));
        const other = slipped && wOf(slipped);
        if (!(Number.isFinite(other) && other > 0 && Math.abs(fovOfFocal(1 / Math.sqrt(other)) - fov) <= FOV_SPREAD_DEG)) return false;
      }
    }
    return true;
  }
}

/**
 * Site corners for a new place (a recording with no floor yet): the four clicked floor points
 * taken as the corners of a rectangle, corner 1 at the site origin, corner 1→2 `edge12M` long
 * along +x and corner 2→3 `edge23M` long along +z (y = 0, the site's y up), in the shape
 * floor-frame.js `floorFromWorld` takes. `edge23M` is what `floorFromClicks` found (or the
 * person typed when the picture could not tell). Clicked the other way round, poseFromFloorQuad's
 * `allowMirror` puts corners 3 and 4 on −z instead. `pixels4` only fixes the order of the corners.
 */
export function floorScaleFromEdge(pixels4, edge12M, edge23M) {
  return [
    { x: 0, y: 0, z: 0 },
    { x: edge12M, y: 0, z: 0 },
    { x: edge12M, y: 0, z: edge23M },
    { x: 0, y: 0, z: edge23M },
  ];
}
