/**
 * The hub: what every pane and node of this Node-RED shares.
 *
 * - The scene (「場」: site, floor and camera, placed devices, names), kept in
 *   `<userDir>/physical-sandbox/scene.json` and restored at start.
 * - The stream: every message that comes in (`push`, from `ps in`, a record being played or, later,
 *   the agent) is checked as PS.com's devices/state.js checks a broker's (rubbish until it proves
 *   otherwise, an older `at` never wins) and sent to every pane. The stream buffer, what a save
 *   turns into a record, is the opened record's states on the record's own time (loaded when it is
 *   opened) and the live (`mqtt`) and `agent` states on their own `at`; a live state for a device
 *   takes the place of that device's loaded states. What a play sends (`record`) is never kept: the
 *   record is in the buffer already, so half a play, a faster one or a loop leave it as it was.
 *   Nor is its echo: a live state with the topic and `at` of a state `ps play` played in the last
 *   30 s (`ps play` → `mqtt out` → broker → `mqtt in` → `ps in`) moves the panes but is not kept.
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
import { createPlayer, realClock, type Clock, type Player } from '../core/player.js';
import type { PluginSettings } from './settings.js';

type Json = Record<string, any>;
type FetchLike = (url: string, init?: any) => Promise<any>;

export type From = 'mqtt' | 'record' | 'agent';

export { realClock, type Clock };

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
  /** The clock the hub plays by; `ps play` plays by it too. */
  readonly clock: Clock;
  scene(): Scene;
  /** Change some of the scene's fields; kept on disk and sent to the panes. */
  setScene(patch: Partial<Scene>): Scene;
  /**
   * One message into the stream; false (and nothing else happens) when it is not one or is older.
   * A `retained` one (the broker's last message, given again on subscribing) moves the panes and
   * the latest states but is not kept in the buffer: it is not something that happened now, and
   * it must not take the place of an opened record's trace.
   */
  push(message: unknown, from: From, opts?: { retained?: boolean }): boolean;
  /** Play a record's state messages to the panes in time (not into the buffer); a play under way stops first. */
  play(record: unknown, opts?: { loop?: boolean; speed?: number; source?: string }): { count: number; duration: number };
  stop(): void;
  /** What a save writes: the opened record's states (on its time), then the live and agent ones. */
  streamBuffer(): Message[];
  /**
   * The live and agent states only (what came in since the opened record was opened): over an
   * opened record these are all a save changes, so every other trace stays exactly as the record has it.
   */
  liveBuffer(): Message[];
  /** Empty the stream buffer and forget the latest states (an empty snapshot goes to the panes). */
  clearStream(): void;
  status(): Status;
  /** Send the status as it is held (the unsent list and the login as last read). */
  publishStatus(): void;
  /** Read the unsent list and the login again (after a save, a send, a login), then send the status. */
  refreshStatus(): void;
  /** Run one save at a time: while a save or a send of kept copies is under way it is refused with `Busy`. */
  exclusiveSave<T>(fn: () => Promise<T>): Promise<T>;
  /** Open a record: its scene (keeping the background), its states as the stream, and it is the opened record. */
  open(record: Json, opened: Opened): Scene;
  openedRecord(): Opened | null;
  /** The opened record after a save (the scene and the stream stay as they are). */
  setOpened(opened: Opened | null): void;
  /** Whether the scene's floor is the opened record's: the corners must then be clicked in its order. */
  floorIsKnown(): boolean;
  setAgentFrames(on: boolean): void;
  /** Send the kept copies (at start, after a login, on 再送信する), after any save under way (one at a time with saves). */
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
/** A played state's echo is known by its topic and `at` for this long, and for at most this many states. */
export const ECHO_MS = 30_000;
export const ECHO_MAX = 50_000;

/** A save asked for while another is under way. */
export class Busy extends Error {
  constructor() { super('a save is under way'); }
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPoint = (c: unknown): boolean => isObject(c) && ['x', 'y', 'z'].every((k) => Number.isFinite(c[k]));
const nameTable = (v: unknown): Record<string, string> =>
  isObject(v) ? Object.fromEntries(Object.entries(v).filter(([k, id]) => isTopicName(k) && typeof id === 'string')) : {};
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** A name of a file right in its folder: no path separator, no `..`, no NUL. */
const isFileName = (v: unknown): v is string => typeof v === 'string' && v !== '' && !/[\\/\0]/.test(v) && !v.includes('..');

/** A scene from anything (scene.json, a patch): what is not right is left out or set to its empty value. */
export function normalizeScene(raw: unknown, site: string): Scene {
  const s: Json = isObject(raw) ? raw : {};
  const bg = s.background;
  const floor = s.floor;
  const streamNames = nameTable(s.streamNames);
  return {
    site: isTopicName(s.site) ? s.site : site,
    siteFrameId: typeof s.siteFrameId === 'string' && s.siteFrameId ? s.siteFrameId : null,
    background: isObject(bg) && (bg.kind === 'still' || bg.kind === 'video') && isFileName(bg.name)
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
  /** The opened record's states, on the record's time; and the live and agent ones, on their own. */
  let loaded: Message[] = [];
  let live: Message[] = [];
  /** The devices (by deviceKey) that `loaded` has states of. */
  let loadedKeys = new Set<string>();
  const recordedCount = () => loaded.length + live.length;
  let tickTimer: unknown = null;
  let lastTick = -Infinity;
  let recordedShown = 0;

  /** Whether a state for this topic is an item's (the device the name stands for, else what the message says). */
  function deviceIdOf(id: string): string | undefined {
    return (Object.hasOwn(scene.names, id) ? scene.names[id] : undefined)
      ?? (scene.streamNames && Object.hasOwn(scene.streamNames, id) ? scene.streamNames[id] : undefined);
  }

  function isItemTopic(id: string, payload: Json): boolean {
    const deviceId = deviceIdOf(id);
    const device = deviceId === undefined ? undefined : scene.devices.find((d) => d.id === deviceId);
    return device ? device.type === 'item' : payload.type === 'item';
  }

  /** Which device a state message is of: the device its outside name stands for, else the topic itself. */
  function deviceKey(topic: string): string {
    const parsed = parseTopic(topic);
    const id = parsed ? deviceIdOf(parsed.id) : undefined;
    return id !== undefined ? `device:${id}` : `topic:${topic}`;
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
    if (recordedShown !== recordedCount()) publishStatus();
  }

  /** The snapshot at once when the last one is 100 ms old, else once when it is. */
  function scheduleTick(): void {
    if (tickTimer !== null) return;
    const wait = lastTick + SNAPSHOT_MS - clock.now();
    if (wait <= 0) { tick(); return; }
    tickTimer = clock.setTimeout(() => { tickTimer = null; tick(); }, wait);
  }

  /** A message from outside (`ps in`, `ps play`, the agent). */
  function push(raw: unknown, from: From, opts: { retained?: boolean } = {}): boolean {
    return accept(raw, from, opts, true);
  }

  /**
   * One message into the stream. `fromOutside`: a played state is noted for its echo only when it
   * came from outside (`ps play`, whose output may go to a broker); the pane's own playback never
   * leaves the hub.
   */
  function accept(raw: unknown, from: From, opts: { retained?: boolean }, fromOutside: boolean): boolean {
    const message = validMessage(raw);
    if (!message) return false;
    const topic = parseTopic(message.topic)!;
    if (topic.kind === 'state') {
      if (from === 'record' && fromOutside) notePlayed(message);
      const echo = from === 'mqtt' && isEcho(message);
      const type = isItemTopic(topic.id, message.payload) ? 'item' : 'mover';
      if (!applyState(store, { id: message.topic, type }, message.payload)) return false;
      if (from !== 'record' && opts.retained !== true && !echo) keep(message);
    }
    publish(STATE_TOPIC, { ...message, from }, false);
    if (topic.kind === 'state') scheduleTick();
    return true;
  }

  /** The states played lately (`topic` and `at`) and until when an echo of each is known, oldest first. */
  const played = new Map<string, number>();
  const playedKey = (m: Message) => `${m.topic}\n${m.at}`;

  function notePlayed(m: Message): void {
    const now = clock.now();
    for (const [key, until] of played) {
      if (until > now) break;
      played.delete(key);
    }
    const key = playedKey(m);
    played.delete(key);
    played.set(key, now + ECHO_MS);
    if (played.size > ECHO_MAX) played.delete(played.keys().next().value!);
  }

  function isEcho(m: Message): boolean {
    const until = played.get(playedKey(m));
    return until !== undefined && until > clock.now();
  }

  /** A live or agent state into the buffer: the first one of a device drops that device's loaded states. */
  function keep(message: Message): void {
    if (loadedKeys.size) {
      const key = deviceKey(message.topic);
      if (loadedKeys.delete(key)) loaded = loaded.filter((m) => deviceKey(m.topic) !== key);
    }
    if (live.length < STREAM_MAX) live.push(message);
  }

  /** An empty buffer and no latest states (an empty snapshot goes to the panes). */
  function emptyStream(): void {
    loaded = [];
    live = [];
    loadedKeys = new Set();
    store.clear();
  }

  function clearStream(): void {
    emptyStream();
    tick();
    publishStatus();
  }

  // ---- playing a record ----

  let run: { player: Player; source: string } | null = null;

  function play(record: unknown, o: { loop?: boolean; speed?: number; source?: string } = {}): { count: number; duration: number } {
    stopRun();
    const { messages } = recordToMessages(isObject(record) ? record : {}, { site: scene.site });
    const player = createPlayer({
      messages,
      clock,
      speed: o.speed,
      loop: o.loop === true,
      onMessage: (m) => { accept(m, 'record', {}, false); },
      onRound: publishStatus,
      onEnd: () => {
        if (run?.player !== player) return;
        run = null;
        publishStatus();
      },
    });
    if (messages.length) run = { player, source: o.source ?? 'record' };
    publishStatus();
    player.start();
    return { count: player.count, duration: player.duration };
  }

  function stopRun(): boolean {
    if (!run) return false;
    run.player.stop();
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

  /**
   * A floor's corners to the millimetre: a record keeps them so (floor-frame.js floorFromWorld), the
   * floor the pane decided has them as solved, and both are the same floor.
   */
  const mm = (v: number) => Math.round(v * 1000) / 1000 + 0;
  const cornersKey = (floor: Scene['floor']): string | null =>
    (floor ? JSON.stringify(floor.corners.map(({ x, y, z }) => [mm(x), mm(y), mm(z)])) : null);

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
    emptyStream();
    const shown = replaceScene(next);
    // The record's states, on its own time, are the stream now: a save over it changes nothing
    // until something live comes in
    loaded = recordToMessages(record, { site: scene.site }).messages;
    loadedKeys = new Set(loaded.map((m) => deviceKey(m.topic)));
    tick();
    publishStatus();
    return shown;
  }

  function status(): Status {
    return {
      login: loginHeld,
      unsent: unsentHeld,
      playing: run ? { source: run.source, t: run.player.t(), duration: run.player.duration } : null,
      agentFrames,
      recorded: recordedCount(),
      opened: !opened ? null : 'ref' in opened ? { ref: opened.ref, version: opened.version, own: opened.own } : { file: opened.file },
    };
  }

  function publishStatus(): void {
    const now = status();
    recordedShown = now.recorded;
    publish(STATUS_TOPIC, now, true);
  }

  // What the status shows of the files (the unsent copies, the kept login), read again only by
  // refreshStatus: the status goes out many times a second while a stream runs
  let unsentHeld: Status['unsent'] = [];
  let loginHeld: LoginStatus = { signedIn: false, handle: null };
  function readHeld(): void {
    unsentHeld = pending(dirs.unsent).map(({ name, ref, mode }) => ({ name, ref, mode }));
    loginHeld = client.status();
  }

  function refreshStatus(): void {
    readHeld();
    publishStatus();
  }

  // One save or one send of kept copies at a time: a kept copy over a record must not race a
  // 上書き保存 of the same record. A save finding the gate taken is refused; a send waits.
  let gate: Promise<void> | null = null;
  async function throughGate<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    gate = new Promise<void>((done) => { release = done; });
    try {
      return await fn();
    } finally {
      gate = null;
      release();
    }
  }

  async function exclusiveSave<T>(fn: () => Promise<T>): Promise<T> {
    if (gate) throw new Busy();
    return throughGate(fn);
  }

  async function sendUnsent(): Promise<SendAllResult> {
    while (gate) await gate;
    return throughGate(async () => {
      try {
        return await sendAll(dirs.unsent, sender);
      } finally {
        refreshStatus();
      }
    });
  }

  function close(): void {
    stopRun();
    if (tickTimer !== null) clock.clearTimeout(tickTimer);
    tickTimer = null;
  }

  // What a pane subscribing now is given at once
  readHeld();
  publish(SCENE_TOPIC, scene, true);
  publish(SNAPSHOT_TOPIC, [], true);
  publishStatus();

  return {
    settings,
    userDir,
    dirs,
    client,
    sender,
    clock,
    scene: () => plain(scene),
    setScene: (patch) => {
      const next: Json = { ...scene, ...patch };
      if ('streamNames' in patch && patch.streamNames === undefined) delete next.streamNames;
      return replaceScene(next);
    },
    push,
    play,
    stop,
    streamBuffer: () => plain([...loaded, ...live]),
    liveBuffer: () => plain(live),
    clearStream,
    status,
    publishStatus,
    refreshStatus,
    exclusiveSave,
    open,
    openedRecord: () => opened,
    setOpened: (next) => { opened = next; publishStatus(); },
    floorIsKnown: () => openedFloor !== null && openedFloor === cornersKey(scene.floor),
    setAgentFrames: (on) => { agentFrames = on === true; publishStatus(); },
    sendUnsent,
    close,
  };
}
