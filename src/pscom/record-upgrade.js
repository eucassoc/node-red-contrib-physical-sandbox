// Copied from app/src/record-upgrade.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * Version 3 of the recording, and reading versions 1 and 2 as version 3.
 *
 * **A robot placed by hand is a device of the equipment that names its product** (the design
 * of 2026-10-16): `{ id, product, owner: 'viewer', parent: 'site', pose }`, not an entry of a
 * separate `placements` list. Its route and its trace go by its device id, and every position
 * a recording writes outside the markers is ROS (right-handed, Z up, metres), the same as a
 * device's pose. So a recording has one kind of thing on it and one way of saying where.
 *
 * **Every reader upgrades on the way in** (library-store.js, records-merge.js,
 * open-file-rules.js), so nothing after them sees a version 1 or 2 recording. record.js
 * writes version 3 only.
 *
 * Pure: touches neither the DOM nor three.
 */

import { deviceStem, refOf } from './catalog-client.js';

export const SCHEMA_VERSION = 3;

/** The site an upgraded recording stands on when it carried no equipment. */
const EMPTY_SITE_NAME = { ja: '現地', en: 'Site' };

/**
 * The site frame (roundtrip.js: marker 1 at the origin, marker 2 along +x, +y up) and ROS
 * (+X the same way, +Z up) are two conventions for one place: ROS (x, y, z) is the site's
 * (x, z, −y). `0 - v` and not `-v`, so a zero stays a zero and no −0 reaches a recording.
 */
export function siteToRos([x, y, z]) {
  return [x, 0 - z, y];
}

export function rosToSite([x, y, z]) {
  return [x, z, 0 - y];
}

/**
 * A turn in the site frame to the same heading as a ROS yaw (about +Z), and back.
 *
 * A site turn (record.js) is about +y, anticlockwise seen from above, and 0 is the model's
 * rest heading. robot.js's rosToThree() puts the model's ROS +X on three's −Z, so at turn ψ it
 * faces (−sin ψ, 0, −cos ψ) in the site frame (drive-geometry.js's forwardOf), which is ROS
 * (−sin ψ, cos ψ, 0): the direction of ROS yaw ψ + π/2. Pinned by tests/record-upgrade.test.js,
 * which stands a written placement on the stage and holds it against the robot placed by hand.
 * Kept in (−π, π].
 */
export function siteYawToRos(yaw) {
  return wrap(yaw + Math.PI / 2);
}

export function rosYawToSite(yaw) {
  return wrap(yaw - Math.PI / 2);
}

function wrap(angle) {
  const turned = Math.atan2(Math.sin(angle), Math.cos(angle));
  return turned === -Math.PI ? Math.PI : turned;
}

/**
 * A version 2 placement (site frame) as the device version 3 writes. Its id is the asset id
 * it had (`a1` …), so the routes, traces and flows that named it still do.
 */
export function placementToDevice(p) {
  return {
    id: p.assetId,
    product: p.robotId,
    owner: 'viewer',
    parent: 'site',
    pose: { xyz: siteToRos([p.x, p.y, p.z]), rpy: [0, 0, siteYawToRos(p.yaw ?? 0)] },
  };
}

/**
 * Whether choosing this recording stands something: its equipment has a device. A robot placed
 * by hand is one of them, and stands like the rest.
 */
export function wouldStand(project) {
  const devices = project?.equipment?.devices;
  return Array.isArray(devices) && devices.length > 0;
}

/** The equipment of a recording that carried none: an empty site. */
export function emptyEquipment(siteId) {
  return { site: { id: siteId ?? 'local', displayName: { ...EMPTY_SITE_NAME } }, devices: [] };
}

/** A site description as version 3 has it: `places` is gone (the menu is one's own to narrow). */
export function siteWithoutPlaces(site) {
  if (!site || typeof site !== 'object' || !('places' in site)) return site;
  const { places, ...rest } = site;
  return rest;
}

/**
 * Any recording as version 3. Version 3 (or anything that is not a recording) comes back as it
 * is; the one given is never changed.
 *
 * - no equipment → an empty site named after `siteId`, and an empty names table
 * - each placement → a device at the end of `equipment.devices`, answering to its own id
 * - routes and a placed robot's trace → by `deviceId`, positions in ROS, and `t` in seconds
 *   from the first (version 2 wrote the viewer's clock, in milliseconds); a device's trace
 *   stays as it was (already ROS, `t` already seconds from its first sample)
 * - `equipment.site.places` is dropped
 *
 * **Version 1 wrote its turns with the opposite sign** and did not keep the frame, so there
 * is nothing to put them right with: its turns are read as version 2's.
 */
export function upgradeProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return project;
  if (typeof project.schemaVersion === 'number' && project.schemaVersion >= SCHEMA_VERSION) return withCatalogRefs(project);

  const { placements, ...rest } = project;
  const placed = list(placements).filter((p) => p && typeof p === 'object').map(placementToDevice);

  const given = project.equipment && typeof project.equipment === 'object' ? project.equipment : null;
  const base = given ?? emptyEquipment(project.siteId);
  const devices = [...list(base.devices), ...placed];
  const equipment = { ...base, site: siteWithoutPlaces(base.site), devices };

  const names = project.names && typeof project.names === 'object' && !Array.isArray(project.names)
    ? { ...project.names }
    : Object.fromEntries(list(base.devices).filter((d) => typeof d?.id === 'string').map((d) => [d.id, d.id]));
  for (const device of placed) names[device.id] = device.id;

  return withCatalogRefs({
    ...rest,
    schemaVersion: SCHEMA_VERSION,
    routes: list(project.routes).map(upgradeRoute),
    traces: list(project.traces).map(upgradeTrace),
    equipment,
    names,
  });
}

/**
 * **The one mending of the open build's bare ids** (2026-11-01): a device's `product` or
 * `endEffector` with no `/` (`so101`) becomes the catalog's `physical-sandbox/so101:1`. The
 * server never rewrites a stored recording; every reader passes through here. A recording that
 * needs nothing mended comes back as the same object.
 */
function withCatalogRefs(project) {
  const devices = project.equipment?.devices;
  if (!Array.isArray(devices)) return project;
  const bare = (id) => typeof id === 'string' && !id.includes('/');
  if (!devices.some((d) => d && typeof d === 'object' && (bare(d.product) || bare(d.endEffector)))) return project;
  return {
    ...project,
    equipment: {
      ...project.equipment,
      devices: devices.map((d) => {
        if (!d || typeof d !== 'object') return d;
        const mended = { ...d };
        if (bare(d.product)) mended.product = refOf(d.product);
        if (bare(d.endEffector)) mended.endEffector = refOf(d.endEffector);
        return mended;
      }),
    },
  };
}

/**
 * A time on the viewer's clock [ms] as version 3 has every `t`: seconds from the first of its
 * run, to the millisecond.
 */
export function secondsSince(t, firstT) {
  return Math.round(t - firstT) / 1000;
}

/**
 * The first `t` of a run: the first item that has a number. An item without one cannot be put
 * on the seconds scale, so it is dropped rather than left in milliseconds beside the rest.
 */
const firstT = (items) => items.find((item) => typeof item?.t === 'number')?.t;
const since = (t, first) => (first === undefined ? t : secondsSince(t, first));
/** Only the items with a time, when any has one; a run that never had times is left whole. */
const timedIfAny = (items) => (firstT(items) === undefined ? items : items.filter((item) => typeof item?.t === 'number'));

function upgradeRoute(route) {
  if (!route || typeof route !== 'object' || !('assetId' in route)) return route;
  const waypoints = timedIfAny(list(route.waypoints));
  const first = firstT(waypoints);
  return {
    ...(route.routeId !== undefined ? { routeId: route.routeId } : {}),
    deviceId: route.assetId,
    ...(route.note !== undefined ? { note: route.note } : {}),
    waypoints: waypoints.map((w) => ({
      ...(w.order !== undefined ? { order: w.order } : {}),
      ...(w.t !== undefined ? { t: since(w.t, first) } : {}),
      position: siteToRos([w.x, w.y, w.z]),
    })),
  };
}

function upgradeTrace(trace) {
  // A device's trace is already in ROS and in seconds
  if (!trace || typeof trace !== 'object' || !('assetId' in trace)) return trace;
  const samples = timedIfAny(list(trace.samples));
  const first = firstT(samples);
  return {
    deviceId: trace.assetId,
    samples: samples.map((s) => ({
      ...(s.t !== undefined ? { t: since(s.t, first) } : {}),
      position: siteToRos([s.x, s.y, s.z]),
      ...(typeof s.yaw === 'number' ? { yaw: siteYawToRos(s.yaw) } : {}),
    })),
  };
}

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The next id for a product placed in a recording, and the counts after it: `scout-1`, then
 * `scout-2`, … **A number once given is never given again**, even after that one is removed
 * (an id once out is a promise: recordings, flows and MQTT topics name it). `issued` is
 * `{ [productId]: lastNumber }` and is not changed.
 *
 * @returns {[string, Record<string, number>]}
 */
export function issueId(issued, productId) {
  // Counted and named by the item's name (`so101-1`), not the reference: a device id carries no
  // `/` or `:`, and a count kept before the catalog goes on from where it was
  const stem = deviceStem(productId);
  const next = (issued?.[stem] ?? 0) + 1;
  return [`${stem}-${next}`, { ...(issued ?? {}), [stem]: next }];
}
