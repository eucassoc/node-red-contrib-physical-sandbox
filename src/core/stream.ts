/**
 * A stream of state messages and a record are the same thing (design §5, 2026-11-11).
 *
 * - `messagesToRecord`: the state messages of a stream, on a scene, written as a version 3 record
 *   the way PS.com's record.js writes one (rounding, 30 samples a second, 100000 samples a device).
 * - `recordToMessages`: a record (any version; it is upgraded first) as its scene and the state
 *   messages that replay it.
 * - `mergeStreamInto`: saving a stream over the record it came from, changing only what the stream
 *   and the scene changed (the rule of psbx `record_edit.merge_into`).
 *
 * Only `state` messages make a record: commands and events go to the pane live and are not kept.
 * Pure: no Node-RED, no files, no clock.
 */
import { applyState, isTopicName, newStore, parseTopic } from '../pscom/state.js';
import { SCHEMA_VERSION, upgradeProject } from '../pscom/record-upgrade.js';
import { floorFromWorld, markersOfFrame, parseFloor } from '../pscom/floor-frame.js';
import { toSite } from '../pscom/roundtrip.js';

type Json = Record<string, any>;
type Xyz = [number, number, number];

/** One MQTT message as the plugin passes it around: `ps/<site>/<outside name>/<kind>`, `at` = `payload.at` [ms]. */
export interface Message {
  topic: string;
  payload: Record<string, unknown> & { at: number };
  at: number;
}

/** A device exactly as a version 3 record has it (ROS metres and radians); other keys are kept as they are. */
export interface Device {
  id: string;
  product?: string;
  owner?: string;
  parent: string;
  pose?: { xyz: Xyz; rpy: Xyz };
  type?: string;
  shape?: unknown;
  render?: unknown;
  [key: string]: unknown;
}

export interface Point3 { x: number; y: number; z: number }

/** 「場」: what the pane shows a stream on. */
export interface Scene {
  site: string;
  siteFrameId: string | null;
  background: { kind: 'still' | 'video'; name: string } | null;
  camera: { intr: unknown; extr: unknown } | null;
  /**
   * The floor's four corners in the site frame (y up, metres): corner 1 at the origin and 1→2
   * along +x, as pose-solve.js makes them for a new floor and as a record keeps them.
   */
  floor: { corners: Point3[]; edgesM: [number, number] } | null;
  devices: Device[];
  /** Outside name (the topic's `<id>`) → device id. */
  names: Record<string, string>;
  /**
   * Outside names that only this stream answers to, never written into a record: the id → id that
   * `recordToMessages` gives a device with a trace but no outside name. `names` wins over these.
   */
  streamNames?: Record<string, string>;
}

/** PS.com record.js: at most thirty samples a second per device, and at most this many in all. */
export const DEVICE_TRACE_MIN_GAP_MS = 1000 / 30;
export const DEVICE_TRACE_MAX_SAMPLES = 100000;

/**
 * A record keeps its times to the millisecond, so a 30/s trace read back from one has gaps of
 * 33 ms (34 now and then), a little under DEVICE_TRACE_MIN_GAP_MS. The gap is compared at the
 * record's millisecond, so such a trace goes round without losing every other sample.
 */
const MIN_GAP_ON_RECORD_MS = Math.floor(DEVICE_TRACE_MIN_GAP_MS);

/** Below a millimetre means nothing (PS.com record.js). */
const round3 = (v: number) => Math.round(v * 1000) / 1000;
/** The same, with -0 turned into 0 (floor-frame.js). */
const mm = (v: number) => Math.round(v * 1000) / 1000 + 0;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isXyz = (v: unknown): v is Xyz => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const own = (table: Record<string, string>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** The fields one sample carries: what the message carried, rounded. */
interface Fields { position?: number[]; yaw?: number; joints?: Record<string, number> }

/**
 * The state messages of a stream as a version 3 record on `scene`.
 *
 * `skipped` is each outside name that came with state messages but answers to no device, once, in
 * the order first seen: those messages move nothing and are left out. Everything else that is
 * left out (commands, events, other sites, rubbish, an older `at`, a sample inside the 30/s gap)
 * is left out silently, as the pane leaves it out.
 */
export function messagesToRecord(
  scene: Scene,
  messages: Message[],
  opts: { title?: string; basedOn?: string } = {},
): { record: Json; skipped: string[] } {
  const byId = new Map(scene.devices.map((d) => [d.id, d]));
  const store = newStore();
  const samples = new Map<string, (Fields & { at: number })[]>();
  const skipped: string[] = [];

  for (const message of messages) {
    const topic = parseTopic(message?.topic);
    if (!topic || topic.kind !== 'state' || topic.site !== scene.site) continue;
    const payload = message.payload;
    if (!isObject(payload) || !Number.isFinite(payload.at)) continue;

    const id = own(scene.names, topic.id) ?? own(scene.streamNames ?? {}, topic.id);
    const device = id === undefined ? undefined : byId.get(id);
    if (!device) {
      if (!skipped.includes(topic.id)) skipped.push(topic.id);
      continue;
    }

    // Only a mover and an item have samples: a mover's joints, position and yaw, an item's place.
    // An item's parent is not recorded (a record keeps states only, design §5): its `xyz` becomes
    // a position sample of that item device.
    const isItem = device.type === 'item';
    if (!applyState(store, { id: device.id, type: isItem ? 'item' : 'mover' }, payload)) continue;
    const fields = isItem ? { position: (payload.xyz as Xyz).map(round3) } : moverFields(payload);

    let trace = samples.get(device.id);
    if (!trace) samples.set(device.id, (trace = []));
    if (trace.length >= DEVICE_TRACE_MAX_SAMPLES) continue;
    const last = trace[trace.length - 1];
    if (last && Math.round(payload.at - last.at) < MIN_GAP_ON_RECORD_MS) continue;
    trace.push({ at: payload.at, ...fields });
  }

  const traces = scene.devices.filter((d) => samples.has(d.id)).map((d) => {
    const run = samples.get(d.id)!;
    return { deviceId: d.id, samples: run.map(({ at, ...fields }) => ({ t: round3((at - run[0].at) / 1000), ...fields })) };
  });

  let markers: Json[] = [];
  let floor: Json | null = null;
  if (scene.floor) {
    // A floor the pane decided from clicked corners (floor-frame.js FLOOR_SOURCES). Typed loosely:
    // TypeScript reads the copied JS's options as `{ notes? }` only.
    const options: Json = { source: 'corners' };
    const made = floorFromWorld(scene.floor.corners, options);
    floor = made.floor;
    markers = markersOfFrame(made.frame).map((point: Point3, i: number) => {
      const s = toSite(point, made.frame);
      return { id: String(i + 1), x: mm(s.x), y: mm(s.y), z: mm(s.z) };
    });
  }

  const record: Json = {
    schemaVersion: SCHEMA_VERSION,
    ...(opts.title ? { name: opts.title } : {}),
    ...(opts.basedOn ? { basedOn: opts.basedOn } : {}),
    frame: { frameId: 'site', up: '+Y', unit: 'm' },
    markers,
    ...(floor ? { floor } : {}),
    ...(scene.siteFrameId ? { siteFrameId: scene.siteFrameId } : {}),
    equipment: { site: { id: scene.site }, devices: structuredClone(scene.devices) },
    names: { ...scene.names },
    traces,
    routes: [],
  };
  return { record, skipped };
}

/** A mover's sample fields from a message applyState took: whatever of position, yaw and joints it carried. */
function moverFields(payload: Json): Fields {
  const joints = isObject(payload.joints)
    ? Object.fromEntries(Object.entries(payload.joints)
      .filter(([name, angle]) => isTopicName(name) && Number.isFinite(angle))
      .map(([name, angle]) => [name, round3(angle as number)]))
    : {};
  return {
    ...(isXyz(payload.position) ? { position: payload.position.map(round3) } : {}),
    ...(Number.isFinite(payload.yaw) ? { yaw: round3(payload.yaw) } : {}),
    ...(Object.keys(joints).length ? { joints } : {}),
  };
}

/**
 * A record as its scene and the state messages that replay it: per sample,
 * `ps/<site>/<outside name>/state` with `at = startAt + t·1000` (to the millisecond), in time order.
 *
 * The site is `opts.site`, else the record's `equipment.site.id`, else `local`. The names are the
 * record's (every device to itself when it has none, PS.com equipment-rules.js `defaultNames`); a
 * device with a trace but no outside name answers to its own id in `scene.streamNames`, so every
 * trace can be streamed without the record that is saved later gaining a name it did not have. A record carries no background or camera: those stay null.
 */
export function recordToMessages(
  record: Json,
  opts: { startAt?: number; site?: string } = {},
): { scene: Scene; messages: Message[] } {
  const rec: Json = asVersion3(record) ?? {};
  const devices: Device[] = structuredClone(list(rec.equipment?.devices).filter((d) => isObject(d) && typeof d.id === 'string'));
  const recordSite = rec.equipment?.site?.id;
  const site = opts.site ?? (isTopicName(recordSite) ? recordSite : 'local');
  const startAt = opts.startAt ?? 0;

  const names: Record<string, string> = isObject(rec.names)
    ? Object.fromEntries(Object.entries(rec.names).filter(([, id]) => typeof id === 'string'))
    : Object.fromEntries(devices.map((d) => [d.id, d.id]));
  const streamNames: Record<string, string> = {};
  const outsideOf = (id: string): string | undefined => {
    const name = Object.keys(names).find((k) => names[k] === id);
    if (name !== undefined) return name;
    if (Object.hasOwn(names, id)) return undefined;   // its id is another device's outside name
    streamNames[id] = id;
    return id;
  };

  const byId = new Map(devices.map((d) => [d.id, d]));
  const messages: Message[] = [];
  for (const trace of list(rec.traces)) {
    const device = byId.get(trace?.deviceId);
    if (!device) continue;
    const timed = list(trace.samples).filter((s) => isObject(s) && Number.isFinite(s.t));
    if (!timed.length) continue;
    const outside = outsideOf(device.id);
    if (outside === undefined) continue;
    const topic = `ps/${site}/${outside}/state`;
    for (const sample of timed) {
      const at = startAt + Math.round(sample.t * 1000);
      const payload = device.type === 'item' ? itemPayload(at, device, sample) : moverPayload(at, sample);
      if (payload) messages.push({ topic, payload, at });
    }
  }
  messages.sort((a, b) => a.at - b.at);   // stable: devices keep their order at the same time

  const scene: Scene = {
    site,
    siteFrameId: typeof rec.siteFrameId === 'string' && rec.siteFrameId ? rec.siteFrameId : null,
    background: null,
    camera: null,
    floor: sceneFloor(rec.floor),
    devices,
    names,
    ...(Object.keys(streamNames).length ? { streamNames } : {}),
  };
  return { scene, messages };
}

function itemPayload(at: number, device: Device, sample: Json): Message['payload'] | null {
  if (!isXyz(sample.position)) return null;
  return { at, type: 'item', parent: device.parent, xyz: [...sample.position] };
}

function moverPayload(at: number, sample: Json): Message['payload'] | null {
  const hasJoints = isObject(sample.joints);
  const hasPosition = isXyz(sample.position);
  if (!hasJoints && !hasPosition) return null;
  return {
    at,
    ...(hasJoints ? { joints: { ...sample.joints } } : {}),
    ...(hasPosition ? { position: [...sample.position] } : {}),
    ...(Number.isFinite(sample.yaw) ? { yaw: sample.yaw } : {}),
  };
}

/** A record's floor as the scene has it: the corners (notes left out) and the lengths of 1→2 and 2→3. */
function sceneFloor(raw: unknown): Scene['floor'] {
  const { floor } = parseFloor(raw);
  if (!floor) return null;
  const corners: Point3[] = floor.corners.map(({ x, y, z }: Point3) => ({ x, y, z }));
  const length = (a: Point3, b: Point3) => round3(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  return { corners, edgesM: [length(corners[0], corners[1]), length(corners[1], corners[2])] };
}

/**
 * Saving a stream over `baseRecord` (psbx `record_edit.merge_into`'s rule): a copy where
 *
 * - each device `messages` carry gets its trace replaced (or added) by theirs. The caller passes
 *   only what came in after the record was opened (its live and agent states): a trace nothing
 *   new came for is kept exactly as the record has it, samples, precision and fields;
 * - each device whose pose the scene changed in x, y or yaw gets those three, keeping its z, roll
 *   and pitch (an arm standing on a table stays up there); a device with no pose takes the scene's;
 * - a device the scene has and the base does not is added, with the outside names the scene gives it;
 *
 * and everything else (every other top-level key, device, trace and field) stays as it was. A
 * record older than version 3 is upgraded first (asVersion3); a version 3 record is used exactly as it is.
 */
export function mergeStreamInto(baseRecord: Json, scene: Scene, messages: Message[]): Json {
  const out: Json = structuredClone(asVersion3(baseRecord));

  if (!isObject(out.equipment)) out.equipment = {};
  if (!Array.isArray(out.equipment.devices)) out.equipment.devices = [];
  const devices: Json[] = out.equipment.devices;
  for (const wanted of scene.devices) {
    const held = devices.find((d) => isObject(d) && d.id === wanted.id);
    if (!held) {
      devices.push(structuredClone(wanted));
      if (isObject(out.names)) {
        for (const [name, id] of Object.entries(scene.names)) {
          if (id === wanted.id && !Object.hasOwn(out.names, name)) out.names[name] = id;
        }
      }
      continue;
    }
    if (!wanted.pose || !isXyz(wanted.pose.xyz) || !isXyz(wanted.pose.rpy)) continue;
    const pose = held.pose;
    if (!(isObject(pose) && isXyz(pose.xyz) && isXyz(pose.rpy))) {
      held.pose = structuredClone(wanted.pose);
      continue;
    }
    const [x, y] = wanted.pose.xyz;
    const yaw = wanted.pose.rpy[2];
    if (x === pose.xyz[0] && y === pose.xyz[1] && yaw === pose.rpy[2]) continue;
    held.pose = { ...pose, xyz: [x, y, pose.xyz[2]], rpy: [pose.rpy[0], pose.rpy[1], yaw] };
  }

  const { record: streamed } = messagesToRecord(scene, messages);
  if (!Array.isArray(out.traces)) out.traces = [];
  for (const trace of streamed.traces) {
    const at = out.traces.findIndex((t: Json) => isObject(t) && t.deviceId === trace.deviceId);
    if (at < 0) out.traces.push(trace);
    else out.traces[at] = { ...out.traces[at], samples: trace.samples };
  }
  return out;
}

/**
 * A record as version 3, with every device's `product` and `endEffector` as the record wrote them.
 *
 * A version 3 record comes back as it is. An older one goes through PS.com's `upgradeProject`,
 * and then each device gets back the product and end effector it was written with (a placement's
 * `robotId`): **in this package a bare product (`mybot`) names a local machine**, found before
 * the catalog, so the catalog ref (`physical-sandbox/mybot:1`) that PS.com's readers mend it into
 * would point somewhere else.
 */
export function asVersion3(record: Json): Json {
  if (!isObject(record)) return record;
  if (typeof record.schemaVersion === 'number' && record.schemaVersion >= SCHEMA_VERSION) return record;
  const written = new Map<string, Json>();
  for (const d of list(record.equipment?.devices)) {
    if (isObject(d) && typeof d.id === 'string') written.set(d.id, d);
  }
  for (const p of list(record.placements)) {
    if (isObject(p) && typeof p.assetId === 'string') written.set(p.assetId, { product: p.robotId });
  }
  const upgraded: Json = upgradeProject(record);
  if (!Array.isArray(upgraded?.equipment?.devices)) return upgraded;
  const devices = upgraded.equipment.devices.map((d: unknown) => {
    const was = isObject(d) ? written.get(d.id) : undefined;
    if (!isObject(d) || !was) return d;
    const kept: Json = { ...d };
    for (const key of ['product', 'endEffector']) if (key in was) kept[key] = was[key];
    return kept;
  });
  return { ...upgraded, equipment: { ...upgraded.equipment, devices } };
}
