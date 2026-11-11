// Copied from app/src/floor-frame.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
// The arithmetic of a "floor frame": four floor corners that stand in for the two markers.
// Pure maths on {x,y,z} points (y up, metres). No three.js, no DOM.
import { siteFrame, toSite, fromSite } from './roundtrip.js';

export const FLOOR_SOURCES = ['planes', 'corners', 'usd'];
export const MAX_NOTE = 40;
export const MIN_EDGE_M = 0.5;
export const OFF_PLANE_M = 0.15;

// Same millimetre rounding as record.js; "+ 0" turns -0 into 0.
const mm = (v) => Math.round(v * 1000) / 1000 + 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = side(a, b, c);
  const d2 = side(a, b, d);
  const d3 = side(c, d, a);
  const d4 = side(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// Plane y = a*x + b*z + c through three points (exact: the least-squares fit of three points).
// Returns null when the three are collinear seen from above.
function planeThrough(p, q, r) {
  const ux = q.x - p.x;
  const uz = q.z - p.z;
  const vx = r.x - p.x;
  const vz = r.z - p.z;
  const det = ux * vz - uz * vx;
  if (Math.abs(det) < 1e-9) return null;
  const du = q.y - p.y;
  const dv = r.y - p.y;
  const a = (du * vz - dv * uz) / det;
  const b = (ux * dv - vx * du) / det;
  return { a, b, c: p.y - a * p.x - b * p.z };
}

/** Checks on four world points. Edges and crossing are horizontal (x/z); edge i runs corner i → i+1. */
export function floorProblems(points4) {
  const shortEdges = [];
  for (let i = 0; i < 4; i++) {
    const a = points4[i];
    const b = points4[(i + 1) % 4];
    if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_EDGE_M) shortEdges.push(i);
  }
  const crossing = segmentsCross(points4[0], points4[1], points4[2], points4[3])
    || segmentsCross(points4[1], points4[2], points4[3], points4[0]);

  // Non-planarity: how far a corner sits from the plane through the other three. If it is too
  // much, mark the single corner whose exclusion leaves the most level plane (ties: lowest index).
  let worst = 0;
  let marked = -1;
  let flattest = Infinity;
  for (let i = 0; i < 4; i++) {
    const [p, q, r] = [0, 1, 2, 3].filter((k) => k !== i).map((k) => points4[k]);
    const plane = planeThrough(p, q, r);
    if (!plane) continue;
    const here = points4[i];
    worst = Math.max(worst, Math.abs(here.y - (plane.a * here.x + plane.b * here.z + plane.c)));
    const tilt = Math.hypot(plane.a, plane.b);
    if (tilt < flattest - 1e-9) { flattest = tilt; marked = i; }
  }
  const offPlane = worst > OFF_PLANE_M && marked >= 0 ? [marked] : [];

  return { shortEdges, crossing, offPlane, decidable: shortEdges.length === 0 && !crossing };
}

/** Site frame from corner 1 → corner 2, and the four corners in it (millimetres). */
export function floorFromWorld(points4, { source, notes = [] } = {}) {
  const frame = siteFrame(points4[0], points4[1]);
  const corners = points4.map((point, i) => {
    const s = toSite(point, frame);
    const corner = { x: mm(s.x), y: mm(s.y), z: mm(s.z) };
    const note = typeof notes[i] === 'string' ? notes[i].trim().slice(0, MAX_NOTE).trim() : '';
    if (note) corner.note = note;
    return corner;
  });
  return { frame, floor: { source, corners } };
}

/**
 * The two markers a site frame stands for, in world points: the site origin and (spanM, 0, 0),
 * where siteFrame puts marker 2. Taken from the frame itself, not from floor corners, so a floor
 * whose corner 1 is not the site origin (a .usda's, say) still gives the same site.
 */
export function markersOfFrame(frame) {
  return [fromSite({ x: 0, y: 0, z: 0 }, frame), fromSite({ x: frame.spanM, y: 0, z: 0 }, frame)];
}

export function worldCornersOf(floor, frame) {
  return floor.corners.map((corner) => fromSite(corner, frame));
}

/** Rebuilds a floor from allowed keys only. `problem` is a short reason when raw is malformed. */
export function parseFloor(raw) {
  if (raw === undefined || raw === null) return { floor: null, problem: null };
  if (typeof raw !== 'object' || !FLOOR_SOURCES.includes(raw.source)) return { floor: null, problem: 'source' };
  if (!Array.isArray(raw.corners) || raw.corners.length !== 4) return { floor: null, problem: 'corners' };

  const corners = [];
  for (const c of raw.corners) {
    if (!c || typeof c !== 'object' || !isNum(c.x) || !isNum(c.y) || !isNum(c.z)) return { floor: null, problem: 'number' };
    const corner = { x: c.x, y: c.y, z: c.z };
    if (c.note !== undefined && c.note !== null) {
      if (typeof c.note !== 'string' || c.note.length > MAX_NOTE) return { floor: null, problem: 'note' };
      if (c.note.trim() !== '') corner.note = c.note.trim();
    }
    corners.push(corner);
  }
  return { floor: { source: raw.source, corners }, problem: null };
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const build = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(pts), ...build([...pts].reverse())];
}

/** Minimum-area rectangle around a horizontal polygon (x/z), or null when it is degenerate. Corners counter-clockwise seen from above. */
export function rectangleAround(polygon) {
  if (!polygon || polygon.length < 3) return null;
  const y = polygon.reduce((s, p) => s + p.y, 0) / polygon.length;
  const hull = convexHull(polygon);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-12) continue;
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    let u0 = Infinity; let u1 = -Infinity; let v0 = Infinity; let v1 = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.z * uz;
      const v = -p.x * uz + p.z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ux, uz, u0, u1, v0, v1 } = best;
  let corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => ({
    x: u * ux - v * uz, y, z: u * uz + v * ux,
  }));
  // Seen from above (x right, z toward the viewer) counter-clockwise is a negative signed area in x/z.
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % 4];
    area2 += p.x * q.z - q.x * p.z;
  }
  if (area2 > 0) corners = [corners[0], corners[3], corners[2], corners[1]];

  let first = 0;
  for (let i = 1; i < 4; i++) {
    const s = corners[i].x + corners[i].z;
    const f = corners[first].x + corners[first].z;
    if (s < f - 1e-9 || (Math.abs(s - f) <= 1e-9 && corners[i].x < corners[first].x)) first = i;
  }
  return [0, 1, 2, 3].map((i) => corners[(first + i) % 4]);
}

/** The polygon labelled 'floor', else the lowest horizontal one, else null. */
export function pickFloorPolygon(planes) {
  const named = planes.find((plane) => plane.label === 'floor' && plane.points?.length);
  if (named) return named.points;
  let best = null;
  let bestY = Infinity;
  for (const plane of planes) {
    if (!plane.horizontal || !plane.points?.length) continue;
    const y = plane.points.reduce((s, p) => s + p.y, 0) / plane.points.length;
    if (y < bestY) { bestY = y; best = plane.points; }
  }
  return best;
}

/**
 * The placement that lays the recorded corners onto the detected rectangle best. Tries the four
 * cyclic correspondences in both windings and keeps the least sum of squared horizontal distances.
 */
export function fitFloorFrame(floor, rect4) {
  let best = null;
  for (const wind of [false, true]) {
    const base = wind ? [rect4[0], rect4[3], rect4[2], rect4[1]] : rect4;
    for (let shift = 0; shift < 4; shift++) {
      const target = [0, 1, 2, 3].map((i) => base[(i + shift) % 4]);
      const fit = fitInOrder(floor.corners, target);
      if (!best || fit.cost < best.cost) best = fit;
    }
  }
  // The rectangle's own height, not the recorded corners' (a detected plane is flat)
  const mean = rect4.reduce((sum, p) => sum + p.y, 0) / rect4.length;
  return { origin: { ...best.origin, y: mean }, yaw: best.yaw };
}

/** Within this share of real size the four taps keep the frame at real size (a miniature is not made of a slip). */
export const REAL_SIZE_SLACK = 0.05;

/**
 * The placement that lays recorded corner i on world point i (the person tapped the real room's
 * corners 1 to 4 in turn): the turn, **scale** and shift that bring them closest, in least
 * squares, so a few centimetres off at each tap even out. The order is kept as tapped, never
 * searched. **Four taps closer together than the recorded corners make a miniature** (and
 * farther apart, an enlargement): the frame is the size the taps make it, and everything on it
 * is drawn at that scale. Within REAL_SIZE_SLACK of real size it stays real size (no `scale`).
 *
 * @param {{ corners: Array<{x:number,y:number,z:number}> }} floor in site form
 * @param {Array<{x:number,y:number,z:number}>} points four world points, corner 1 first
 * @returns {{ origin: {x:number,y:number,z:number}, yaw: number, scale: number } | null}
 *   null unless four finite points and a recorded frame with some size
 */
export function fitFloorFrameInOrder(floor, points) {
  const finite = (p) => p && [p.x, p.y, p.z].every(Number.isFinite);
  if (!Array.isArray(points) || points.length !== 4 || !points.every(finite)) return null;
  if (!Array.isArray(floor?.corners) || floor.corners.length !== 4) return null;
  const free = fitInOrder(floor.corners, points, { scaled: true });
  if (!free) return null;
  const fit = Math.abs(free.scale - 1) <= REAL_SIZE_SLACK ? fitInOrder(floor.corners, points) : free;
  return { origin: fit.origin, yaw: fit.yaw, scale: fit.scale };
}

/** How far on the floor [m] a tapped corner may lie from the frame lined up on it before it is marked. */
export const TAP_OFF_SIDE_M = 0.3;

/**
 * The corners (indices) whose tap the frame lined up on them does not meet: more than OFF_PLANE_M
 * above or below it (a tap that met a wall near the corner), or more than TAP_OFF_SIDE_M from it
 * on the floor (a corner tapped out of order, or a room shaped differently).
 *
 * @param {Array<{x:number,y:number,z:number}>} worldCorners the frame's corners in world points
 * @param {Array<{x:number,y:number,z:number}>} taps the points tapped, corner 1 first
 * @returns {number[]}
 */
export function tapsOffFrame(worldCorners, taps) {
  const off = [];
  (taps || []).forEach((tap, i) => {
    const corner = worldCorners[i];
    if (!corner || !tap) return;
    const high = Math.abs(tap.y - corner.y) > OFF_PLANE_M;
    const side = Math.hypot(tap.x - corner.x, tap.z - corner.z) > TAP_OFF_SIDE_M;
    if (high || side) off.push(i);
  });
  return off;
}

/**
 * Least-squares turn and shift (and, `scaled`, uniform scale) of `corners` onto `target`, pair by
 * pair, in plan; origin.y puts the corners' mean height on the targets'. Null when the corners
 * have no size to scale.
 */
function fitInOrder(corners, target, { scaled = false } = {}) {
  const mean = (list, k) => list.reduce((s, p) => s + (p[k] ?? 0), 0) / list.length;
  const cx = mean(corners, 'x');
  const cz = mean(corners, 'z');
  const tx = mean(target, 'x');
  const tz = mean(target, 'z');
  let dot = 0; let crs = 0; let spread = 0;
  for (let i = 0; i < 4; i++) {
    const ax = corners[i].x - cx;
    const az = corners[i].z - cz;
    const bx = target[i].x - tx;
    const bz = target[i].z - tz;
    dot += ax * bx + az * bz;
    crs += ax * bz - az * bx;
    spread += ax * ax + az * az;
  }
  if (scaled && !(spread > 1e-12)) return null;
  const yaw = Math.atan2(crs, dot);
  const k = scaled ? Math.hypot(dot, crs) / spread : 1;
  // fromSite: x' = ox + k (x cos - z sin), z' = oz + k (x sin + z cos)
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ox = tx - k * (cx * c - cz * s);
  const oz = tz - k * (cx * s + cz * c);
  let cost = 0;
  for (let i = 0; i < 4; i++) {
    const { x, z } = corners[i];
    cost += (ox + k * (x * c - z * s) - target[i].x) ** 2 + (oz + k * (x * s + z * c) - target[i].z) ** 2;
  }
  return { cost, yaw, scale: k, origin: { x: ox, y: mean(target, 'y') - k * mean(corners, 'y'), z: oz } };
}

/** A full frame for a candidate placement; spanM is the length of corner 1 → 2. */
export function frameFrom({ origin, yaw, scale }, floor) {
  const a = floor.corners[0];
  const b = floor.corners[1];
  // spanM is the site's (corner 1 → 2 as recorded); a miniature's scale goes with it (roundtrip.js's scaleOf)
  const frame = { origin: { ...origin }, yaw, spanM: Math.hypot(b.x - a.x, b.z - a.z) };
  if (Number.isFinite(scale) && scale > 0 && scale !== 1) frame.scale = scale;
  return frame;
}
