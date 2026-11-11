// Copied from app/src/camera-model.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * A camera as a pinhole with lens distortion, so a picture can be lined up by solved numbers
 * and a calibrated camera can be taken as it is.
 *
 * The few numbers a person sets by eye (floor-pose.js: lens, look-down, tilt, height) are one
 * special case of it, and `extrinsicsFromPose` turns them into this model. Intrinsics are
 * `{ fx, fy, cx, cy, width, height, dist }` in pixels, with `dist = [k1, k2, p1, p2, k3]`
 * (Brown–Conrady, the same as OpenCV and ROS "plumb_bob"). Extrinsics are `{ R, t }`:
 * **R (row-major, 9 numbers) and t take a world point to the camera's side**, `p_cam = R·p + t`,
 * the inverse of three's `camera.matrixWorld`. The camera's side is the computer-vision one:
 * x right, y down, z forward, so `depth` is z and a pixel is `cx + fx·x/z`, `cy + fy·y/z`.
 *
 * The world here is three's world (y up, the camera above the origin looking along −z when
 * level). A recording's site frame (roundtrip.js `frame`) is applied by the callers, through
 * `fromSite`, before a point is projected; `extrinsicsFromPose` takes `frame` only so the
 * signature stays the same when the frame is folded in.
 *
 * **Touches neither the DOM nor three.** Plain objects and numbers; angles in degrees where a person sets them.
 */

const RAD = Math.PI / 180;
const UNDISTORT_STEPS = 5;
const KNOWN_MODELS = ['plumb_bob', 'rational_polynomial'];

/** Intrinsics of a lens with a vertical field of view `fovDeg` over a `width` × `height` picture. */
export function intrinsicsFromFov(fovDeg, width, height) {
  const f = height / 2 / Math.tan((fovDeg * RAD) / 2);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height, dist: [0, 0, 0, 0, 0] };
}

const mul3 = (a, b) => {
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return out;
};
const apply = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const applyTransposed = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

/**
 * The world→camera transform of a legacy `pose`, with the camera where video-view.js puts the
 * page camera: `heightM` above the origin, looking along −z, pitched down, then rolled about
 * its view (three: `rotation.set(-pitch, 0, roll, 'YXZ')`). `frame` is not used here (see the
 * header): the world stays three's world.
 */
export function extrinsicsFromPose(pose, frame) {
  const pitch = pose.pitchDeg * RAD;
  const roll = (pose.rollDeg ?? 0) * RAD;
  const [cp, sp, cr, sr] = [Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const rollBack = [cr, sr, 0, -sr, cr, 0, 0, 0, 1]; // Rz(−roll)
  const pitchBack = [1, 0, 0, 0, cp, -sp, 0, sp, cp]; // Rx(+pitch)
  const flip = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // three's camera (y up, looks −z) to y down, z forward
  const R = mul3(flip, mul3(rollBack, pitchBack));
  return { R, t: apply(R, [0, -pose.heightM, 0]) };
}

/**
 * The frustum a three.js PerspectiveCamera needs to draw as this lens does, principal point and
 * fx ≠ fy included: `{ fovDeg, aspect, view }` for `fov`, `aspect` and `setViewOffset(...view)`.
 * The picture is a window into a larger frame centred on the principal point (cx, cy); `fovDeg`
 * is that frame's vertical field of view, `aspect` its width over height stretched by fy/fx.
 * Distortion is not drawn (a pinhole only). Plain numbers: three is the caller's. **three's
 * setViewOffset sets the aspect to fullWidth / fullHeight**, so `aspect` is set after it.
 */
export function frustumOf(intr) {
  const fullWidth = 2 * Math.max(intr.cx, intr.width - intr.cx);
  const fullHeight = 2 * Math.max(intr.cy, intr.height - intr.cy);
  return {
    fovDeg: (2 * Math.atan(fullHeight / 2 / intr.fy)) / RAD,
    aspect: (fullWidth / fullHeight) * (intr.fy / intr.fx),
    view: {
      fullWidth, fullHeight, offsetX: fullWidth / 2 - intr.cx, offsetY: fullHeight / 2 - intr.cy, width: intr.width, height: intr.height,
    },
  };
}

/** `{ u, v, depth }` in pixels and metres for a world point, or null when it is not in front of the camera. */
export function projectPoint(intr, extr, worldPoint) {
  const [x, y, z] = apply(extr.R, [worldPoint.x, worldPoint.y, worldPoint.z]).map((c, i) => c + extr.t[i]);
  if (!(z > 0)) return null;
  const [k1, k2, p1, p2, k3] = intr.dist;
  const a = x / z;
  const b = y / z;
  const r2 = a * a + b * b;
  const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  const xd = a * radial + 2 * p1 * a * b + p2 * (r2 + 2 * a * a);
  const yd = b * radial + p1 * (r2 + 2 * b * b) + 2 * p2 * a * b;
  return { u: intr.cx + intr.fx * xd, v: intr.cy + intr.fy * yd, depth: z };
}

/** The ray from the camera through pixel `(u, v)`, distortion undone: `dir` is a unit vector in the world. */
export function rayThroughPixel(intr, extr, u, v) {
  const [k1, k2, p1, p2, k3] = intr.dist;
  const xd = (u - intr.cx) / intr.fx;
  const yd = (v - intr.cy) / intr.fy;
  let a = xd;
  let b = yd;
  for (let i = 0; i < UNDISTORT_STEPS; i++) {
    const r2 = a * a + b * b;
    const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    a = (xd - (2 * p1 * a * b + p2 * (r2 + 2 * a * a))) / radial;
    b = (yd - (p1 * (r2 + 2 * b * b) + 2 * p2 * a * b)) / radial;
  }
  const dir = applyTransposed(extr.R, [a, b, 1]);
  const length = Math.hypot(...dir);
  const origin = applyTransposed(extr.R, extr.t).map((c) => -c);
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    dir: { x: dir[0] / length, y: dir[1] / length, z: dir[2] / length },
  };
}

/** Where `ray` meets the plane `y = floorY`, or null when it runs level or away from it. */
export function floorHit(ray, floorY = 0) {
  const s = (floorY - ray.origin.y) / ray.dir.y;
  if (!Number.isFinite(s) || s <= 0) return null;
  return { x: ray.origin.x + ray.dir.x * s, y: floorY, z: ray.origin.z + ray.dir.z * s };
}

const isNumbers = (list, count) => Array.isArray(list) && list.length === count && list.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * A ROS CameraInfo-like object `{ width, height, K, D, distortion_model?, extrinsics? }`:
 * `{ intr, extr, problems }`. Anything that cannot be taken gives `intr: null` and the reasons.
 * An 8-number D (rational_polynomial) is taken by its first five, the ones this model has.
 * Extrinsics that are not `{ R: 9, t: 3 }` are left out with a reason, the intrinsics still taken.
 */
export function parseCameraInfo(json) {
  const problems = [];
  const info = json ?? {};
  if (!(Number.isFinite(info.width) && info.width > 0)) problems.push('width is missing');
  if (!(Number.isFinite(info.height) && info.height > 0)) problems.push('height is missing');
  if (!isNumbers(info.K, 9)) problems.push('K must be nine numbers');
  if (!(isNumbers(info.D, 5) || isNumbers(info.D, 8))) problems.push('D must be five or eight numbers');
  const model = info.distortion_model ?? 'plumb_bob';
  if (!KNOWN_MODELS.includes(model)) problems.push(`distortion_model "${model}" is not one of ${KNOWN_MODELS.join(', ')}`);
  if (problems.length) return { intr: null, extr: null, problems };

  const intr = {
    fx: info.K[0], fy: info.K[4], cx: info.K[2], cy: info.K[5],
    width: info.width, height: info.height, dist: info.D.slice(0, 5),
  };
  let extr = null;
  if (info.extrinsics != null) {
    if (isNumbers(info.extrinsics.R, 9) && isNumbers(info.extrinsics.t, 3)) {
      extr = { R: [...info.extrinsics.R], t: [...info.extrinsics.t] };
    } else {
      problems.push('extrinsics must be R (nine numbers) and t (three numbers)');
    }
  }
  return { intr, extr, problems };
}

/**
 * Whether a calibration fits the picture: its pixels are the picture's, or it was made for another
 * resolution (another mode of the camera, or another camera) and is refused with the two sizes.
 */
export function sizeProblem(intr, { width, height }) {
  if (intr.width === width && intr.height === height) return null;
  return { key: 'camera.infoSize', params: { w: intr.width, h: intr.height, mw: width, mh: height } };
}
