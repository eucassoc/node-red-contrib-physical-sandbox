/**
 * The "ps play" node: plays a record out as messages.
 *
 * The record is the node's own (`inline`: its JSON in the node's settings) or a PS.com record
 * (`record`: `handle/name[:version]`, read through the plugin's client at the first start after a
 * deploy and kept until the next one). Its state messages go out in time, by the hub's clock: each
 * one on the node's output as `{topic, payload}` (for `mqtt out`) and to the hub as `record` (the
 * pane shows it; the stream buffer does not keep it). The node keeps its own playback, apart from
 * the pane's.
 *
 * Commands (`msg.payload`): `start` plays from the beginning (also while playing), `stop` stops
 * where it is, `rewind` stops and goes back to the beginning without sending anything; or
 * `{command, speed?, loop?}`, whose speed and loop win over the node's settings.
 */
import type { Node, NodeAPI, NodeDef } from 'node-red';
import { SNAPSHOT_MS, realClock, type Clock, type Hub } from '../plugin/hub.js';
import { recordToMessages, type Message } from '../core/stream.js';
import { Offline, Refused, SignIn } from '../core/pscom-client.js';

type Json = Record<string, any>;

interface PsPlayDef extends NodeDef {
  source?: 'inline' | 'record';
  /** The inline record: JSON text from the editor, or an object put there by the agent. */
  record?: unknown;
  ref?: string;
  loop?: boolean;
  speed?: number | string;
}

type Command = { command: 'start' | 'stop' | 'rewind'; speed?: unknown; loop?: unknown };

const WORDS = {
  notLoaded: 'プラグインが読み込まれていません',
  badCommand: 'msg.payload には start・stop・rewind のどれかを指定してください (send start, stop or rewind)',
  noInline: '記録の JSON を入れてください',
  badInline: '記録の JSON を読み込めませんでした',
  noRef: '記録の名前（handle/name）を指定してください',
  badRef: '記録の名前は handle/name か handle/name:バージョン で指定してください',
  fetching: '記録を取得中',
  offline: 'PS.com に接続できませんでした',
  signIn: 'PS.com にログインしてください',
  notFound: '記録が見つかりませんでした（{ref}）',
  notFoundSignedOut: '記録が見つかりませんでした（{ref}）。非公開の記録は、Physical Sandbox の画面で PS.com にログインしてから再生してください',
  empty: '記録に再生できる動きがありません',
  playing: '再生中 {n}/{m}',
  ended: '再生終了 {n}/{m}',
  stopped: '停止 {n}/{m}',
  rewound: '先頭 {n}/{m}',
};

/** The status shows the count at most this often while playing. */
const STATUS_MS = 250;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const COMMANDS = new Set(['start', 'stop', 'rewind']);

function commandOf(payload: unknown): Command | null {
  if (typeof payload === 'string' && COMMANDS.has(payload)) return { command: payload as Command['command'] };
  if (isObject(payload) && typeof payload.command === 'string' && COMMANDS.has(payload.command)) {
    return { command: payload.command as Command['command'], speed: payload.speed, loop: payload.loop };
  }
  return null;
}

/** As the hub plays: 1 unless given, between 0.1 and 10. */
function speedOf(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(10, Math.max(0.1, n)) : 1;
}

/** An error whose message is what the status shows. */
class Shown extends Error {}

export default function psPlayNode(RED: NodeAPI): void {
  const hubOf = (): Hub | undefined => (RED as any).plugins?.get?.('physical-sandbox')?.hub;

  function PsPlay(this: Node, config: PsPlayDef): void {
    RED.nodes.createNode(this, config);
    const node = this;
    const source = config.source === 'record' ? 'record' : 'inline';
    const ref = typeof config.ref === 'string' ? config.ref.trim() : '';

    /** The PS.com record, once read (a `record` source). */
    let fetched: Json | null = null;
    /** The messages of the last start, on the record's time (`at` from 0). */
    let messages: Message[] = [];
    let next = 0;
    let start = 0;
    let speed = 1;
    let loop = false;
    let timer: unknown = null;
    let clock: Clock = realClock;
    /** Every command makes the ones before it stale (a record still being read is then not played). */
    let generation = 0;
    let lastShown = -Infinity;

    const show = (fill: 'green' | 'grey' | 'blue' | 'yellow' | 'red', shape: 'dot' | 'ring', text: string) => node.status({ fill, shape, text });
    const count = (word: string, n: number) => word.replace('{n}', String(n)).replace('{m}', String(messages.length));

    function halt(): void {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    }

    function inlineRecord(): Json {
      const raw = config.record;
      if (isObject(raw)) return raw;
      if (typeof raw !== 'string' || raw.trim() === '') throw new Shown(WORDS.noInline);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new Shown(WORDS.badInline); }
      if (!isObject(parsed)) throw new Shown(WORDS.badInline);
      return parsed;
    }

    async function fetchRecord(hub: Hub): Promise<Json> {
      if (!ref) throw new Shown(WORDS.noRef);
      try {
        const got = await hub.client.openRecord(ref);
        return got.record;
      } catch (e) {
        hub.refreshStatus?.(); // a token PS.com refused is forgotten
        if (e instanceof Offline) throw new Shown(WORDS.offline);
        if (e instanceof SignIn) throw new Shown(WORDS.signIn);
        if (e instanceof Refused && e.status === 404) {
          throw new Shown((hub.client.status().signedIn ? WORDS.notFound : WORDS.notFoundSignedOut).replace('{ref}', ref));
        }
        if (e instanceof TypeError || (e instanceof Refused && e.code === 'bad-name')) throw new Shown(WORDS.badRef);
        if (e instanceof Refused && e.message && e.message !== e.code) throw new Shown(e.message);
        throw e;
      }
    }

    function begin(hub: Hub, record: Json): void {
      messages = recordToMessages(record, { site: hub.scene().site }).messages;
      clock = hub.clock ?? realClock;
      if (!messages.length) {
        show('yellow', 'ring', WORDS.empty);
        return;
      }
      next = 0;
      start = clock.now();
      lastShown = -Infinity;
      step(hub);
    }

    /** Send every message that is due, then wait for the next one (or go round again, or end). */
    function step(hub: Hub): void {
      timer = null;
      const due = (clock.now() - start) * speed;
      while (next < messages.length && messages[next].at <= due) {
        const m = messages[next++];
        const payload = { ...structuredClone(m.payload), at: start + Math.round(m.at / speed) };
        hub.push({ topic: m.topic, payload: structuredClone(payload) }, 'record');
        node.send({ topic: m.topic, payload });
      }
      if (next >= messages.length) {
        if (!loop) {
          show('green', 'ring', count(WORDS.ended, next));
          return;
        }
        next = 0;
        start = clock.now();
        // a record whose every sample is at t = 0 waits a frame before it goes round again
        timer = clock.setTimeout(() => step(hub), messages[messages.length - 1].at > 0 ? 0 : SNAPSHOT_MS);
        return;
      }
      if (clock.now() - lastShown >= STATUS_MS) {
        lastShown = clock.now();
        show('green', 'dot', count(WORDS.playing, next));
      }
      const wait = Math.max(0, start + messages[next].at / speed - clock.now());
      timer = clock.setTimeout(() => step(hub), Math.ceil(wait));
    }

    node.on('input', (msg: any, _send: unknown, done: (err?: Error) => void) => {
      const hub = hubOf();
      if (!hub) {
        show('red', 'ring', WORDS.notLoaded);
        done();
        return;
      }
      const command = commandOf(msg.payload);
      if (!command) {
        node.warn(WORDS.badCommand);
        done();
        return;
      }
      generation += 1;
      halt();
      if (command.command === 'stop') {
        if (messages.length) show('grey', 'ring', count(WORDS.stopped, next));
        done();
        return;
      }
      if (command.command === 'rewind') {
        next = 0;
        if (messages.length) show('grey', 'ring', count(WORDS.rewound, 0));
        done();
        return;
      }
      speed = speedOf(command.speed ?? config.speed);
      loop = typeof command.loop === 'boolean' ? command.loop : config.loop === true;
      const failed = (e: unknown) => {
        show('red', 'ring', e instanceof Shown ? e.message : String((e as Error)?.message ?? e));
        done(e instanceof Error ? e : new Error(String(e)));
      };
      if (source === 'inline' || fetched) {
        let record: Json;
        try { record = fetched ?? inlineRecord(); } catch (e) { failed(e); return; }
        begin(hub, record);
        done();
        return;
      }
      const mine = generation;
      show('blue', 'ring', WORDS.fetching);
      fetchRecord(hub).then((record) => {
        fetched = record;
        if (mine === generation) begin(hub, record);
        done();
      }, (e) => {
        if (mine === generation) failed(e);
        else done();
      });
    });

    node.on('close', () => {
      generation += 1;
      halt();
    });
  }
  RED.nodes.registerType('ps play', PsPlay);
}
