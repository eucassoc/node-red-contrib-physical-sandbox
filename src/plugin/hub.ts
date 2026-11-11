/**
 * The hub: what every pane and node of this Node-RED shares.
 *
 * - The scene (「場」: site, floor and camera, placed devices, names), kept in
 *   `<userDir>/physical-sandbox/scene.json` and restored at start.
 * - The stream: every message that comes in (`push`, from `ps in`, a record being played, or the
 *   agent's `playMessages`) is checked as PS.com's devices/state.js checks a broker's (rubbish until it proves
 *   otherwise, an older `at` never wins) and sent to every pane. A message for another site than
 *   the scene's moves nothing, as in the pane: it is not sent, counted, kept or saved. The stream buffer, what a save
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
import { pending, sendAll, unsentDirIn, type SendAllResult, type Sender, type SentCopy } from '../core/unsent.js';
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
  /** The plugin's site (its settings): 「現地をもとに戻す」 goes back to it. */
  defaultSite: string;
  /** The stream keeps no more (STREAM_MAX): later states move the panes but are not recorded. */
  full: boolean;
}

/**
 * The agent's messages, sorted out: those the hub takes, those that are wrong (by index, with the
 * reason), those for another site (by index), and the outside names of states that no device of
 * the scene answers to (taken, but they move nothing a record keeps).
 */
export interface SortedMessages {
  messages: Message[];
  invalid: { index: number; reason: string }[];
  otherSite: { index: number; site: string }[];
  unknownNames: string[];
}

/** What playMessages played: how many and how long [s], and what it left out or could not place. */
export interface AgentPlay {
  count: number;
  duration: number;
  invalid: { index: number; reason: string }[];
  otherSite: { index: number; site: string }[];
  unknownNames: string[];
}

export interface HubOptions {
  userDir: string;
  settings: PluginSettings;
  clock?: Clock;
  /** For PS.com and the catalog (tests give a fake one). */
  fetchImpl?: FetchLike;
  /** Between two login polls (3 s; tests use 0). */
  pollMs?: number;
  /** How many states the stream keeps (STREAM_MAX; tests use a few). */
  streamMax?: number;
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
   * Take another site's messages from now on (the plugin's site when none is given). The stream is
   * emptied: what it holds is of the other site, which this scene no longer takes. The opened
   * record stays open.
   */
  setSite(site?: string): Scene;
  /**
   * One message into the stream; false (and nothing else happens) when it is not one, is older, or
   * is for another site than the scene's.
   * A `retained` one (the broker's last message, given again on subscribing) moves the panes and
   * the latest states but is not kept in the buffer: it is not something that happened now, and
   * it must not take the place of an opened record's trace.
   */
  push(message: unknown, from: From, opts?: { retained?: boolean }): boolean;
  /** Play a record's state messages to the panes in time (not into the buffer); a play under way stops first. */
  play(record: unknown, opts?: { loop?: boolean; speed?: number; source?: string }): { count: number; duration: number };
  /**
   * The agent's messages, checked one by one as `push` checks them (a state must also move
   * something): what is wrong is answered by index with the reason, another site's are left out,
   * and the rest are played to the panes in time from now, `from: 'agent'`, their `at` taken from
   * the first (smallest) one. A play under way stops first, unless nothing here can be played.
   * The states are kept in the buffer as agent states once (a loop does not keep them again each
   * round), at the times the agent wrote (from the start of the play, whatever the speed). Each
   * play takes the place of the agent's states kept before (the live states and the opened
   * record's stay; a record trace the last attempt had replaced comes back), unless `append`.
   */
  playMessages(messages: unknown[], opts?: { loop?: boolean; speed?: number; append?: boolean }): AgentPlay;
  /** The agent's messages sorted out as playMessages sorts them, without playing them. */
  sortMessages(messages: unknown[]): SortedMessages;
  stop(): void;
  /** What a save writes: the opened record's states (on its time), then the live and agent ones. */
  streamBuffer(): Message[];
  /**
   * The live and agent states only (what came in since the opened record was opened): over an
   * opened record these are all a save changes, so every other trace stays exactly as the record has it.
   */
  liveBuffer(): Message[];
  /**
   * The states the stream had at each of `times` (seconds from its first state, by `at`): for each
   * time, the latest state of every topic, built up as a pane builds it (a mover's joints and place
   * add up), as the snapshot gives them; and how long the stream is [s]. Null when it is empty.
   */
  statesAt(times: number[]): { states: Message[][]; duration: number } | null;
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
  /**
   * Kept copies that reached PS.com: one saved over the opened record makes its version the
   * opened one (and the latest), so the next 上書き保存 goes on from it instead of being moved.
   */
  noteSent(sent: SentCopy[] | undefined): void;
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
 * One message as the hub takes it, or why not (in English, for the agent): `ps/<site>/<id>/<kind>`
 * with site and id topic names, and a payload (an object, or JSON text) with a finite `at`. The
 * payload is copied as plain JSON.
 */
export function checkMessage(raw: unknown): { message: Message } | { problem: string } {
  if (!isObject(raw) || typeof raw.topic !== 'string') return { problem: 'not an object with a topic (a string)' };
  const topic = parseTopic(raw.topic);
  if (!topic || !isTopicName(topic.site) || !isTopicName(topic.id)) {
    return { problem: 'the topic is not ps/<site>/<id>/<kind> (kind state, command or event; site and id without / + #)' };
  }
  let payload: unknown = raw.payload;
  if (typeof payload === 'string') payload = decode(payload);
  else if (Buffer.isBuffer(payload)) payload = decode(payload.toString('utf8'));
  if (!isObject(payload)) return { problem: 'the payload is not an object (or the JSON text of one)' };
  if (!Number.isFinite(payload.at)) return { problem: 'payload.at is not a finite number (milliseconds)' };
  try {
    payload = plain(payload);
  } catch {
    return { problem: 'the payload is not plain JSON' }; // a BigInt, a cycle
  }
  return { message: { topic: raw.topic, payload: payload as Message['payload'], at: (payload as Json).at } };
}

/** One message as the hub takes it, or null (see checkMessage). */
export function validMessage(raw: unknown): Message | null {
  const checked = checkMessage(raw);
  return 'message' in checked ? checked.message : null;
}

export function createHub(RED: any, opts: HubOptions): Hub {
  const { userDir, settings } = opts;
  const clock = opts.clock ?? realClock;
  const streamMax = opts.streamMax ?? STREAM_MAX;
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
  /** All the opened record's states as it was opened, the agent's kept states, and the devices whose loaded states an agent state dropped. */
  let loadedAll: Message[] = [];
  let agentKept = new WeakSet<Message>();
  let droppedByAgent = new Set<string>();
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

  function snapshot(of: Map<string, Json> = store): Message[] {
    return [...of.entries()].map(([topic, held]: [string, Json]) => {
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
   * leaves the hub. `keep: false`: a state that moves the panes but is kept already (an agent loop's
   * later rounds); `keepAt`: kept at this time instead of the one it was played at (the agent's own).
   */
  function accept(raw: unknown, from: From, opts: { retained?: boolean; keep?: boolean; keepAt?: number }, fromOutside: boolean): boolean {
    const message = validMessage(raw);
    if (!message) return false;
    const topic = parseTopic(message.topic)!;
    if (topic.site !== scene.site) return false;
    if (topic.kind === 'state') {
      if (from === 'record' && fromOutside) notePlayed(message);
      const echo = from === 'mqtt' && isEcho(message);
      const type = isItemTopic(topic.id, message.payload) ? 'item' : 'mover';
      if (!applyState(store, { id: message.topic, type }, message.payload)) return false;
      if (from !== 'record' && opts.retained !== true && opts.keep !== false && !echo) {
        const at = opts.keepAt;
        keep(at === undefined ? message : { ...message, payload: { ...message.payload, at }, at }, from);
      }
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
  function keep(message: Message, from: From): void {
    if (loadedKeys.size) {
      const key = deviceKey(message.topic);
      if (loadedKeys.delete(key)) {
        loaded = loaded.filter((m) => deviceKey(m.topic) !== key);
        if (from === 'agent') droppedByAgent.add(key);
      }
    }
    if (live.length < streamMax) {
      live.push(message);
      if (from === 'agent') agentKept.add(message);
    }
  }

  /**
   * The agent's kept states out of the buffer (before its next attempt): a device whose loaded
   * states an agent state dropped, and that nothing live moves now, gets them back.
   */
  function dropAgentStates(): void {
    live = live.filter((m) => !agentKept.has(m));
    if (!droppedByAgent.size) return;
    const moved = new Set(live.map((m) => deviceKey(m.topic)));
    for (const key of droppedByAgent) {
      if (moved.has(key)) continue;
      loadedKeys.add(key);
      droppedByAgent.delete(key);
    }
    loaded = loadedAll.filter((m) => loadedKeys.has(deviceKey(m.topic)));
  }

  function statesAt(times: number[]): { states: Message[][]; duration: number } | null {
    // A stable sort: states of the same `at` stay in the order they came
    const all = [...loaded, ...live].filter((m) => parseTopic(m.topic)?.kind === 'state').sort((a, b) => a.at - b.at);
    if (!all.length) return null;
    const first = all[0].at;
    const states: Message[][] = new Array(times.length);
    const at = newStore();
    let next = 0;
    for (const { t, i } of times.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t)) {
      const until = first + t * 1000;
      for (; next < all.length && all[next].at <= until; next += 1) {
        const m = all[next];
        applyState(at, { id: m.topic, type: isItemTopic(parseTopic(m.topic)!.id, m.payload) ? 'item' : 'mover' }, m.payload);
      }
      states[i] = snapshot(at);
    }
    return { states, duration: (all[all.length - 1].at - first) / 1000 };
  }

  /** An empty buffer and no latest states (an empty snapshot goes to the panes). */
  function emptyStream(): void {
    loaded = [];
    loadedAll = [];
    live = [];
    loadedKeys = new Set();
    agentKept = new WeakSet();
    droppedByAgent = new Set();
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

  // ---- playing the agent's messages ----

  /** A state that moves nothing (a mover with neither joints nor a position, an item with no parent or xyz). */
  function stateProblem(message: Message): string | null {
    const topic = parseTopic(message.topic)!;
    if (topic.kind !== 'state') return null;
    const type = isItemTopic(topic.id, message.payload) ? 'item' : 'mover';
    if (applyState(newStore(), { id: message.topic, type }, message.payload)) return null;
    return type === 'item'
      ? 'an item\'s state needs parent (a string) and xyz ([x, y, z])'
      : 'a state needs joints ({name: number}) or position ([x, y, z]), with yaw a number if given';
  }

  function sortMessages(raw: unknown[]): SortedMessages {
    const sorted: SortedMessages = { messages: [], invalid: [], otherSite: [], unknownNames: [] };
    (Array.isArray(raw) ? raw : []).forEach((one, index) => {
      const checked = checkMessage(one);
      if ('problem' in checked) { sorted.invalid.push({ index, reason: checked.problem }); return; }
      const { site, id, kind } = parseTopic(checked.message.topic)!;
      if (site !== scene.site) { sorted.otherSite.push({ index, site }); return; }
      const problem = stateProblem(checked.message);
      if (problem) { sorted.invalid.push({ index, reason: problem }); return; }
      const deviceId = deviceIdOf(id);
      const known = deviceId !== undefined && scene.devices.some((d) => d.id === deviceId);
      if (kind === 'state' && !known && !sorted.unknownNames.includes(id)) sorted.unknownNames.push(id);
      sorted.messages.push(checked.message);
    });
    return sorted;
  }

  function playMessages(raw: unknown[], o: { loop?: boolean; speed?: number; append?: boolean } = {}): AgentPlay {
    const { messages: taken, invalid, otherSite, unknownNames } = sortMessages(raw);
    if (!taken.length) return { count: 0, duration: 0, invalid, otherSite, unknownNames };
    // On the stream's own time from 0, in time order (stable: the agent's order at the same time)
    taken.sort((a, b) => a.at - b.at);
    const first = taken[0].at;
    const messages = taken.map((m) => ({ topic: m.topic, payload: { ...m.payload, at: m.at - first }, at: m.at - first }));
    stopRun();
    if (o.append !== true) dropAgentStates();
    let round = 0;
    // Kept at the times the agent wrote from the start of the play, not at the ones a speed made
    const start = clock.now();
    const player = createPlayer({
      messages,
      clock,
      speed: o.speed,
      loop: o.loop === true,
      onMessage: (m, sent) => { accept(m, 'agent', { keep: round === 0, keepAt: start + messages[sent - 1].at }, false); },
      onRound: () => { round += 1; publishStatus(); },
      onEnd: () => {
        if (run?.player !== player) return;
        run = null;
        publishStatus();
      },
    });
    run = { player, source: 'agent' };
    publishStatus();
    player.start();
    return { count: player.count, duration: player.duration, invalid, otherSite, unknownNames };
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
    loadedAll = loaded;
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
      defaultSite: settings.site,
      full: live.length >= streamMax,
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

  function noteSent(sent: SentCopy[] | undefined): void {
    if (!opened || !('ref' in opened)) return;
    const ref = opened.ref;
    const last = (sent ?? []).filter((c) => c.mode === 'over' && c.ref === ref).at(-1);
    if (!last) return;
    opened = { ...opened, version: last.version, latest: last.version };
    publishStatus();
  }

  async function sendUnsent(): Promise<SendAllResult> {
    while (gate) await gate;
    return throughGate(async () => {
      try {
        const result = await sendAll(dirs.unsent, sender);
        noteSent(result.sent);
        return result;
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
    setSite: (site) => {
      const next = site ?? settings.site;
      if (next === scene.site) return plain(scene);
      stopRun();
      emptyStream();
      const shown = replaceScene({ ...scene, site: next });
      tick();
      publishStatus();
      return shown;
    },
    push,
    play,
    playMessages,
    sortMessages,
    stop,
    streamBuffer: () => plain([...loaded, ...live]),
    liveBuffer: () => plain(live),
    statesAt,
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
    noteSent,
    close,
  };
}
