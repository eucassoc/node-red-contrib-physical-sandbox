import test from 'node:test';
import assert from 'node:assert/strict';
import { toSite, fromSite } from '../../src/pscom/roundtrip.js';
import {
  FLOOR_SOURCES, MAX_NOTE, MIN_EDGE_M, OFF_PLANE_M,
  floorProblems, floorFromWorld, worldCornersOf, parseFloor,
  rectangleAround, pickFloorPolygon, fitFloorFrame, fitFloorFrameInOrder, tapsOffFrame, TAP_OFF_SIDE_M, frameFrom, markersOfFrame,
} from '../../src/pscom/floor-frame.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const assertPoints = (actual, expected, eps = 1e-3) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((p, i) => {
    for (const k of ['x', 'y', 'z']) assert.ok(near(actual[i][k], p[k], eps), `corner ${i} ${k}: ${actual[i][k]} vs ${p[k]}`);
  });
};

// A 5 x 4 m rectangle rotated by `deg`, placed at (10, -3), with the given heights.
function room(deg, heights = [0, 0.01, 0.03, 0.02], reverse = false) {
  const a = (deg * Math.PI) / 180;
  const local = [[0, 0], [5, 0], [5, 4], [0, 4]];
  const pts = local.map(([x, z], i) => ({
    x: 10 + x * Math.cos(a) - z * Math.sin(a),
    y: heights[i],
    z: -3 + x * Math.sin(a) + z * Math.cos(a),
  }));
  return reverse ? [pts[0], pts[3], pts[2], pts[1]] : pts;
}

test('constants', () => {
  assert.deepEqual(FLOOR_SOURCES, ['planes', 'corners', 'usd']);
  assert.equal(MAX_NOTE, 40);
  assert.equal(MIN_EDGE_M, 0.5);
  assert.equal(OFF_PLANE_M, 0.15);
});

test('a square floor round-trips world → site → world within a millimetre', () => {
  const p = room(30);
  const { frame, floor } = floorFromWorld(p, { source: 'corners' });
  assertPoints(worldCornersOf(floor, frame), p, 1e-3);
  assert.equal(floor.source, 'corners');
  assert.deepEqual(Object.keys(floor).sort(), ['corners', 'source']);
});

test('a sloped floor survives the round trip within a millimetre', () => {
  const p = room(75, [0, 0.4, 1.1, 0.7]);
  const { frame, floor } = floorFromWorld(p, { source: 'planes' });
  assertPoints(worldCornersOf(floor, frame), p, 1e-3);
});

test('corner 1 is the site origin and corner 1→2 is +x', () => {
  const { floor } = floorFromWorld(room(30), { source: 'corners' });
  assert.deepEqual(floor.corners[0], { x: 0, y: 0, z: 0 });
  assert.equal(floor.corners[1].z, 0);
  assert.ok(near(floor.corners[1].x, 5));
});

test('clockwise and counter-clockwise corners keep the room the right way round', () => {
  for (const reverse of [false, true]) {
    const p = room(30, undefined, reverse);
    const { frame, floor } = floorFromWorld(p, { source: 'corners' });
    assertPoints(worldCornersOf(floor, frame), p, 1e-3);
    // site +z follows from +x and +y, never from the winding: corner 1→2 is +x and the
    // room sits on one side that matches the world side of the second edge.
    const s = toSite(p[2], frame);
    assert.ok(near(s.z, floor.corners[2].z));
  }
  // The mirror image must not come out the same.
  const a = floorFromWorld(room(30), { source: 'corners' }).floor.corners[2].z;
  const b = floorFromWorld(room(30, undefined, true), { source: 'corners' }).floor.corners[2].z;
  assert.ok(a * b < 0);
});

test('coordinates are rounded to the millimetre', () => {
  const { floor } = floorFromWorld(room(33), { source: 'corners' });
  for (const c of floor.corners) {
    for (const k of ['x', 'y', 'z']) assert.equal(c[k], Math.round(c[k] * 1000) / 1000);
  }
});

test('an edge under 0.5 m, or crossing edges, cannot be decided', () => {
  const ok = floorProblems(room(0));
  assert.deepEqual(ok, { shortEdges: [], crossing: false, offPlane: [], decidable: true });

  const p = room(0);
  p[2] = { x: p[1].x + 0.3, y: 0, z: p[1].z };
  const short = floorProblems([p[0], p[1], p[2], { x: p[0].x, y: 0, z: p[0].z + 4 }]);
  assert.ok(short.shortEdges.includes(1));
  assert.equal(short.decidable, false);

  // Bow-tie: corners 1 and 2 swapped.
  const q = room(0);
  const bow = floorProblems([q[0], q[2], q[1], q[3]]);
  assert.equal(bow.crossing, true);
  assert.equal(bow.decidable, false);
});

test('a corner 0.2 m off the others\' plane is marked but decidable', () => {
  const p = room(0, [0, 0, 0, 0.2]);
  const r = floorProblems(p);
  assert.deepEqual(r.offPlane, [3]);
  assert.equal(r.decidable, true);
  assert.deepEqual(floorProblems(room(0)).offPlane, []);
});

test('a planar slope is fine; a raised corner on a slope is the one marked', () => {
  const slope = (x) => 0.1 * x;
  const base = room(0).map((p) => ({ ...p, y: slope(p.x - 10) }));
  assert.deepEqual(floorProblems(base).offPlane, []);
  const raised = base.map((p, i) => (i === 2 ? { ...p, y: p.y + 0.3 } : p));
  assert.deepEqual(floorProblems(raised).offPlane, [2]);
});

test('notes are trimmed and cut to 40; empty notes are left out', () => {
  const long = 'x'.repeat(60);
  const { floor } = floorFromWorld(room(0), { source: 'corners', notes: ['  by the door  ', '   ', long] });
  assert.equal(floor.corners[0].note, 'by the door');
  assert.equal('note' in floor.corners[1], false);
  assert.equal(floor.corners[2].note.length, 40);
  assert.equal('note' in floor.corners[3], false);
});

test('parseFloor refuses a wrong source, not four corners, a non-number or a long note; absent is null', () => {
  const good = floorFromWorld(room(20), { source: 'planes', notes: ['a'] }).floor;
  const r = parseFloor(JSON.parse(JSON.stringify({ ...good, extra: 1 })));
  assert.deepEqual(r.floor, good);
  assert.ok(!r.problem);

  assert.equal(parseFloor(undefined).floor, null);
  assert.ok(!parseFloor(undefined).problem);
  assert.equal(parseFloor(null).floor, null);

  assert.equal(parseFloor({ ...good, source: 'nope' }).problem, 'source');
  assert.equal(parseFloor({ ...good, corners: good.corners.slice(0, 3) }).problem, 'corners');
  assert.equal(parseFloor({ ...good, corners: 'x' }).problem, 'corners');
  const bad = good.corners.map((c) => ({ ...c }));
  bad[1].x = '1';
  assert.equal(parseFloor({ ...good, corners: bad }).problem, 'number');
  bad[1].x = NaN;
  assert.equal(parseFloor({ ...good, corners: bad }).problem, 'number');
  const longNote = good.corners.map((c) => ({ ...c }));
  longNote[0].note = 'y'.repeat(41);
  assert.equal(parseFloor({ ...good, corners: longNote }).problem, 'note');
  assert.equal(parseFloor({ ...good, corners: longNote }).floor, null);
  longNote[0].note = 5;
  assert.equal(parseFloor({ ...good, corners: longNote }).problem, 'note');
  // Notes are trimmed; ones empty after trimming are dropped.
  const spaced = good.corners.map((c) => ({ ...c, note: '  hi  ' }));
  spaced[1].note = '   ';
  const parsed = parseFloor({ ...good, corners: spaced }).floor;
  assert.equal(parsed.corners[0].note, 'hi');
  assert.equal('note' in parsed.corners[1], false);
  // Corner keys other than x, y, z, note are dropped.
  const extra = good.corners.map((c) => ({ ...c, junk: 1 }));
  assert.deepEqual(parseFloor({ ...good, corners: extra }).floor, good);
});

test('rectangleAround an L-shaped polygon gives its minimum-area rectangle', () => {
  const L = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]].map(([x, z]) => ({ x, y: 1, z }));
  const r = rectangleAround(L);
  assert.equal(r.length, 4);
  const xs = r.map((p) => p.x);
  const zs = r.map((p) => p.z);
  assert.ok(near(Math.min(...xs), 0) && near(Math.max(...xs), 4));
  assert.ok(near(Math.min(...zs), 0) && near(Math.max(...zs), 4));
  r.forEach((p) => assert.ok(near(p.y, 1)));
  // Corner 1 has the smallest x+z.
  assert.ok(near(r[0].x, 0) && near(r[0].z, 0));
  // Counter-clockwise seen from above (x right, z toward the viewer): negative signed area in x/z.
  let area2 = 0;
  for (let i = 0; i < 4; i++) { const a = r[i]; const b = r[(i + 1) % 4]; area2 += a.x * b.z - b.x * a.z; }
  assert.ok(area2 < 0);

  // A tilted rectangle with a notch is found at its own angle.
  const a = 0.5;
  const tilted = [[0, 0], [6, 0], [6, 2], [0, 2]].map(([x, z]) => ({
    x: x * Math.cos(a) - z * Math.sin(a), y: 0, z: x * Math.sin(a) + z * Math.cos(a),
  }));
  const t = rectangleAround(tilted);
  const e = Math.hypot(t[1].x - t[0].x, t[1].z - t[0].z) * Math.hypot(t[2].x - t[1].x, t[2].z - t[1].z);
  assert.ok(near(e, 12, 1e-6));
});

test('rectangleAround a degenerate polygon gives null', () => {
  const P = (x, z) => ({ x, y: 0, z });
  assert.equal(rectangleAround([]), null);
  assert.equal(rectangleAround([P(0, 0), P(1, 1)]), null);
  assert.equal(rectangleAround([P(0, 0), P(0, 0), P(0, 0)]), null);
  assert.equal(rectangleAround([P(0, 0), P(1, 1), P(2, 2), P(3, 3)]), null);
});

test('pickFloorPolygon prefers the floor label, then the lowest horizontal plane', () => {
  const sq = (y) => [{ x: 0, y, z: 0 }, { x: 1, y, z: 0 }, { x: 1, y, z: 1 }];
  const planes = [
    { label: 'table', horizontal: true, points: sq(0.7) },
    { label: 'wall', horizontal: false, points: sq(-1) },
    { label: 'other', horizontal: true, points: sq(0.1) },
  ];
  assert.equal(pickFloorPolygon(planes), planes[2].points);
  const withFloor = [...planes, { label: 'floor', horizontal: true, points: sq(0.3) }];
  assert.equal(pickFloorPolygon(withFloor), withFloor[3].points);
  assert.equal(pickFloorPolygon([planes[1]]), null);
  assert.equal(pickFloorPolygon([]), null);
});

test('fitFloorFrame finds the placement whatever corner the detected rectangle starts at', () => {
  const recorded = room(30, [0, 0.01, 0.03, 0.02]);
  const { floor } = floorFromWorld(recorded, { source: 'corners' });
  // The same room placed elsewhere in the new session: rotated 90° and shifted.
  const a = Math.PI / 2;
  const placed = recorded.map((p) => ({
    x: 3 + p.x * Math.cos(a) - p.z * Math.sin(a),
    y: 0.5,
    z: 7 + p.x * Math.sin(a) + p.z * Math.cos(a),
  }));
  const truth = fitFloorFrame(floor, placed); // sanity: well defined
  for (let shift = 0; shift < 4; shift++) {
    for (const rev of [false, true]) {
      let rect = [0, 1, 2, 3].map((i) => placed[(i + shift) % 4]);
      if (rev) rect = [rect[0], rect[3], rect[2], rect[1]];
      const f = fitFloorFrame(floor, rect);
      const world = worldCornersOf(floor, frameFrom(f, floor));
      // A rectangle is symmetric under a half turn, so compare as a set of corners.
      world.forEach((w, i) => {
        const d = Math.min(...placed.map((q) => Math.hypot(w.x - q.x, w.z - q.z)));
        assert.ok(d < 0.01, `shift ${shift} rev ${rev} corner ${i}`);
      });
      let dyaw = Math.abs(f.yaw - truth.yaw) % Math.PI;
      if (dyaw > Math.PI / 2) dyaw = Math.PI - dyaw;
      assert.ok(dyaw < (0.5 * Math.PI) / 180, `yaw off by ${dyaw}`);
    }
  }
  // y of the origin is the rectangle's mean y.
  assert.ok(near(truth.origin.y, 0.5));
});

test('fitFloorFrameInOrder lays recorded corner i on tapped point i', () => {
  const recorded = room(30, [0, 0.01, 0.03, 0.02]);
  const { floor } = floorFromWorld(recorded, { source: 'corners' });
  const a = 0.7;
  const placed = floor.corners.map((p) => ({
    x: 3 + p.x * Math.cos(a) - p.z * Math.sin(a),
    y: 0.5 + p.y,
    z: 7 + p.x * Math.sin(a) + p.z * Math.cos(a),
  }));
  const f = fitFloorFrameInOrder(floor, placed);
  assert.ok(near(f.yaw, a));
  assert.ok(near(f.origin.x, 3) && near(f.origin.z, 7));
  assert.ok(near(f.origin.y, 0.5));
  worldCornersOf(floor, frameFrom(f, floor)).forEach((w, i) => {
    assert.ok(Math.hypot(w.x - placed[i].x, w.z - placed[i].z) < 0.01, `corner ${i}`);
  });
});

test('fitFloorFrameInOrder evens out taps a few centimetres off', () => {
  const recorded = room(30, [0, 0, 0, 0]);
  const { floor } = floorFromWorld(recorded, { source: 'corners' });
  const off = [[0.04, -0.02], [-0.03, 0.03], [0.02, 0.04], [-0.04, -0.03]];
  const taps = floor.corners.map((p, i) => ({ x: p.x + off[i][0], y: 0.1, z: p.z + off[i][1] }));
  const f = fitFloorFrameInOrder(floor, taps);
  assert.ok(Math.abs(f.yaw) < (2 * Math.PI) / 180, `yaw ${f.yaw}`);
  assert.ok(Math.hypot(f.origin.x, f.origin.z) < 0.05);
  assert.ok(near(f.origin.y, 0.1));
});

test('fitFloorFrameInOrder keeps the order the corners were tapped in', () => {
  // A square tapped starting from its second corner turns the frame a quarter, not back
  const square = [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, { x: 0, y: 0, z: 4 }];
  const { floor } = floorFromWorld(square, { source: 'corners' });
  const shifted = [1, 2, 3, 0].map((i) => square[i]);
  const f = fitFloorFrameInOrder(floor, shifted);
  assert.ok(near(Math.abs(f.yaw), Math.PI / 2), `yaw ${f.yaw}`);
  worldCornersOf(floor, frameFrom(f, floor)).forEach((w, i) => {
    assert.ok(Math.hypot(w.x - shifted[i].x, w.z - shifted[i].z) < 0.01, `corner ${i}`);
  });
});

test('fitFloorFrameInOrder needs four finite points', () => {
  const { floor } = floorFromWorld(room(30, [0, 0, 0, 0]), { source: 'corners' });
  assert.equal(fitFloorFrameInOrder(floor, floor.corners.slice(0, 3)), null);
  assert.equal(fitFloorFrameInOrder(floor, [...floor.corners.slice(0, 3), { x: NaN, y: 0, z: 0 }]), null);
  assert.equal(fitFloorFrameInOrder(floor, null), null);
});

test('frameFrom adds the span of corner 1→2', () => {
  const { floor } = floorFromWorld(room(30), { source: 'corners' });
  const f = frameFrom({ origin: { x: 1, y: 2, z: 3 }, yaw: 0.4 }, floor);
  assert.deepEqual(f.origin, { x: 1, y: 2, z: 3 });
  assert.equal(f.yaw, 0.4);
  assert.ok(near(f.spanM, 5));
  const w = fromSite(floor.corners[1], f);
  assert.ok(near(Math.hypot(w.x - 1, w.z - 3), 5));
});

test('markersOfFrame: the markers come from the frame, so a floor whose corner 1 is off the site origin lands right', async () => {
  const { markersOfFrame, worldCornersOf, frameFrom } = await import('../../src/pscom/floor-frame.js');
  const { siteFrame, toSite } = await import('../../src/pscom/roundtrip.js');
  // A .usda floor: corner 1 is not the site origin and corner 2 is off the x axis
  const floor = { source: 'usd', corners: [{ x: -1, y: 0, z: 2 }, { x: 5, y: 0, z: 1 }, { x: 5, y: 0, z: -4 }, { x: -1, y: 0, z: -4 }] };
  const frame = frameFrom({ origin: { x: 3, y: 0.2, z: -1 }, yaw: 0.7 }, floor);
  const [m1, m2] = markersOfFrame(frame);
  // The site the two markers make is the frame the floor was laid on
  const rebuilt = siteFrame(m1, m2);
  for (const [w, s] of worldCornersOf(floor, frame).map((w, i) => [w, floor.corners[i]])) {
    const back = toSite(w, rebuilt);
    assert.ok(Math.abs(back.x - s.x) < 1e-9 && Math.abs(back.z - s.z) < 1e-9 && Math.abs(back.y - s.y) < 1e-9);
  }
  assert.ok(Math.abs(rebuilt.spanM - frame.spanM) < 1e-9);
  // The old way (world corners 1 and 2) would not give the same site
  const [c1, c2] = worldCornersOf(floor, frame);
  const old = toSite(worldCornersOf(floor, frame)[2], siteFrame(c1, c2));
  assert.ok(Math.hypot(old.x - floor.corners[2].x, old.z - floor.corners[2].z) > 0.1);
});

test('tapsOffFrame names the corners whose tap is too high, too low or too far from the frame', () => {
  const frame = [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 0, z: 3 }, { x: 0, y: 0, z: 3 }];
  const taps = [
    { x: 0.05, y: 0.02, z: 0 }, // close
    { x: 4, y: 0.25, z: 0 }, // on the wall, 25 cm up
    { x: 4, y: 0, z: 3 + TAP_OFF_SIDE_M + 0.05 }, // beside the corner
    { x: 0, y: -0.2, z: 3 }, // below
  ];
  assert.deepEqual(tapsOffFrame(frame, taps), [1, 2, 3]);
  assert.deepEqual(tapsOffFrame(frame, frame), []);
  assert.deepEqual(tapsOffFrame(frame, taps.slice(0, 2)), [1]);
});

test('fitFloorFrameInOrder shrinks the recorded frame onto four close taps (a miniature)', () => {
  const recorded = room(30, [0, 0, 0, 0]);
  const { floor } = floorFromWorld(recorded, { source: 'corners' });
  const s = 0.05;
  const a = 0.4;
  const taps = floor.corners.map((p) => ({
    x: 2 + s * (p.x * Math.cos(a) - p.z * Math.sin(a)),
    y: 0.7,
    z: -1 + s * (p.x * Math.sin(a) + p.z * Math.cos(a)),
  }));
  const f = fitFloorFrameInOrder(floor, taps);
  assert.ok(near(f.scale, s, 1e-6), `scale ${f.scale}`);
  assert.ok(near(f.yaw, a));
  assert.ok(near(f.origin.y, 0.7));
  worldCornersOf(floor, frameFrom(f, floor)).forEach((w, i) => {
    assert.ok(Math.hypot(w.x - taps[i].x, w.z - taps[i].z) < 1e-6, `corner ${i}`);
    assert.ok(Math.abs(w.y - 0.7) < 1e-6, `corner ${i} height ${w.y}`);
  });
  // The markers it gives are where the site's corner 1 and its +x lie, scaled
  const [m1, m2] = markersOfFrame(frameFrom(f, floor));
  const span = Math.hypot(floor.corners[1].x - floor.corners[0].x, floor.corners[1].z - floor.corners[0].z);
  assert.ok(near(Math.hypot(m2.x - m1.x, m2.z - m1.z), s * span, 1e-6));
});

test('fitFloorFrameInOrder keeps real size when the taps are within 5 % of it', () => {
  const recorded = room(30, [0, 0, 0, 0]);
  const { floor } = floorFromWorld(recorded, { source: 'corners' });
  const taps = floor.corners.map((p) => ({ x: p.x * 1.04, y: 0, z: p.z * 1.04 }));
  assert.equal(fitFloorFrameInOrder(floor, taps).scale, 1);
  const bigger = floor.corners.map((p) => ({ x: p.x * 1.2, y: 0, z: p.z * 1.2 }));
  assert.ok(near(fitFloorFrameInOrder(floor, bigger).scale, 1.2, 1e-6));
});
