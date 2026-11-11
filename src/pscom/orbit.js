// Copied from app/src/orbit.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * An orbit camera's numbers: where it looks (`target`), which way round and how high (`azimuth`,
 * `elevation` in radians) and how far off (`distance` in metres). **Touches neither three nor the
 * DOM**: the stage's empty background (video-view.js) drives its camera from it. The catalog's
 * machine viewer (lp/assets/catalog/viewer.js) keeps the same numbers of its own, so a drag and a
 * wheel feel the same on both.
 */

/** How far the eye may sit from the target [m]: close enough for a tabletop arm, far enough for a yard. */
export const DISTANCE_LIMITS = Object.freeze({ min: 0.2, max: 60 });

/** How high the eye may look from: a little below the floor's edge, up to nearly straight down. */
export const ELEVATION_LIMITS = Object.freeze({ min: -0.1, max: 1.45 });

/** Radians of turn per pixel dragged sideways, and of lift per pixel dragged up or down. */
export const DRAG_TURN = 0.008;
export const DRAG_LIFT = 0.006;

/** How much one wheel notch of deltaY zooms: distance × exp(deltaY × this). */
export const WHEEL_ZOOM = 0.001;

const clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));

/** An orbit as the stage starts: looking at a point a little above the floor's origin, from the front and above. */
export function defaultOrbit() {
  return { target: { x: 0, y: 0.6, z: 0 }, azimuth: 0.6, elevation: 0.5, distance: 6 };
}

/** The eye's place for an orbit: on the sphere round the target. */
export function orbitEye({ target, azimuth, elevation, distance }) {
  const flat = Math.cos(elevation) * distance;
  return {
    x: target.x + Math.sin(azimuth) * flat,
    y: target.y + Math.sin(elevation) * distance,
    z: target.z + Math.cos(azimuth) * flat,
  };
}

/** The orbit after a drag of `dx`, `dy` pixels: dragging right turns the scene right, dragging up looks from higher. */
export function dragOrbit(orbit, dx, dy) {
  return {
    ...orbit,
    azimuth: orbit.azimuth - dx * DRAG_TURN,
    elevation: clamp(orbit.elevation + dy * DRAG_LIFT, ELEVATION_LIMITS),
  };
}

/** The orbit zoomed by a factor on its distance (> 1 moves away), within the limits. */
export function zoomOrbit(orbit, factor) {
  if (!(factor > 0)) return orbit;
  return { ...orbit, distance: clamp(orbit.distance * factor, DISTANCE_LIMITS) };
}

/** The factor one wheel event zooms by: away from you (deltaY < 0) comes closer. */
export const wheelFactor = (deltaY) => Math.exp(deltaY * WHEEL_ZOOM);
