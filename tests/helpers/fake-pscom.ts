/**
 * A small PS.com for tests: the device-code login, `/api/handle`, and records in the catalog, with
 * the rules of psbx's `tests/conftest.py` `FakeCatalog` (which follows PS.com):
 *
 * - `POST /api/vr/start` → `{deviceCode, userCode, expiresIn}`; `POST /api/vr/poll {deviceCode}`
 *   answers `pending` until `approveAfter` polls, then `approved` with the token once (the code is
 *   consumed: a later poll is `expired`); an unknown code is `expired`. `pollDelayMs` holds each
 *   poll answer back, and `maxPollsInFlight` records how many polls were open at once.
 * - `GET /api/handle` (Bearer) → `{handle}`, 401 `signin` without the token.
 * - `PUT /api/catalog/{h}/{n}/record?new=1|base=<v>&visibility=…`: a version is never written over;
 *   the next version is the highest all-digit one + 1; bytes equal to the latest answer
 *   `unchanged` before the base is checked; `base` other than the latest is 409 `moved` with
 *   `latest`; `new=1` on an existing item is 409 `taken`; another handle is 404; an item that is
 *   not a record is 409 `not-a-record`. `failRecord` makes every record PUT answer it.
 * - `GET /api/catalog/search?owner=me&kind=…` (Bearer) → `{items}` of the signed-in handle, newest
 *   first, `display.ja` the title given to `seed`; 401 `signin` without the token.
 * - `GET /api/catalog/{h}/{n}`, `…/{v}/manifest`, `…/{v}/files/record.json`; a private item is
 *   404 without its owner's token.
 *
 * `stop()` closes the server (PS.com unreachable) and `start(port)` brings it back on the same port
 * with what it held.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

interface Version { raw: Buffer; manifest: Record<string, unknown> }
interface Item { kind: string; visibility: 'private' | 'public'; versions: Map<string, Version>; latest: string | null; title?: string }

const VERSION = /^[a-z0-9][a-z0-9.-]{0,31}$/;

export class FakePsCom {
  handle = 'ada';
  token = 'tok-1';
  deviceCode = 'dev-1';
  userCode = '123456';
  /** Polls answered `pending` before the one that is `approved`. */
  approveAfter = 0;
  /** `expired` instead of approving. */
  expireCodes = false;
  pollDelayMs = 0;
  pollsInFlight = 0;
  maxPollsInFlight = 0;
  vrStarts = 0;
  /** `[status, body]` every record PUT answers with. */
  failRecord: [number, Record<string, unknown>] | null = null;
  /** While set, every record PUT waits for it (a save kept in flight); `putsWaiting` counts them. */
  holdPuts: Promise<void> | null = null;
  putsWaiting = 0;
  items = new Map<string, Item>();
  calls: { method: string; path: string; auth: string | undefined }[] = [];
  port = 0;
  private server: Server | null = null;
  private polls = 0;
  private consumed = false;

  get base(): string { return `http://127.0.0.1:${this.port}`; }

  async start(port = 0): Promise<this> {
    const server = createServer((req, res) => { void this.handle_(req, res); });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Put a record version straight into the store (as if saved elsewhere). */
  seed(handle: string, name: string, version: string, record: unknown, opts: { visibility?: 'private' | 'public'; kind?: string; title?: string } = {}): void {
    const key = `${handle}/${name}`;
    const item = this.items.get(key) ?? { kind: opts.kind ?? 'record', visibility: opts.visibility ?? 'private', versions: new Map(), latest: null, ...(opts.title ? { title: opts.title } : {}) };
    this.items.set(key, item);
    this.store(item, handle, name, version, Buffer.from(JSON.stringify(record)));
  }

  /** The record stored as `handle/name:version`, parsed. */
  record(handle: string, name: string, version: string): any {
    const raw = this.items.get(`${handle}/${name}`)?.versions.get(version)?.raw;
    return raw ? JSON.parse(raw.toString('utf8')) : undefined;
  }

  private store(item: Item, handle: string, name: string, version: string, raw: Buffer): void {
    item.versions.set(version, {
      raw,
      manifest: {
        format: 'physical-sandbox-catalog/1', name: `${handle}/${name}`, version, kind: item.kind,
        files: [{ path: 'record.json', bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') }],
      },
    });
    item.latest = version;
  }

  private async handle_(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const auth = req.headers.authorization;
    this.calls.push({ method: req.method ?? '', path: req.url ?? '', auth });
    const [status, answer] = await this.route(req.method ?? 'GET', req.url ?? '/', auth, body);
    const out = Buffer.isBuffer(answer) ? answer : Buffer.from(JSON.stringify(answer));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': out.length });
    res.end(out);
  }

  private async route(method: string, url: string, auth: string | undefined, body: Buffer): Promise<[number, unknown]> {
    const u = new URL(url, 'http://fake');
    const path = u.pathname;
    const signedIn = auth === `Bearer ${this.token}`;
    if (method === 'POST' && path === '/api/vr/start') {
      this.vrStarts += 1;
      this.polls = 0;
      this.consumed = false;
      return [200, { deviceCode: this.deviceCode, userCode: this.userCode, expiresIn: 600 }];
    }
    if (method === 'POST' && path === '/api/vr/poll') return this.poll(body);
    if (method === 'GET' && path === '/api/handle') return signedIn ? [200, { handle: this.handle }] : [401, { error: 'signin' }];

    if (method === 'GET' && path === '/api/catalog/search') return this.search(u.searchParams, signedIn);

    const parts = path.split('/').map(decodeURIComponent);
    if (parts.length < 5 || parts[1] !== 'api' || parts[2] !== 'catalog') return [404, { error: 'not-found' }];
    const [handle, name, ...rest] = parts.slice(3);
    const key = `${handle}/${name}`;
    if (method === 'GET') return this.read(key, handle, name, rest, signedIn && handle === this.handle);
    if (method === 'PUT' && rest.length === 1 && rest[0] === 'record') {
      if (!signedIn) return [401, { error: 'signin' }];
      if (this.holdPuts) {
        this.putsWaiting += 1;
        await this.holdPuts;
        this.putsWaiting -= 1;
      }
      if (this.failRecord) return this.failRecord;
      if (handle !== this.handle) return [404, { error: 'not-found' }];
      return this.putNext(key, handle, name, u.searchParams, body);
    }
    return [404, { error: 'not-found' }];
  }

  private async poll(body: Buffer): Promise<[number, unknown]> {
    this.pollsInFlight += 1;
    this.maxPollsInFlight = Math.max(this.maxPollsInFlight, this.pollsInFlight);
    try {
      if (this.pollDelayMs) await new Promise((r) => setTimeout(r, this.pollDelayMs));
      let code: unknown;
      try { code = JSON.parse(body.toString('utf8') || '{}').deviceCode; } catch { code = undefined; }
      if (code !== this.deviceCode || this.consumed || this.expireCodes) return [200, { status: 'expired' }];
      this.polls += 1;
      if (this.polls <= this.approveAfter) return [200, { status: 'pending' }];
      this.consumed = true;
      return [200, { status: 'approved', token: this.token, expiresIn: 3600 }];
    } finally {
      this.pollsInFlight -= 1;
    }
  }

  /** `owner=me` (the signed-in handle's items, 401 signed out) by `kind`, newest first; else the public ones. */
  private search(q: URLSearchParams, signedIn: boolean): [number, unknown] {
    const me = q.get('owner') === 'me';
    if (me && !signedIn) return [401, { error: 'signin' }];
    const items = [...this.items.entries()]
      .filter(([key, item]) => (me ? key.startsWith(`${this.handle}/`) : item.visibility === 'public') && (!q.get('kind') || item.kind === q.get('kind')) && item.latest)
      .reverse()
      .map(([key, item]) => {
        const [handle, name] = key.split('/');
        return { handle, name, kind: item.kind, display: { ja: item.title ?? null, en: null }, latest_version: item.latest, version: item.latest };
      });
    return [200, { items }];
  }

  private read(key: string, handle: string, name: string, rest: string[], owner: boolean): [number, unknown] {
    const item = this.items.get(key);
    if (!item || (item.visibility !== 'public' && !owner)) return [404, { error: 'not-found' }];
    if (rest.length === 0) {
      return [200, {
        item: { handle, name, kind: item.kind, visibility: item.visibility, latest_version: item.latest },
        versions: [...item.versions].map(([version, v]) => ({ version, bytes: v.raw.length, finished_at: '2026-11-01' })),
      }];
    }
    const version = item.versions.get(rest[0] === 'latest' && item.latest ? item.latest : rest[0]);
    if (version && rest.length === 2 && rest[1] === 'manifest') return [200, version.manifest];
    if (version && rest.length === 3 && rest[1] === 'files' && rest[2] === 'record.json') return [200, version.raw];
    return [404, { error: 'not-found' }];
  }

  private putNext(key: string, handle: string, name: string, q: URLSearchParams, body: Buffer): [number, unknown] {
    try { JSON.parse(body.toString('utf8')); } catch { return [400, { error: 'bad-record' }]; }
    const base = q.get('base');
    if (base !== null && !VERSION.test(base)) return [400, { error: 'base' }];
    const visibility = q.get('visibility') === 'public' ? 'public' : 'private';
    let item = this.items.get(key);
    if (!item) {
      item = { kind: 'record', visibility, versions: new Map(), latest: null };
      this.items.set(key, item);
      this.store(item, handle, name, '1', body);
      return [201, { name: key, version: '1', bytes: body.length, unchanged: false }];
    }
    if (item.kind !== 'record') return [409, { error: 'not-a-record' }];
    if (q.get('new') === '1') return [409, { error: 'taken' }];
    const latest = item.latest;
    if (latest && item.versions.get(latest)?.raw.equals(body)) {
      return [200, { name: key, version: latest, bytes: body.length, unchanged: true }];
    }
    if (base !== null && latest !== base) return [409, { error: 'moved', latest }];
    const numbers = [...item.versions.keys()].filter((v) => /^\d+$/.test(v)).map(Number);
    const next = String(numbers.length ? Math.max(...numbers) + 1 : 1);
    this.store(item, handle, name, next, body);
    return [200, { name: key, version: next, bytes: body.length, unchanged: false }];
  }
}
