/**
 * PS.com from Node-RED: signing in, saving a record in two ways and opening one.
 *
 * - Signing in is the headset's device-code flow (`/api/vr/start`, `/api/vr/poll`), as psbx `login`:
 *   `loginStart` asks for a code to enter at `{base}/vr`; the pane then calls `loginPoll` again and
 *   again. The client keeps polls 3 s apart (a call sooner answers `pending` without a request),
 *   never has two polls open at once (a call while one is open gets the same promise) and gives up
 *   600 s after the start. The token is kept in
 *   `<userDir>/physical-sandbox/ps-com-token.json` (mode 0600) as `{base, token, expiresAt, handle}`,
 *   the same shape psbx keeps; `status()` reads that file alone.
 * - `saveRecord` PUTs a record through the catalog door: `new` makes a new item (`new=1`), `over`
 *   the next version of an item (`base=` the version it was made from). The server numbers the
 *   versions and never writes over one; bytes equal to the latest make no version (`unchanged`).
 *   A record naming a robot only this machine has (`isLocalMachine`) is refused before any request:
 *   Node-RED has no URDF to send with it. Other bare names (PS.com's own ids in records the PS.com
 *   app wrote) go as they are, as psbx sends a record made from a PS.com record.
 * - `openRecord` reads a record and says which version it is, the item's latest at that moment
 *   and whether it is the signed-in person's own (the only kind that can be saved over).
 *
 * Failures are typed: `Offline` (PS.com could not be reached), `SignIn` (no usable token; a token
 * PS.com refuses is forgotten), `Moved` (saved over elsewhere meanwhile), `Taken` (the name is
 * there) and `Refused` (any other answer, with the API's `error` and the HTTP status).
 */
import { mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, closeSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Json = Record<string, any>;
type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean; status: number; text: () => Promise<string>;
}>;

export type SaveMode = 'new' | 'over';
export interface Saved { ref: string; version: string; unchanged: boolean }
export interface Opened { record: Json; version: string; latest: string; own: boolean }
export interface LoginStatus { signedIn: boolean; handle: string | null }

export interface ClientOptions {
  base: string;
  tokenFile: string;
  fetchImpl?: FetchLike;
  /** Between two polls of the login (3 s; tests use 0). */
  pollMs?: number;
  /** A login not approved this long after its start is given up (600 s). */
  giveUpMs?: number;
  /** One request's limit (120 s, as psbx). */
  timeoutMs?: number;
  now?: () => number;
  /**
   * Whether a bare product name is a robot only this machine has (a local folder): a record naming
   * one cannot be uploaded from here. Other bare names (PS.com's own ids such as `so101` in records
   * the PS.com app wrote) are sent as they are. Default: none is local.
   */
  isLocalMachine?: (name: string) => boolean;
}

/** Base class of what the client throws. */
export class PsComError extends Error {}
/** PS.com could not be reached (no network, refused connection, timeout). */
export class Offline extends PsComError { override name = 'Offline'; }
/** Not signed in, or PS.com refused the kept token. */
export class SignIn extends PsComError {
  override name = 'SignIn';
  constructor(message = 'not signed in to PS.com') { super(message); }
}
/** A save over a record whose latest version is no longer the base it was made from. */
export class Moved extends PsComError {
  override name = 'Moved';
  constructor(readonly latest: string | null, message = `moved: the latest is ${latest}`) { super(message); }
}
/** A new record under a name that is already there. */
export class Taken extends PsComError {
  override name = 'Taken';
  constructor(message = 'taken') { super(message); }
}
/**
 * Any other answer: `code` is the API's `error` (or `HTTP <status>`), `status` the HTTP status (0:
 * refused here). The message is the code, or a sentence for the person when one is given.
 */
export class Refused extends PsComError {
  override name = 'Refused';
  constructor(readonly code: string, readonly status: number, message = code) { super(message); }
}

/** `<userDir>/physical-sandbox/ps-com-token.json`. */
export const tokenFileIn = (userDir: string): string => join(userDir, 'physical-sandbox', 'ps-com-token.json');

const POLL_MS = 3000;
const GIVE_UP_MS = 600_000;
const TIMEOUT_MS = 120_000;
/** A catalog name: 2–39 characters of a-z, 0-9 and `-`, starting and ending with a letter or digit. */
const NAME = /^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$/;
const VERSION = /^[a-z0-9][a-z0-9.-]{0,31}$/;

/** A record is saved only under the signed-in handle (as psbx push). */
export const NOT_MINE = '{ref} は {mine} の記録ではないため保存できません';
export const LOCAL_MACHINE = '手元のロボット {name} は PS.com にありません。psbx push でロボットを上げてから保存してください';

interface Login { deviceCode: string; startedAt: number; lastPollAt: number }

export class PsComClient {
  readonly base: string;
  private readonly tokenFile: string;
  private readonly fetchImpl: FetchLike;
  private readonly pollMs: number;
  private readonly giveUpMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly isLocalMachine: (name: string) => boolean;
  private login: Login | null = null;
  private polling: Promise<'pending' | 'approved' | 'expired'> | null = null;

  constructor(opts: ClientOptions) {
    this.base = String(opts.base).replace(/\/+$/, '');
    this.tokenFile = opts.tokenFile;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.giveUpMs = opts.giveUpMs ?? GIVE_UP_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.isLocalMachine = opts.isLocalMachine ?? (() => false);
  }

  // ---- signing in ----

  /** Ask PS.com for a code; the person enters `userCode` at `url`. */
  async loginStart(): Promise<{ userCode: string; url: string }> {
    const body = await this.call('POST', '/api/vr/start');
    if (typeof body?.deviceCode !== 'string' || typeof body?.userCode !== 'string') {
      throw new Refused('bad-answer', 200);
    }
    const now = this.now();
    this.login = { deviceCode: body.deviceCode, startedAt: now, lastPollAt: now };
    return { userCode: body.userCode, url: `${this.base}/vr` };
  }

  /**
   * One poll of the login under way. Sooner than 3 s after the start or the previous poll it answers
   * `pending` at once without a request. `approved` keeps the token
   * (and the handle); `expired` ends the login (the code expired, or 600 s went by). With no login under
   * way it answers from the token file: `approved` when signed in, else `expired`.
   */
  loginPoll(): Promise<'pending' | 'approved' | 'expired'> {
    if (!this.polling) {
      this.polling = this.pollOnce().finally(() => { this.polling = null; });
    }
    return this.polling;
  }

  private async pollOnce(): Promise<'pending' | 'approved' | 'expired'> {
    const login = this.login;
    if (!login) return this.status().signedIn ? 'approved' : 'expired';
    if (this.now() - login.startedAt >= this.giveUpMs) {
      this.login = null;
      return 'expired';
    }
    if (this.now() - login.lastPollAt < this.pollMs) return 'pending'; // too soon: answered without a request
    login.lastPollAt = this.now();
    const body = await this.call('POST', '/api/vr/poll', { body: { deviceCode: login.deviceCode } });
    if (this.login !== login) return this.status().signedIn ? 'approved' : 'expired'; // a new login started meanwhile
    if (body?.status === 'approved' && typeof body.token === 'string' && body.token) {
      this.login = null;
      const expiresIn = Number(body.expiresIn) > 0 ? Number(body.expiresIn) : 3600;
      this.writeKept({ base: this.base, token: body.token, expiresAt: new Date(this.now() + expiresIn * 1000).toISOString() });
      try { await this.handle(body.token); } catch { /* the handle is asked again when it is needed */ }
      return 'approved';
    }
    if (body?.status === 'expired') {
      this.login = null;
      return 'expired';
    }
    return 'pending';
  }

  /** `{signedIn, handle}` from the token file alone (no request). */
  status(): LoginStatus {
    const kept = this.kept();
    if (!kept) return { signedIn: false, handle: null };
    return { signedIn: true, handle: typeof kept.handle === 'string' && kept.handle ? kept.handle : null };
  }

  /** The kept token file's content while it is for this base and has not expired. */
  private kept(): Json | null {
    let kept: unknown;
    try { kept = JSON.parse(readFileSync(this.tokenFile, 'utf8')); } catch { return null; }
    if (!isObject(kept) || kept.base !== this.base || typeof kept.token !== 'string' || !kept.token) return null;
    const expires = Date.parse(String(kept.expiresAt ?? ''));
    return Number.isFinite(expires) && expires > this.now() ? kept : null;
  }

  private writeKept(kept: Json): void {
    mkdirSync(dirname(this.tokenFile), { recursive: true });
    const tmp = `${this.tokenFile}.${process.pid}.tmp`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try { writeSync(fd, JSON.stringify(kept)); } finally { closeSync(fd); }
      chmodSync(tmp, 0o600); // an older file of that name may have had other bits
      renameSync(tmp, this.tokenFile);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private forget(): void {
    try {
      const kept = JSON.parse(readFileSync(this.tokenFile, 'utf8'));
      if (isObject(kept) && kept.base === this.base) rmSync(this.tokenFile, { force: true });
    } catch { /* nothing kept */ }
  }

  /** The signed-in account's handle: from the token file, else asked once and kept there. */
  private async handle(token: string): Promise<string> {
    const kept = this.kept();
    if (kept && typeof kept.handle === 'string' && kept.handle) return kept.handle;
    const body = await this.call('GET', '/api/handle', { token });
    if (typeof body?.handle !== 'string' || !body.handle) {
      throw new Refused('no-handle', 200, 'PS.com でハンドルを決定してから保存してください');
    }
    const now = this.kept();
    if (now) this.writeKept({ ...now, handle: body.handle });
    return body.handle;
  }

  /** The kept token and the handle, or SignIn. */
  private async signedIn(): Promise<{ token: string; handle: string }> {
    const token = this.kept()?.token;
    if (typeof token !== 'string') throw new SignIn();
    return { token, handle: await this.handle(token) };
  }

  // ---- records ----

  /**
   * Save `record` to `ref` (`handle/name` under the signed-in handle, else Refused `not-mine` before
   * any request; or a bare `name`, under the signed-in handle): `new` as a
   * new record (Taken when the name is there), `over` as the next version, from `base` when given
   * (Moved when the latest is another). Always private when the item is new.
   */
  async saveRecord(ref: string, record: object, mode: SaveMode, base?: string | null): Promise<Saved> {
    const { handle: owner, name } = splitRef(ref);
    if (mode !== 'new' && mode !== 'over') throw new TypeError(`mode must be 'new' or 'over', not ${String(mode)}`);
    if (base != null && !VERSION.test(base)) throw new TypeError(`${base} is not a version`);
    const local = localProducts(record).filter((product) => this.isLocalMachine(product));
    if (local.length) throw new Refused('local-machine', 0, LOCAL_MACHINE.replace('{name}', local.join(', ')));
    const { token, handle: mine } = await this.signedIn();
    if (owner !== null && owner !== mine) {
      throw new Refused('not-mine', 0, NOT_MINE.replace('{ref}', `${owner}/${name}`).replace('{mine}', mine));
    }
    const handle = mine;
    const query = new URLSearchParams();
    if (mode === 'new') query.set('new', '1');
    else if (base != null) query.set('base', base);
    query.set('visibility', 'private');
    const path = `/api/catalog/${encodeURIComponent(handle)}/${encodeURIComponent(name)}/record?${query}`;
    const answer = await this.call('PUT', path, { token, body: record });
    const version = answer?.version;
    if (typeof version !== 'string' && typeof version !== 'number') throw new Refused('bad-answer', 200);
    return { ref: `${handle}/${name}`, version: String(version), unchanged: answer?.unchanged === true };
  }

  /**
   * Read the record `ref` (`handle/name[:version]`, the latest without one). `latest` is the item's
   * latest version at this moment; `own` says whether it is under the signed-in handle.
   */
  async openRecord(ref: string): Promise<Opened> {
    const { handle, name, version: asked } = splitRef(ref);
    if (!handle) throw new TypeError(`${ref} is not handle/name[:version]`);
    const kept = this.kept();
    const token = typeof kept?.token === 'string' ? kept.token : undefined;
    const root = `/api/catalog/${encodeURIComponent(handle)}/${encodeURIComponent(name)}`;
    const info = await this.call('GET', root, { token });
    const item = isObject(info?.item) ? info.item : {};
    if (item.kind !== 'record') throw new Refused('not-a-record', 200, `${handle}/${name} は記録ではありません`);
    const latest = item.latest_version == null ? null : String(item.latest_version);
    const version = asked && asked !== 'latest' ? asked : latest;
    if (!version) throw new Refused('not-found', 404);
    const record = await this.call('GET', `${root}/${encodeURIComponent(version)}/files/record.json`, { token });
    if (!isObject(record)) throw new Refused('not-a-record', 200, `${handle}/${name}:${version} は記録ではありません`);
    const signed = this.status();
    return { record, version, latest: latest ?? version, own: signed.signedIn && signed.handle === handle };
  }

  // ---- HTTP ----

  /** One request; the JSON answer, or the error it is. A 401 to a request with the token forgets the token. */
  private async call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<any> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method, headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new Offline(`${this.base}${path}: ${(e as Error)?.message ?? e}`);
    }
    let body: any = null;
    try { body = text ? JSON.parse(text) : {}; } catch { body = null; }
    if (res.ok) {
      if (body === null) throw new Refused('bad-answer', res.status);
      return body;
    }
    const error = isObject(body) && typeof body.error === 'string' && body.error ? body.error : `HTTP ${res.status}`;
    if (res.status === 401) {
      if (opts.token) this.forget();
      throw new SignIn();
    }
    if (res.status === 409 && error === 'taken') throw new Taken();
    if (res.status === 409 && error === 'moved') {
      const latest = isObject(body) && body.latest != null ? String(body.latest) : null;
      throw new Moved(latest);
    }
    throw new Refused(error, res.status);
  }
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `handle/name[:version]` or a bare `name`; the name must be a catalog name. */
function splitRef(ref: string): { handle: string | null; name: string; version: string | null } {
  const m = /^(?:([^/:]+)\/)?([^/:]+)(?::([^/:]+))?$/.exec(String(ref));
  if (!m || !NAME.test(m[2])) {
    throw new Refused('bad-name', 0, '名前は英小文字・数字・- の 2〜39 文字で、先頭と末尾は英小文字か数字にしてください');
  }
  return { handle: m[1] ?? null, name: m[2], version: m[3] ?? null };
}

/** The bare product names (no `handle/`) the record's devices name, each once (local or PS.com's own ids). */
export function localProducts(record: unknown): string[] {
  const devices = isObject(record) && isObject(record.equipment) && Array.isArray(record.equipment.devices) ? record.equipment.devices : [];
  const out: string[] = [];
  for (const d of devices) {
    const product = isObject(d) ? d.product : undefined;
    if (typeof product === 'string' && product && !product.includes('/') && !out.includes(product)) out.push(product);
  }
  return out;
}
