/**
 * The hub: what every pane and node of this Node-RED shares.
 *
 * - The scene (「場」: site, floor and camera, placed devices, names), kept in
 *   `<userDir>/physical-sandbox/scene.json` and restored at start.
 * - The stream: every message that comes in (`push`, from `ps in`, a record being played or, later,
 *   the agent) is checked as PS.com's devices/state.js checks a broker's (rubbish until it proves
 *   otherwise, an older `at` never wins), sent to every pane, and its state messages are kept in
 *   the stream buffer that a save turns into a record.
 * - The latest state of every device, so that a pane opened late shows what the others show.
 *
 * Panes hear the hub through `RED.comms`: `ps-pane/scene` (retained, the whole scene),
 * `ps-pane/state` (one message as it comes), `ps-pane/snapshot` (retained, the latest state of every
 * device, at most ten times a second) and `ps-pane/status` (retained: login, unsent copies, playing,
 * the agent switch, the opened record and how many messages the stream holds). Node-RED sends
 * the retained ones to an editor when it subscribes, so a late pane starts where the others are.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyState, decode, isTopicName, newStore, parseTopic } from '../pscom/state.js';
import { recordToMessages, type Device, type Message, type Scene } from '../core/stream.js';
import { PsComClient, tokenFileIn, type LoginStatus } from '../core/pscom-client.js';
import { pending, sendAll, unsentDirIn, type SendAllResult, type Sender } from '../core/unsent.js';
import { isLocalMachine } from '../core/machines.js';
import type { PluginSettings } from './settings.js';

type Json = Record<string, any>;
type FetchLike = (url: string, init?: any) => Promise<any>;

export type From = 'mqtt' | 'record' | 'agent';

/** The clock the hub plays records by (tests give a fake one). */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The record the pane opened: from PS.com (`ref` is `handle/name`) or from a file. */
export type Opened =
  | { ref: string; version: string; latest: string; own: boolean; record: Json }
  | { file: string; record: Json };

export interface Status {
  login: LoginStatus;
  unsent: { name: string; ref: string; mode: 'new' | 'over' }[];
  playing: { source: string; t: number; duration: number } | null;
  agentFrames: boolean;
  /** How many state messages the stream buffer holds (what a save would write). */
  recorded: number;
  /** The opened record, without its content; `own` says whether it can be saved over. */
  opened: { ref: string; version: string; own: boolean } | { file: string } | null;
}

export interface HubOptions {
  userDir: string;
  settings: PluginSettings;
  clock?: Clock;
  /** For PS.com and the catalog (tests give a fake one). */
  fetchImpl?: FetchLike;
  /** Between two login polls (3 s; tests use 0). */
  pollMs?: number;
}

export interface Hub {
  readonly settings: PluginSettings;
  readonly userDir: string;
  readonly dirs: { root: string; unsent: string; backgrounds: string; exports: string };
  readonly client: PsComClient;
  readonly sender: Sender;
  scene(): Scene;
  /** Change some of the scene's fields; kept on disk and sent to the panes. */
  setScene(patch: Partial<Scene>): Scene;
  /** One message into the stream; false (and nothing else happens) when it is not one or is older. */
  push(message: unknown, from: From): boolean;
  /** Play a record's state messages into the stream in time; a play under way stops first. */
  play(record: unknown, opts?: { loop?: boolean; speed?: number; source?: string }): { count: number; duration: number };
  stop(): void;
  streamBuffer(): Message[];
  clearStream(): void;
  status(): Status;
  publishStatus(): void;
  /** Open a record: its scene (keeping the background), an empty stream, and it is the opened record. */
  open(record: Json, opened: Opened): Scene;
  openedRecord(): Opened | null;
  /** The opened record after a save (the scene and the stream stay as they are). */
  setOpened(opened: Opened | null): void;
  /** Whether the scene's floor is the opened record's: the corners must then be clicked in its order. */
  floorIsKnown(): boolean;
  setAgentFrames(on: boolean): void;
  /** Send the kept copies (at start, after a login, on 再送信する). */
  sendUnsent(): Promise<SendAllResult>;
  close(): void;
}

export const SCENE_TOPIC = 'ps-pane/scene';
export const STATE_TOPIC = 'ps-pane/state';
export const SNAPSHOT_TOPIC = 'ps-pane/snapshot';
export const STATUS_TOPIC = 'ps-pane/status';
/** The snapshot goes out at most this often. */
export const SNAPSHOT_MS = 100;
/** A stream keeps at most this many state messages (about an hour of ten devices at 5/s); later ones still reach the panes. */
export const STREAM_MAX = 200_000;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPoint = (c: unknown): boolean => isObject(c) && ['x', 'y', 'z'].every((k) => Number.isFinite(c[k]));
const nameTable = (v: unknown): Record<string, string> =>
  isObject(v) ? Object.fromEntries(Object.entries(v).filter(([k, id]) => isTopicName(k) && typeof id === 'string')) : {};
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.(); // a record being played never keeps Node-RED from stopping
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A scene from anything (scene.json, a patch): what is not right is left out or set to its empty value. */
export function normalizeScene(raw: unknown, site: string): Scene {
  const s: Json = isObject(raw) ? raw : {};
  const bg = s.background;
  const floor = s.floor;
  const streamNames = nameTable(s.streamNames);
  return {
    site: isTopicName(s.site) ? s.site : site,
    siteFrameId: typeof s.siteFrameId === 'string' && s.siteFrameId ? s.siteFrameId : null,
    background: isObject(bg) && (bg.kind === 'still' || bg.kind === 'video') && typeof bg.name === 'string' && bg.name
      ? { kind: bg.kind, name: bg.name } : null,
    camera: isObject(s.camera) && isObject(s.camera.intr) && isObject(s.camera.extr) ? { intr: s.camera.intr, extr: s.camera.extr } : null,
    floor: isObject(floor) && Array.isArray(floor.corners) && floor.corners.length === 4 && floor.corners.every(isPoint)
      && Array.isArray(floor.edgesM) && floor.edgesM.length === 2 && floor.edgesM.every((e: unknown) => Number.isFinite(e) && (e as number) > 0)
      ? { corners: floor.corners.map(({ x, y, z }: Json) => ({ x, y, z })), edgesM: [floor.edgesM[0], floor.edgesM[1]] }
      : null,
    devices: Array.isArray(s.devices) ? s.devices.filter((d: unknown) => isObject(d) && isTopicName(d.id)) as Device[] : [],
    names: nameTable(s.names),
    ...(Object.keys(streamNames).length ? { streamNames } : {}),
  };
}

/**
 * One message as the hub takes it, or null: `ps/<site>/<id>/<kind>` with site and id topic names,
 * and a payload (an object, or JSON text) with a finite `at`. The payload is copied as plain JSON.
 */
export function validMessage(raw: unknown): Message | null {
  if (!isObject(raw) || typeof raw.topic !== 'string') return null;
  const topic = parseTopic(raw.topic);
  if (!topic || !isTopicName(topic.site) || !isTopicName(topic.id)) return null;
  let payload: unknown = raw.payload;
  if (typeof payload === 'string') payload = decode(payload);
  else if (Buffer.isBuffer(payload)) payload = decode(payload.toString('utf8'));
  if (!isObject(payload) || !Number.isFinite(payload.at)) return null;
  try {
    payload = plain(payload);
  } catch {
    return null; // not JSON (a BigInt, a cycle)
  }
  return { topic: raw.topic, payload: payload as Message['payload'], at: (payload as Json).at };
}

export function createHub(RED: any, opts: HubOptions): Hub {
  const { userDir, settings } = opts;
  const clock = opts.clock ?? realClock;
  const root = join(userDir, 'physical-sandbox');
  const dirs = { root, unsent: unsentDirIn(userDir), backgrounds: join(root, 'backgrounds'), exports: join(root, 'exports') };
  const sceneFile = join(root, 'scene.json');
  const client = new PsComClient({
    base: settings.catalogBase,
    tokenFile: tokenFileIn(userDir),
    fetchImpl: opts.fetchImpl,
    pollMs: opts.pollMs,
    isLocalMachine: (name) => isLocalMachine(name, settings.localMachineDirs),
  });
  const sender: Sender = client.saveRecord.bind(client);

  const publish = (topic: string, data: unknown, retain: boolean): void => {
    try {
      RED.comms.publish(topic, plain(data), retain);
    } catch (e) {
      RED.log?.warn?.(`physical-sandbox: ${topic}: ${(e as Error)?.message ?? e}`);
    }
  };

  // ---- the scene ----

  let scene = restoreScene();

  function restoreScene(): Scene {
    let raw: unknown = null;
    try { raw = JSON.parse(readFileSync(sceneFile, 'utf8')); } catch { /* none yet, or not readable */ }
    const restored = normalizeScene(raw, settings.site);
    // The picture is the person's file: when it is gone, so is the background
    if (restored.background && !existsSync(join(dirs.backgrounds, restored.background.name))) restored.background = null;
    return restored;
  }

  function keepScene(): void {
    mkdirSync(root, { recursive: true });
    const tmp = `${sceneFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(scene, null, 1) + '\n');
      renameSync(tmp, sceneFile);
    } catch (e) {
      rmSync(tmp, { force: true });
      RED.log?.warn?.(`physical-sandbox: scene.json: ${(e as Error)?.message ?? e}`);
    }
  }

  function replaceScene(next: unknown): Scene {
    scene = normalizeScene(next, settings.site);
    keepScene();
    publish(SCENE_TOPIC, scene, true);
    return plain(scene);
  }

  // ---- the stream and the latest states ----

  const store = newStore();
  let buffer: Message[] = [];
  let tickTimer: unknown = null;
  let lastTick = -Infinity;
  let recordedShown = 0;

  /** Whether a state for this topic is an item's (the device the name stands for, else what the message says). */
  function isItemTopic(id: string, payload: Json): boolean {
    const deviceId = (Object.hasOwn(scene.names, id) ? scene.names[id] : undefined)
      ?? (scene.streamNames && Object.hasOwn(scene.streamNames, id) ? scene.streamNames[id] : undefined);
    const device = deviceId === undefined ? undefined : scene.devices.find((d) => d.id === deviceId);
    return device ? device.type === 'item' : payload.type === 'item';
  }

  function snapshot(): Message[] {
    return [...store.entries()].map(([topic, held]: [string, Json]) => {
      const payload = 'xyz' in held ? { ...held, type: 'item' } : { ...held };
      return { topic, payload: payload as Message['payload'], at: held.at };
    });
  }

  function tick(): void {
    lastTick = clock.now();
    publish(SNAPSHOT_TOPIC, snapshot(), true);
    if (recordedShown !== buffer.length) publishStatus();
  }

  /** The snapshot at once when the last one is 100 ms old, else once when it is. */
  function scheduleTick(): void {
    if (tickTimer !== null) return;
    const wait = lastTick + SNAPSHOT_MS - clock.now();
    if (wait <= 0) { tick(); return; }
    tickTimer = clock.setTimeout(() => { tickTimer = null; tick(); }, wait);
  }

  function push(raw: unknown, from: From): boolean {
    const message = validMessage(raw);
    if (!message) return false;
    const topic = parseTopic(message.topic)!;
    if (topic.kind === 'state') {
      const type = isItemTopic(topic.id, message.payload) ? 'item' : 'mover';
      if (!applyState(store, { id: message.topic, type }, message.payload)) return false;
      if (buffer.length < STREAM_MAX) buffer.push(message);
    }
    publish(STATE_TOPIC, { ...message, from }, false);
    if (topic.kind === 'state') scheduleTick();
    return true;
  }

  function clearStream(): void {
    buffer = [];
    publishStatus();
  }

  // ---- playing a record ----

  interface Run { messages: Message[]; next: number; start: number; speed: number; loop: boolean; source: string; duration: number; timer: unknown }
  let run: Run | null = null;

  function play(record: unknown, o: { loop?: boolean; speed?: number; source?: string } = {}): { count: number; duration: number } {
    stopRun();
    const { messages } = recordToMessages(isObject(record) ? record : {}, { site: scene.site });
    const speed = Number.isFinite(o.speed) && (o.speed as number) > 0 ? Math.min(10, Math.max(0.1, o.speed as number)) : 1;
    const duration = messages.length ? round3(messages[messages.length - 1].at / 1000) : 0;
    if (messages.length) {
      run = { messages, next: 0, start: clock.now(), speed, loop: o.loop === true, source: o.source ?? 'record', duration, timer: null };
      publishStatus();
      step();
    } else {
      publishStatus();
    }
    return { count: messages.length, duration };
  }

  /** Send every message that is due, then wait for the next one (or start again, or end). */
  function step(): void {
    const r = run;
    if (!r) return;
    r.timer = null;
    const due = (clock.now() - r.start) * r.speed;
    while (r.next < r.messages.length && r.messages[r.next].at <= due) {
      const m = r.messages[r.next++];
      push({ topic: m.topic, payload: { ...m.payload, at: r.start + Math.round(m.at / r.speed) } }, 'record');
    }
    if (r.next >= r.messages.length) {
      if (!r.loop) {
        run = null;
        publishStatus();
        return;
      }
      r.next = 0;
      r.start = clock.now();
      publishStatus();
      // a record whose every sample is at t = 0 waits a frame before it goes round again
      r.timer = clock.setTimeout(step, r.messages[r.messages.length - 1].at > 0 ? 0 : SNAPSHOT_MS);
      return;
    }
    const wait = Math.max(0, r.start + r.messages[r.next].at / r.speed - clock.now());
    r.timer = clock.setTimeout(step, Math.ceil(wait));
  }

  function stopRun(): boolean {
    if (!run) return false;
    if (run.timer !== null) clock.clearTimeout(run.timer);
    run = null;
    return true;
  }

  function stop(): void {
    if (stopRun()) publishStatus();
  }

  // ---- the opened record, status ----

  let opened: Opened | null = null;
  let openedFloor: string | null = null;
  let agentFrames = false;

  const cornersKey = (floor: Scene['floor']): string | null => (floor ? JSON.stringify(floor.corners) : null);

  function open(record: Json, source: Opened): Scene {
    stopRun();
    const { scene: from } = recordToMessages(record);
    const sameFloor = from.floor !== null && cornersKey(from.floor) === cornersKey(scene.floor);
    const next: Scene = {
      site: from.site,
      // A record with no floor stands on the floor the pane has; one with its own brings it, and a
      // camera fitted to another floor no longer fits
      siteFrameId: from.siteFrameId ?? (from.floor ? null : scene.siteFrameId),
      background: scene.background,
      camera: from.floor && !sameFloor ? null : scene.camera,
      floor: from.floor ?? scene.floor,
      devices: from.devices,
      names: from.names,
      ...(from.streamNames ? { streamNames: from.streamNames } : {}),
    };
    opened = source;
    openedFloor = cornersKey(from.floor);
    store.clear();
    buffer = [];
    const shown = replaceScene(next);
    tick();
    publishStatus();
    return shown;
  }

  function status(): Status {
    return {
      login: client.status(),
      unsent: pending(dirs.unsent).map(({ name, ref, mode }) => ({ name, ref, mode })),
      playing: run ? { source: run.source, t: round3(((clock.now() - run.start) * run.speed) / 1000), duration: run.duration } : null,
      agentFrames,
      recorded: buffer.length,
      opened: !opened ? null : 'ref' in opened ? { ref: opened.ref, version: opened.version, own: opened.own } : { file: opened.file },
    };
  }

  function publishStatus(): void {
    const now = status();
    recordedShown = now.recorded;
    publish(STATUS_TOPIC, now, true);
  }

  async function sendUnsent(): Promise<SendAllResult> {
    try {
      return await sendAll(dirs.unsent, sender);
    } finally {
      publishStatus();
    }
  }

  function close(): void {
    stopRun();
    if (tickTimer !== null) clock.clearTimeout(tickTimer);
    tickTimer = null;
  }

  // What a pane subscribing now is given at once
  publish(SCENE_TOPIC, scene, true);
  publish(SNAPSHOT_TOPIC, [], true);
  publishStatus();

  return {
    settings,
    userDir,
    dirs,
    client,
    sender,
    scene: () => plain(scene),
    setScene: (patch) => {
      const next: Json = { ...scene, ...patch };
      if ('streamNames' in patch && patch.streamNames === undefined) delete next.streamNames;
      return replaceScene(next);
    },
    push,
    play,
    stop,
    streamBuffer: () => plain(buffer),
    clearStream,
    status,
    publishStatus,
    open,
    openedRecord: () => opened,
    setOpened: (next) => { opened = next; publishStatus(); },
    floorIsKnown: () => openedFloor !== null && openedFloor === cornersKey(scene.floor),
    setAgentFrames: (on) => { agentFrames = on === true; publishStatus(); },
    sendUnsent,
    close,
  };
}
