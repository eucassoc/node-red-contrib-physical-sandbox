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
import type { Hub } from '../plugin/hub.js';
import { recordToMessages } from '../core/stream.js';
import { createPlayer, realClock, type Player } from '../core/player.js';
import { isRecordRef, Offline, Refused, SignIn } from '../core/pscom-client.js';

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

/** An error whose message is what the status shows. */
class Shown extends Error {}

export default function psPlayNode(RED: NodeAPI): void {
  const hubOf = (): Hub | undefined => (RED as any).plugins?.get?.('physical-sandbox')?.hub;
  /** A status text from the node's message catalog, in the runtime's language. */
  const T = (key: string, opts?: Record<string, unknown>): string => (RED as any)._(`ps-play.status.${key}`, opts);

  function PsPlay(this: Node, config: PsPlayDef): void {
    RED.nodes.createNode(this, config);
    const node = this;
    const source = config.source === 'record' ? 'record' : 'inline';
    const ref = typeof config.ref === 'string' ? config.ref.trim() : '';

    /** The PS.com record, once read (a `record` source). */
    let fetched: Json | null = null;
    /** The playback of the last start. */
    let player: Player | null = null;
    /** Every command makes the ones before it stale (a record still being read is then not played). */
    let generation = 0;
    let lastShown = -Infinity;

    const show = (fill: 'green' | 'grey' | 'blue' | 'yellow' | 'red', shape: 'dot' | 'ring', text: string) => node.status({ fill, shape, text });
    const count = (key: string, n: number) => T(key, { n, m: player?.count ?? 0 });

    function inlineRecord(): Json {
      const raw = config.record;
      if (isObject(raw)) return raw;
      if (typeof raw !== 'string' || raw.trim() === '') throw new Shown(T('noInline'));
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new Shown(T('badInline')); }
      if (!isObject(parsed)) throw new Shown(T('badInline'));
      return parsed;
    }

    async function fetchRecord(hub: Hub): Promise<Json> {
      try {
        const got = await hub.client.openRecord(ref);
        return got.record;
      } catch (e) {
        hub.refreshStatus?.(); // a token PS.com refused is forgotten
        // By name as well as by class: the plugin and this node are separate bundles, each with its own copy of the classes
        const refused = e instanceof Refused || (e as Error)?.name === 'Refused';
        if (e instanceof Offline || (e as Error)?.name === 'Offline') throw new Shown(T('offline'));
        if (e instanceof SignIn || (e as Error)?.name === 'SignIn') throw new Shown(T('signIn'));
        if (refused && (e as Refused).status === 404) {
          throw new Shown(T(hub.client.status().signedIn ? 'notFound' : 'notFoundSignedOut', { ref }));
        }
        // Said from the node's catalog in the runtime's language: never the plugin's Japanese sentence or PS.com's bare code
        if (refused && (e as Refused).code === 'not-a-record') throw new Shown(T('notARecord', { ref }));
        if (refused && (e as Refused).code === 'bad-name') throw new Shown(T('badRef'));
        if (refused) throw new Shown(T('refused'));
        throw e;
      }
    }

    /** Play `record` from the beginning, by the hub's clock. */
    function begin(hub: Hub, record: Json, speed: unknown, loop: boolean): void {
      const clock = hub.clock ?? realClock;
      const { messages } = recordToMessages(record, { site: hub.scene().site });
      player = createPlayer({
        messages,
        clock,
        speed,
        loop,
        onMessage: ({ topic, payload }, sent) => {
          hub.push({ topic, payload: structuredClone(payload) }, 'record');
          node.send({ topic, payload: structuredClone(payload) });
          if (sent < messages.length && clock.now() - lastShown >= STATUS_MS) {
            lastShown = clock.now();
            show('green', 'dot', count('playing', sent));
          }
        },
        onEnd: () => show('green', 'ring', count('ended', messages.length)),
      });
      if (!messages.length) {
        show('yellow', 'ring', T('empty'));
        return;
      }
      lastShown = -Infinity;
      player.start();
    }

    node.on('input', (msg: any, _send: unknown, done: (err?: Error) => void) => {
      const hub = hubOf();
      if (!hub) {
        show('red', 'ring', T('notLoaded'));
        done();
        return;
      }
      const command = commandOf(msg.payload);
      if (!command) {
        node.warn(T('badCommand'));
        done();
        return;
      }
      generation += 1;
      player?.stop();
      if (command.command === 'stop') {
        if (player?.count) show('grey', 'ring', count('stopped', player.sent()));
        done();
        return;
      }
      if (command.command === 'rewind') {
        if (player?.count) show('grey', 'ring', count('rewound', 0));
        done();
        return;
      }
      const speed = command.speed ?? config.speed;
      const loop = typeof command.loop === 'boolean' ? command.loop : config.loop === true;
      const failed = (e: unknown) => {
        show('red', 'ring', e instanceof Shown ? e.message : String((e as Error)?.message ?? e));
        done(e instanceof Error ? e : new Error(String(e)));
      };
      if (source === 'inline' || fetched) {
        try { begin(hub, fetched ?? inlineRecord(), speed, loop); } catch (e) { failed(e); return; }
        done();
        return;
      }
      if (!ref) { failed(new Shown(T('noRef'))); return; }
      if (!isRecordRef(ref)) { failed(new Shown(T('badRef'))); return; }
      const mine = generation;
      show('blue', 'ring', T('fetching'));
      fetchRecord(hub)
        .then((record) => {
          fetched = record;
          if (mine === generation) begin(hub, record, speed, loop);
          done();
        })
        .catch((e) => {
          if (mine === generation) failed(e);
          else done();
        });
    });

    node.on('close', () => {
      generation += 1;
      player?.stop();
    });
  }
  RED.nodes.registerType('ps play', PsPlay);
}
