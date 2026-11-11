/**
 * How the plugin asks an open editor or pane for what only a browser has: the flows with their
 * undeployed edits (`flows`), importing a proposal into the workspace (`propose`), the pane's
 * picture (`frames`), and who is open at all (`ping`).
 *
 * A request goes out on comms as `ps-editor/request {id, op, args}` (not retained: an editor
 * opened later must not act on it). Every editor (the plugin's editor.html) and every pane hears it;
 * each answers only the ops that are its own (`flows`/`propose`: an editor; `frames`: a pane; `ping`:
 * both) with `POST /physical-sandbox/editor/answer {id, ok, result | error}`, behind `flows.write`
 * and the pane's write guard, so the browser's own token applies.
 *
 * The first answer wins and later ones are not taken; the others are then told to stop with
 * `ps-editor/cancel {id}`, also when the time runs out. A proposal changes the workspace, so it must
 * land in one editor only: an editor first claims it (`{id, claim: true}`), only the first claim is
 * granted (with a ticket), the cancel goes out at that moment, and only the answer carrying the
 * ticket is taken; only a proposal can be claimed. For `frames` the first answer that gives the
 * frames wins: a pane that refuses (its switch shows off, the frames were too large) does not stop
 * another from answering, and its words are used only when no frames came (the last refusal): as
 * soon as every pane the last ping counted has refused, else when the time is up; pictures take
 * longer, so `frames` waits `framesTimeoutMs` (10 s) at most. A granted proposal
 * that is never answered is not "no editor" (the editor may well have imported it): it rejects with ProposalUnanswered, which
 * tells the agent to look at the editor before proposing again. A `ping` collects every answer for
 * a short time instead.
 *
 * Editors post their answers as `text/plain` with `X-PS-Pane: 1`, read by the route itself up to
 * 20 MB (routes.ts jsonBody): a node set over Node-RED's 5 MB JSON limit still gets through.
 */
import { randomUUID } from 'node:crypto';
import { realClock, type Clock } from '../core/player.js';
import { fromPane, jsonBody } from './routes.js';

export const EDITOR_REQUEST = 'ps-editor/request';
export const EDITOR_CANCEL = 'ps-editor/cancel';
export const ANSWER_ROUTE = '/physical-sandbox/editor/answer';

export const LINK_WORDS = {
  noEditor: 'Node-RED のエディタを開いてください',
  badAnswer: 'エディタからの答えの形が正しくありません',
  proposalUnanswered: 'エディタは提案を受け取りましたが、取り込めたかどうかの答えがありませんでした。もう一度提案する前に、エディタに提案が取り込まれていないか確かめてください'
    + ' / The editor took the proposal but did not answer whether it was imported: check the editor before proposing again',
};

export type EditorOp = 'flows' | 'propose' | 'frames' | 'ping';

/** No editor (or pane) answered in time. */
export class NoEditor extends Error {
  constructor(message = LINK_WORDS.noEditor) { super(message); this.name = 'NoEditor'; }
}

/** An editor was granted a proposal and then did not answer in time: it may have imported it. */
export class ProposalUnanswered extends Error {
  constructor(message = LINK_WORDS.proposalUnanswered) { super(message); this.name = 'ProposalUnanswered'; }
}

/** The editor (or pane) answered, but could not do it; `message` is its words. */
export class EditorRefused extends Error {
  constructor(message: string) { super(message); this.name = 'EditorRefused'; }
}

/** Who is open: editors and panes that answered a ping, or 'unknown' when no ping could go out. */
export type Presence = { editors: number; panes: number } | 'unknown';

export interface EditorLink {
  /**
   * The first answer of an editor or pane; rejects with NoEditor after `timeoutMs` (ProposalUnanswered
   * when an editor was granted the proposal), EditorRefused on a refusal.
   */
  ask(op: Exclude<EditorOp, 'ping'>, args?: unknown, opts?: { timeoutMs?: number }): Promise<any>;
  /** How many editors and panes are open: one ping (answers for `pingMs`), its count kept for `presenceMs`. */
  presence(): Promise<Presence>;
  /** What the answer route does with a body (exposed for tests). */
  answer(body: Record<string, any>): { taken: boolean } | { granted: boolean; ticket?: string };
}

/** The ops whose answer changes the editor: taken only through a claim. */
const CLAIMED: ReadonlySet<string> = new Set(['propose']);

interface Pending {
  op: EditorOp;
  timeoutMs: number;
  timer: unknown;
  resolve(value: any): void;
  reject(error: Error): void;
  /** A ping: every answer is kept until the time is up. */
  answers?: unknown[];
  /** The ticket of the granted claim. */
  ticket?: string;
  /** The last refusal heard, for an op whose refusals wait for a better answer (`frames`), and how many came. */
  refusal?: string;
  refusals?: number;
}

/** The ops whose refusal does not end the request: another may still answer it. */
const PATIENT: ReadonlySet<string> = new Set(['frames']);

export function createEditorLink(RED: any, opts: {
  timeoutMs?: number;
  /** How long `frames` waits (10 s). */
  framesTimeoutMs?: number;
  pingMs?: number;
  presenceMs?: number;
  clock?: Clock;
} = {}): EditorLink {
  const clock = opts.clock ?? realClock;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const framesTimeoutMs = opts.framesTimeoutMs ?? 10_000;
  const pingMs = opts.pingMs ?? 1000;
  const presenceMs = opts.presenceMs ?? 10_000;
  const pending = new Map<string, Pending>();

  const cancel = (id: string) => RED.comms.publish(EDITOR_CANCEL, { id }, false);

  function finish(id: string, p: Pending): void {
    pending.delete(id);
    clock.clearTimeout(p.timer);
  }

  function startTimer(id: string, p: Pending): void {
    clock.clearTimeout(p.timer);
    p.timer = clock.setTimeout(() => {
      if (pending.get(id) !== p) return;
      pending.delete(id);
      if (p.answers) { p.resolve(p.answers); return; }
      // a granted claim was already followed by the cancel
      if (p.ticket) { p.reject(new ProposalUnanswered()); return; }
      cancel(id);
      p.reject(p.refusal !== undefined ? new EditorRefused(p.refusal) : new NoEditor());
    }, p.timeoutMs);
  }

  function request(op: EditorOp, args: unknown, ms: number, collect: boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const p: Pending = { op, timeoutMs: ms, timer: null, resolve, reject, ...(collect ? { answers: [] } : {}) };
      pending.set(id, p);
      try {
        RED.comms.publish(EDITOR_REQUEST, { id, op, args: args ?? {} }, false);
      } catch (e) {
        pending.delete(id);
        reject(e as Error);
        return;
      }
      startTimer(id, p);
    });
  }

  function answer(body: Record<string, any>): { taken: boolean } | { granted: boolean; ticket?: string } {
    const id = body.id as string;
    const p = pending.get(id);
    if (body.claim === true) {
      if (!p || !CLAIMED.has(p.op) || p.ticket) return { granted: false };
      p.ticket = randomUUID();
      startTimer(id, p); // the granted editor is given the full time to import
      cancel(id);
      return { granted: true, ticket: p.ticket };
    }
    if (!p) return { taken: false };
    if (p.answers) {
      if (body.ok === true) p.answers.push(body.result);
      return { taken: true };
    }
    if (CLAIMED.has(p.op) && (!p.ticket || body.ticket !== p.ticket)) return { taken: false };
    if (PATIENT.has(p.op) && body.ok !== true) {
      p.refusal = refusalOf(body);
      p.refusals = (p.refusals ?? 0) + 1;
      // Every pane the last ping counted has refused: no frames are coming, so no need to wait on
      const panes = counted && counted.value !== 'unknown' ? counted.value.panes : null;
      if (panes === null || p.refusals < Math.max(1, panes)) return { taken: true };
    }
    finish(id, p);
    if (!p.ticket) cancel(id);
    if (body.ok === true) p.resolve(body.result);
    else p.reject(new EditorRefused(refusalOf(body)));
    return { taken: true };
  }

  function refusalOf(body: Record<string, any>): string {
    return typeof body.error === 'string' && body.error ? body.error.slice(0, 1000) : 'refused';
  }

  let counted: { at: number; value: Presence } | null = null;
  let counting: Promise<Presence> | null = null;

  async function ping(): Promise<Presence> {
    try {
      const answers: any[] = await request('ping', {}, pingMs, true);
      const editors = new Set<string>();
      const panes = new Set<string>();
      for (const a of answers) {
        if (a === null || typeof a !== 'object' || typeof a.page !== 'string') continue;
        if (a.kind === 'editor') editors.add(a.page);
        else if (a.kind === 'pane') panes.add(a.page);
      }
      const value = { editors: editors.size, panes: panes.size };
      counted = { at: clock.now(), value };
      return value;
    } catch {
      return 'unknown';
    }
  }

  const link: EditorLink = {
    ask: (op, args, o = {}) => request(op, args, o.timeoutMs ?? (op === 'frames' ? framesTimeoutMs : timeoutMs), false),
    presence() {
      if (counted && clock.now() - counted.at < presenceMs) return Promise.resolve(counted.value);
      if (!counting) counting = ping().finally(() => { counting = null; });
      return counting;
    },
    answer,
  };

  const app = RED.httpAdmin;
  if (app) {
    app.post(ANSWER_ROUTE, RED.auth.needsPermission('flows.write'), fromPane, jsonBody, (req: any, res: any) => {
      const body = req.body;
      const shaped = typeof body.id === 'string' && body.id.length > 0 && body.id.length <= 100
        && (body.claim === true || typeof body.ok === 'boolean');
      if (!shaped) { res.status(400).json({ error: LINK_WORDS.badAnswer, reason: 'bad-answer' }); return; }
      res.json(answer(body));
    });
  }
  return link;
}
