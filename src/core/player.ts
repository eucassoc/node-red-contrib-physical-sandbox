/**
 * Playing state messages in time: what the hub's playback (the pane's) and the `ps play` node share.
 *
 * The messages are on the record's time (`at` from 0, in time order, as `recordToMessages` gives
 * them). Each one goes to `onMessage` when it is due, with `at` on the clock: the start plus its
 * time over the speed. At the end it stops (`onEnd`) or, looping, starts again from the beginning
 * (`onRound`). Only the clock's timers move it on, so a fake clock plays it in tests.
 */
import type { Message } from './stream.js';

/** A clock and its timers (tests give a fake one). */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.(); // a record being played never keeps Node-RED from stopping
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A record whose every sample is at t = 0 waits this long before it goes round again. */
const ROUND_WAIT_MS = 100;

/** A playing speed: 1 unless a positive number (or its text) is given, kept between 0.1 and 10. */
export function speedOf(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(10, Math.max(0.1, n)) : 1;
}

export interface PlayerOptions {
  messages: Message[];
  clock: Clock;
  speed?: unknown;
  loop?: boolean;
  /** One message as it is due, with `at` on the clock; `sent` counts the messages of this round so far. */
  onMessage(message: { topic: string; payload: Message['payload'] }, sent: number): void;
  /** The end was reached and it starts again (loop). */
  onRound?(): void;
  /** The end was reached and it stopped. */
  onEnd?(): void;
}

export interface Player {
  readonly count: number;
  /** The record time of the last message [s]. */
  readonly duration: number;
  /** Play from the beginning (also while playing). */
  start(): void;
  /** Stop where it is. */
  stop(): void;
  /** How many messages of this round have gone. */
  sent(): number;
  /** Where it is on the record's time [s, to the millisecond]. */
  t(): number;
}

export function createPlayer(o: PlayerOptions): Player {
  const { messages, clock } = o;
  const speed = speedOf(o.speed);
  const loop = o.loop === true;
  const last = messages.length ? messages[messages.length - 1].at : 0;
  let next = 0;
  let start = clock.now();
  let timer: unknown = null;
  let running = false;
  /** Each start and stop begins a new run: a step of an older one does nothing more. */
  let run = 0;

  function halt(): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  /** Send every message that is due, then wait for the next one (or start again, or end). */
  function step(): void {
    timer = null;
    const mine = run;
    const due = (clock.now() - start) * speed;
    while (run === mine && running && next < messages.length && messages[next].at <= due) {
      const m = messages[next++];
      o.onMessage({ topic: m.topic, payload: { ...m.payload, at: start + Math.round(m.at / speed) } }, next);
    }
    if (run !== mine || !running) return; // stopped, or started again, by onMessage
    if (next >= messages.length) {
      if (!loop) {
        running = false;
        o.onEnd?.();
        return;
      }
      next = 0;
      start = clock.now();
      o.onRound?.();
      timer = clock.setTimeout(step, last > 0 ? 0 : ROUND_WAIT_MS);
      return;
    }
    const wait = Math.max(0, start + messages[next].at / speed - clock.now());
    timer = clock.setTimeout(step, Math.ceil(wait));
  }

  return {
    count: messages.length,
    duration: Math.round(last) / 1000,
    start() {
      halt();
      run += 1;
      next = 0;
      start = clock.now();
      running = messages.length > 0;
      if (running) step();
    },
    stop() {
      halt();
      run += 1;
      running = false;
    },
    sent: () => next,
    t: () => Math.round((clock.now() - start) * speed) / 1000,
  };
}
