import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, siteToRos, rosToSite, siteYawToRos, rosYawToSite, placementToDevice, upgradeProject, issueId, wouldStand,
} from '../../src/pscom/record-upgrade.js';

const near = (a, b, label = '', within = 1e-6) => assert.ok(Math.abs(a - b) < within, `${label} ${a} vs ${b}`);
/** Two angles that face the same way, whatever whole turns lie between them. */
const sameTurn = (a, b, label = '', within = 1e-6) => near(Math.atan2(Math.sin(a - b), Math.cos(a - b)), 0, label, within);

const VERSION_2 = {
  schemaVersion: 2,
  projectId: 'p-1',
  frame: { frameId: 'site', up: '+Y', unit: 'm' },
  markers: [{ id: 'm1', x: 0, y: 0, z: 0 }, { id: 'm2', x: 3, y: 0, z: 0 }],
  placements: [
    { assetId: 'a1', robotId: 'scout', x: 1, y: 0, z: 2, yaw: 0.5 },
    { assetId: 'a2', robotId: 'go2', x: -1, y: 0.25, z: 0, yaw: 0 },
  ],
  routes: [
    { routeId: 'r-a1', assetId: 'a1', waypoints: [{ order: 0, t: 5000, x: 2, y: 0, z: 2 }, { order: 1, t: 5100, x: 3, y: 0, z: -1 }] },
    { routeId: 'r-a2', assetId: 'a2', note: 'round the back', waypoints: [{ order: 0, t: 30, x: 0, y: 0, z: 1 }] },
  ],
  traces: [
    { assetId: 'a1', samples: [{ t: 8000, x: 1, y: 0, z: 2, yaw: 0.5 }, { t: 8100, x: 1, y: 0, z: 2, yaw: 0.5 }] },
    { deviceId: 'gate-1', samples: [{ t: 0.5, position: [2, 0, 0] }, { t: 2, position: [2, 0, 0] }] },
  ],
  equipment: {
    site: { id: 'yard', displayName: 'Yard', spanM: 3, places: ['scout'] },
    devices: [{ id: 'gate-1', type: 'equipment', states: { open: {}, closed: {} }, transitionS: 3 }],
  },
  names: { 'gate-north': 'gate-1' },
  siteId: 'yard',
};

test('a version 2 recording with two placements becomes two product devices with their routes and traces', () => {
  const upgraded = upgradeProject(VERSION_2);
  assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal('placements' in upgraded, false);

  assert.deepEqual(upgraded.equipment.devices.map((d) => d.id), ['gate-1', 'a1', 'a2']);
  assert.deepEqual(upgraded.equipment.devices[1], {
    // The open build's bare id is read as the catalog's reference
    id: 'a1', product: 'physical-sandbox/scout:1', owner: 'viewer', parent: 'site',
    pose: { xyz: [1, -2, 0], rpy: [0, 0, siteYawToRos(0.5)] },
  });
  assert.deepEqual(upgraded.equipment.devices[2].pose.xyz, [-1, 0, 0.25]);
  // The names table still says what it said, and the placed robots answer to their own ids
  assert.deepEqual(upgraded.names, { 'gate-north': 'gate-1', a1: 'a1', a2: 'a2' });

  // Every t of version 3 is seconds from the first: the viewer's milliseconds are rewritten
  assert.deepEqual(upgraded.routes, [
    { routeId: 'r-a1', deviceId: 'a1', waypoints: [{ order: 0, t: 0, position: [2, -2, 0] }, { order: 1, t: 0.1, position: [3, 1, 0] }] },
    { routeId: 'r-a2', deviceId: 'a2', note: 'round the back', waypoints: [{ order: 0, t: 0, position: [0, -1, 0] }] },
  ]);
  const yaw = siteYawToRos(0.5);
  assert.deepEqual(upgraded.traces, [
    { deviceId: 'a1', samples: [{ t: 0, position: [1, -2, 0], yaw }, { t: 0.1, position: [1, -2, 0], yaw }] },
    // A device's trace already was, and is left as it came
    { deviceId: 'gate-1', samples: [{ t: 0.5, position: [2, 0, 0] }, { t: 2, position: [2, 0, 0] }] },
  ]);
  // Everything else comes along as it was
  assert.equal(upgraded.projectId, 'p-1');
  assert.equal(upgraded.siteId, 'yard');
  assert.deepEqual(upgraded.markers, VERSION_2.markers);
});

test('the recording it was given is not changed', () => {
  const before = structuredClone(VERSION_2);
  upgradeProject(VERSION_2);
  assert.deepEqual(VERSION_2, before);
});

test('a version 1 recording without equipment gets an empty site named after siteId', () => {
  const v1 = { schemaVersion: 1, frame: { frameId: 'site' }, markers: VERSION_2.markers, siteId: 'underpass',
    placements: [{ assetId: 'a1', robotId: 'scout', x: 0, y: 0, z: 0, yaw: 0 }], routes: [] };
  const upgraded = upgradeProject(v1);
  assert.deepEqual(upgraded.equipment.site, { id: 'underpass', displayName: { ja: '現地', en: 'Site' } });
  assert.deepEqual(upgraded.equipment.devices.map((d) => d.id), ['a1']);
  assert.deepEqual(upgraded.names, { a1: 'a1' });

  const bare = upgradeProject({ schemaVersion: 2, frame: { frameId: 'site' }, markers: VERSION_2.markers, equipment: null, names: {} });
  assert.deepEqual(bare.equipment, { site: { id: 'local', displayName: { ja: '現地', en: 'Site' } }, devices: [] });
  assert.deepEqual(bare.names, {});
  assert.deepEqual(bare.routes, []);
  assert.deepEqual(bare.traces, []);
});

test('places is dropped', () => {
  const upgraded = upgradeProject(VERSION_2);
  assert.deepEqual(upgraded.equipment.site, { id: 'yard', displayName: 'Yard', spanM: 3 });
});

test('a version 3 recording comes back untouched', () => {
  const v3 = upgradeProject(VERSION_2);
  assert.equal(upgradeProject(v3), v3);
  // And what is not a recording at all is not touched either
  assert.equal(upgradeProject(null), null);
  assert.equal(upgradeProject('text'), 'text');
});

test('positions: ROS (x, y, z) is the site frame\'s (x, z, −y)', () => {
  assert.deepEqual(siteToRos([1, 2, 3]), [1, -3, 2]);
  assert.deepEqual(rosToSite([1, -3, 2]), [1, 2, 3]);
  // No negative zero leaks into a recording
  assert.ok(Object.is(siteToRos([1, 0, 0])[1], 0));
  assert.ok(Object.is(rosToSite([1, 0, 0])[2], 0));
});

test('yaw survives the round trip', () => {
  for (const a of [0, 0.5, -0.5, 1.5, -1.5, 3, -3, Math.PI]) {
    sameTurn(rosYawToSite(siteYawToRos(a)), a, `site ${a}`);
    sameTurn(siteYawToRos(rosYawToSite(a)), a, `ROS ${a}`);
  }
});

test('placementToDevice names the product and stands on the site, owned by the viewer', () => {
  assert.deepEqual(placementToDevice({ assetId: 'a3', robotId: 'go2', x: 1, y: 0.5, z: -2 }), {
    id: 'a3', product: 'go2', owner: 'viewer', parent: 'site', pose: { xyz: [1, 2, 0.5], rpy: [0, 0, siteYawToRos(0)] },
  });
});

test('wouldStand is true when the equipment has any device — a robot placed by hand stands like the rest', () => {
  assert.equal(wouldStand({ equipment: { site: {}, devices: [{ id: 'gate-1' }] } }), true);
  assert.equal(wouldStand({ equipment: { site: {}, devices: [{ id: 'a1', product: 'scout', owner: 'viewer' }] } }), true);
  assert.equal(wouldStand({ equipment: { site: {}, devices: [{ id: 'scout-1', product: 'scout', owner: 'viewer' }] } }), true);
  assert.equal(wouldStand({ equipment: { site: {}, devices: [] } }), false);
  assert.equal(wouldStand({ equipment: { site: {}, devices: 'x' } }), false);
  assert.equal(wouldStand({}), false);
  assert.equal(wouldStand(null), false);
});

test('a route whose first waypoint has no t drops it and counts seconds from the first that has one', () => {
  const upgraded = upgradeProject({
    schemaVersion: 2,
    placements: [{ assetId: 'a1', robotId: 'scout', x: 0, y: 0, z: 0 }],
    routes: [{ routeId: 'r', assetId: 'a1', waypoints: [{ order: 0, x: 0, y: 0, z: 0 }, { order: 1, t: 5000, x: 1, y: 0, z: 0 }, { order: 2, t: 5100, x: 2, y: 0, z: 0 }] }],
    traces: [{ assetId: 'a1', samples: [{ x: 0, y: 0, z: 0 }, { t: 7000, x: 0, y: 0, z: 0 }, { t: 7100, x: 0, y: 0, z: 0 }] }],
  });
  assert.deepEqual(upgraded.routes[0].waypoints.map((w) => w.t), [0, 0.1]);
  assert.deepEqual(upgraded.traces[0].samples.map((s) => s.t), [0, 0.1]);
});

test('a route that never had times keeps all its waypoints', () => {
  const upgraded = upgradeProject({
    schemaVersion: 2,
    routes: [{ routeId: 'r', assetId: 'a1', waypoints: [{ order: 0, x: 0, y: 0, z: 0 }, { order: 1, x: 1, y: 0, z: 0 }] }],
  });
  assert.equal(upgraded.routes[0].waypoints.length, 2);
  assert.equal('t' in upgraded.routes[0].waypoints[0], false);
});

test('issueId counts up per product and never reuses', () => {
  const none = {};
  const [first, afterFirst] = issueId(none, 'scout');
  assert.equal(first, 'scout-1');
  assert.deepEqual(afterFirst, { scout: 1 });
  assert.deepEqual(none, {});

  const [second, afterSecond] = issueId(afterFirst, 'scout');
  assert.equal(second, 'scout-2');
  assert.deepEqual(afterSecond, { scout: 2 });
  assert.deepEqual(afterFirst, { scout: 1 });

  const [other, both] = issueId(afterSecond, 'go2');
  assert.equal(other, 'go2-1');
  assert.deepEqual(both, { scout: 2, go2: 1 });
  assert.equal(issueId(null, 'scout')[0], 'scout-1');
});
