import test from 'node:test';
import assert from 'node:assert/strict';
import { DISTANCE_LIMITS, ELEVATION_LIMITS, defaultOrbit, dragOrbit, orbitEye, wheelFactor, zoomOrbit } from '../../src/pscom/orbit.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('the eye sits on the sphere round the target, at the orbit\'s distance', () => {
  const orbit = { target: { x: 1, y: 2, z: 3 }, azimuth: 0.4, elevation: 0.3, distance: 5 };
  const eye = orbitEye(orbit);
  const off = Math.hypot(eye.x - 1, eye.y - 2, eye.z - 3);
  assert.ok(close(off, 5), String(off));
  // Straight ahead (azimuth 0) and level (elevation 0): along +z of the target
  assert.deepEqual(orbitEye({ target: { x: 0, y: 0, z: 0 }, azimuth: 0, elevation: 0, distance: 2 }), { x: 0, y: 0, z: 2 });
});

test('dragging turns and lifts within the limits, and leaves the orbit given alone', () => {
  const start = defaultOrbit();
  const turned = dragOrbit(start, 100, 0);
  assert.ok(turned.azimuth < start.azimuth);
  assert.equal(turned.elevation, start.elevation);
  assert.equal(start.azimuth, defaultOrbit().azimuth, 'not changed in place');
  const lifted = dragOrbit(start, 0, 10000);
  assert.equal(lifted.elevation, ELEVATION_LIMITS.max);
  const lowered = dragOrbit(start, 0, -10000);
  assert.equal(lowered.elevation, ELEVATION_LIMITS.min);
});

test('zooming scales the distance within the limits; a factor that is not positive changes nothing', () => {
  const start = defaultOrbit();
  assert.ok(close(zoomOrbit(start, 2).distance, start.distance * 2));
  assert.equal(zoomOrbit(start, 1e9).distance, DISTANCE_LIMITS.max);
  assert.equal(zoomOrbit(start, 1e-9).distance, DISTANCE_LIMITS.min);
  assert.equal(zoomOrbit(start, 0), start);
  assert.equal(zoomOrbit(start, NaN), start);
  // The wheel away from you (deltaY < 0) comes closer
  assert.ok(wheelFactor(-100) < 1 && wheelFactor(100) > 1);
});
