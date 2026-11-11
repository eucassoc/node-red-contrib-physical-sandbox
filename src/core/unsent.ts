/**
 * Records PS.com did not get yet: kept in `<userDir>/physical-sandbox/unsent/` and sent again later,
 * with the rules of psbx `unsent.py` (and the same sentences, so both tools speak alike).
 *
 * A save that cannot reach PS.com (offline, signed out, PS.com failing with a 5xx, or a record that
 * names a robot only this machine has) leaves two files: `<name>.record.json`, the record exactly as
 * it would have gone, and `<name>.send.json`, `{ref, mode, base}` saying where it goes. They survive a
 * restart of Node-RED; `sendAll` sends them through the `sender` it is given (the client's
 * `saveRecord`) and removes what went.
 *
 * A save over a record that was saved over elsewhere meanwhile is neither lost nor written over: it
 * goes as a new record under the first free `<name>-2`, `<name>-3`… and the note says so. A kept new
 * record whose name was taken meanwhile goes the same way. Saving over the same record again while a
 * copy of it waits replaces that copy (its `base` stays): one save over makes one version.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Moved, Offline, Refused, SignIn, Taken, type SaveMode, type Saved } from './pscom-client.js';

export const SIGN_IN = 'PS.com にログインすると送れます';
export const OFFLINE = 'PS.com に接続できませんでした。接続できるようになったら「再送信する」を押してください';
export const SERVER_DOWN = 'PS.com が応答できませんでした。しばらくしてから「再送信する」を押してください';
export const MOVED = '{ref} は別の場所で変わっていたため、{new} として新しく保存しました';
export const TAKEN = '{ref} はもうあったため、{new} として保存しました';
const NAME_MAX = 39; // a catalog name is at most 39 characters
const TRIES = 50; // suffixes tried for a free name

/** What PS.com's refusals mean, by error and HTTP status, else by error alone (psbx `_REFUSALS`). */
const REFUSALS: [code: string, status: number, words: string][] = [
  ['limit', 429, '記録の数が上限に達しています'],
  ['limit', 413, '保存できる容量の上限に達しています'],
  ['too-large', 413, '記録が大きすぎます'],
  ['renaming', 409, 'ハンドルの変更中です。しばらくしてからもう一度お試しください'],
  ['not-a-record', 409, 'その名前は記録以外に使われています。別の名前を指定してください'],
];

/** Sends one record (the client's `saveRecord`, bound). */
export type Sender = (ref: string, record: object, mode: SaveMode, base?: string | null) => Promise<Saved>;
export interface Target { ref: string; mode: SaveMode; base: string | null }
export interface Pending extends Target { name: string }
export interface SentCopy { name: string; ref: string; version: string; mode: SaveMode }
export interface SendAllResult { sent: SentCopy[]; left: Pending[]; notes: string[] }
export type SaveResult =
  | { saved: true; ref: string; version: string; mode: SaveMode; unchanged: boolean; note?: string; unsentSend?: SendAllResult }
  | { saved: false; unsent: string; reason: string; code?: string };

/** `<userDir>/physical-sandbox/unsent`. */
export const unsentDirIn = (userDir: string): string => join(userDir, 'physical-sandbox', 'unsent');

/** Whether PS.com failed on its side (HTTP 5xx): nothing was refused, the copy is kept as when offline. */
export const serverDown = (e: unknown): boolean => e instanceof Refused && e.status >= 500;

/** A refusal said in words for the person: a known `error` in a sentence, anything else as it was said. */
export function refusalWords(e: Refused): string {
  const words = REFUSALS.find(([code, status]) => code === e.code && status === e.status)?.[2]
    ?? REFUSALS.find(([code]) => code === e.code)?.[2];
  return words ?? e.message;
}

/** The name part of `handle/name[:version]` (or of a bare `name`). */
const nameOf = (ref: string): string => ref.split('/').pop()!.split(':')[0];

/** `ref` with `-k` added to its name, the name cut so that it stays a catalog name. */
function suffixed(ref: string, k: number): string {
  const cut = ref.lastIndexOf('/');
  const handle = cut >= 0 ? ref.slice(0, cut) : '';
  const tail = `-${k}`;
  const name = ref.slice(cut + 1).slice(0, NAME_MAX - tail.length).replace(/-+$/, '') + tail;
  return handle ? `${handle}/${name}` : name;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * Keep `record` for `ref` in `dir`; the name it is kept under (the ref's name, or the first free
 * `<name>-2`, `<name>-3`… beside an earlier copy). A save over `ref` while a save over it waits
 * replaces that copy's record and keeps its `base`.
 */
export function keep(dir: string, record: object, target: Target): string {
  const { ref, mode, base } = target;
  if (mode !== 'over' && mode !== 'new') throw new TypeError(`mode must be 'over' or 'new', not ${String(mode)}`);
  mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(record, null, 1) + '\n';
  if (mode === 'over') { // the same record saved over again: the newer content, from the base the first one had
    const waiting = pending(dir).find((p) => p.ref === ref && p.mode === 'over');
    if (waiting) {
      writeAtomic(join(dir, `${waiting.name}.record.json`), text);
      return waiting.name;
    }
  }
  const stem = nameOf(ref);
  let name = stem;
  for (let k = 2; existsSync(join(dir, `${name}.record.json`)) || existsSync(join(dir, `${name}.send.json`)); k += 1) {
    name = `${stem}-${k}`;
  }
  // The record first: a copy counts as pending only once its send file is there too
  writeAtomic(join(dir, `${name}.record.json`), text);
  writeAtomic(join(dir, `${name}.send.json`), JSON.stringify({ ref, mode, base: base ?? null }) + '\n');
  return name;
}

/** The kept copies, by name (a pair that is not whole or not readable is left out). */
export function pending(dir: string): Pending[] {
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  const out: Pending[] = [];
  for (const name of files.filter((f) => f.endsWith('.send.json')).map((f) => f.slice(0, -'.send.json'.length)).sort()) {
    if (!files.includes(`${name}.record.json`)) continue;
    let d: any;
    try { d = JSON.parse(readFileSync(join(dir, `${name}.send.json`), 'utf8')); } catch { continue; }
    if (typeof d !== 'object' || d === null || typeof d.ref !== 'string' || (d.mode !== 'over' && d.mode !== 'new')) continue;
    out.push({ name, ref: d.ref, mode: d.mode, base: typeof d.base === 'string' ? d.base : null });
  }
  return out;
}

const remove = (dir: string, name: string): void => {
  rmSync(join(dir, `${name}.send.json`), { force: true }); // first: a copy without it is never sent again
  rmSync(join(dir, `${name}.record.json`), { force: true });
};

/** Forget the kept saves over `ref`: a newer save over it reached PS.com. */
export function dropOver(dir: string, ref: string): void {
  for (const p of pending(dir)) if (p.ref === ref && p.mode === 'over') remove(dir, p.name);
}

/** The ref as the person knows it: a ref kept signed out has no handle, the written one has. */
function shownRef(ref: string, written: string): string {
  const handle = written.includes('/') ? written.slice(0, written.lastIndexOf('/')) : '';
  return handle && !ref.includes('/') ? `${handle}/${ref}` : ref;
}

/** Send `record` as new under the first free `<ref>-2`, `<ref>-3`… (a Taken answer tries the next). */
async function underFreeName(record: object, ref: string, sender: Sender, words: string): Promise<SentOne> {
  for (let k = 2; k < 2 + TRIES; k += 1) {
    const candidate = suffixed(ref, k);
    try {
      const saved = await sender(candidate, record, 'new', null);
      const note = words.replace('{ref}', shownRef(ref, saved.ref)).replace('{new}', saved.ref);
      return { ...saved, mode: 'new', note };
    } catch (e) {
      if (e instanceof Taken) continue;
      throw e;
    }
  }
  throw new Taken(`${ref} の新しい名前が見つかりませんでした`);
}

interface SentOne extends Saved { mode: SaveMode; note?: string }

/**
 * Send one record. A save over that answers Moved goes as a new record under the first free suffix,
 * carrying `basedOn`; with `takenToo` a new record whose name is taken goes the same way. Other
 * failures are thrown as they come.
 */
async function sendOne(record: object, target: Target, sender: Sender, takenToo: boolean): Promise<SentOne> {
  const { ref, mode, base } = target;
  try {
    return { ...(await sender(ref, record, mode, base)), mode };
  } catch (e) {
    if (e instanceof Moved) {
      const copy: Record<string, unknown> = structuredClone(record) as Record<string, unknown>;
      if (base) copy.basedOn = `${ref}:${base}`;
      return underFreeName(copy, ref, sender, MOVED);
    }
    if (e instanceof Taken && mode === 'new' && takenToo) return underFreeName(record, ref, sender, TAKEN);
    throw e;
  }
}

/** One save or send round at a time per folder, so that no copy is sent twice. */
const queues = new Map<string, Promise<unknown>>();
function serially<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(dir) ?? Promise.resolve();
  const run = before.then(work, work);
  const settled = run.catch(() => undefined);
  queues.set(dir, settled);
  void settled.then(() => { if (queues.get(dir) === settled) queues.delete(dir); });
  return run;
}

/**
 * Send every kept copy; `{sent, left, notes}`. Offline, a server error (5xx) or signed out, the rest
 * is not tried: every copy stays. Another refusal keeps that copy with the reason in words.
 */
export function sendAll(dir: string, sender: Sender): Promise<SendAllResult> {
  return serially(dir, () => sendAllNow(dir, sender));
}

async function sendAllNow(dir: string, sender: Sender): Promise<SendAllResult> {
  const out: SendAllResult = { sent: [], left: [], notes: [] };
  const waiting = pending(dir);
  for (let i = 0; i < waiting.length; i += 1) {
    const p = waiting[i];
    let record: object;
    try { record = JSON.parse(readFileSync(join(dir, `${p.name}.record.json`), 'utf8')); } catch { out.left.push(p); continue; }
    let sent: SentOne;
    try {
      sent = await sendOne(record, p, sender, true);
    } catch (e) {
      const stop = e instanceof SignIn ? SIGN_IN : e instanceof Offline ? OFFLINE : serverDown(e) ? SERVER_DOWN : null;
      if (stop) {
        out.left.push(...waiting.slice(i));
        out.notes.push(stop);
        break;
      }
      out.left.push(p);
      const words = e instanceof Refused ? refusalWords(e) : (e as Error)?.message ?? String(e);
      out.notes.push(`${p.name} を送れませんでした（${words}）`);
      continue;
    }
    remove(dir, p.name);
    out.sent.push({ name: p.name, ref: sent.ref, version: sent.version, mode: sent.mode });
    if (sent.note) out.notes.push(sent.note);
  }
  return out;
}

/**
 * Save a record (the pane's 上書き保存 / 新しい記録として保存): `new` under `ref`, or `over` the record
 * `ref` from `base` (the latest it had when it was opened). Signed out, offline, PS.com failing, or a
 * record naming a robot only this machine has: the record is kept (`saved: false`, with the reason in
 * words). A save over that moved meanwhile is saved as a new record with a `note`. A new record under
 * a name that is there is Taken (with a sentence), and other refusals are thrown: nothing is kept.
 * Saved, a waiting save over the same record is dropped (this one is newer) and the other kept copies
 * are sent too (`unsentSend`).
 */
export function save(dir: string, sender: Sender, record: object, target: Target): Promise<SaveResult> {
  return serially(dir, async (): Promise<SaveResult> => {
    let sent: SentOne;
    try {
      sent = await sendOne(record, target, sender, false);
    } catch (e) {
      const kept = (reason: string, code?: string): SaveResult => ({
        saved: false, unsent: keep(dir, record, target), reason, ...(code ? { code } : {}),
      });
      if (e instanceof SignIn) return kept(SIGN_IN);
      if (e instanceof Offline) return kept(OFFLINE);
      if (serverDown(e)) return kept(SERVER_DOWN);
      if (e instanceof Refused && e.code === 'local-machine') return kept(e.message, e.code);
      if (e instanceof Taken) throw new Taken(`${target.ref} はもうあります。別の名前を指定してください`);
      throw e;
    }
    const out: SaveResult = { saved: true, ref: sent.ref, version: sent.version, mode: sent.mode, unchanged: sent.unchanged };
    if (sent.note) out.note = sent.note;
    if (target.mode === 'over' && sent.mode === 'over') dropOver(dir, target.ref);
    if (pending(dir).length) out.unsentSend = await sendAllNow(dir, sender);
    return out;
  });
}
