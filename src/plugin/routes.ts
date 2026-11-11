/**
 * The plugin's HTTP side, on Node-RED's admin app under `/physical-sandbox/`: reads need
 * `flows.read`, everything that changes something needs `flows.write`. The pane page and its
 * static files are the exception: they are served to anyone who can reach the admin app, as the
 * editor's own files are, with `Referrer-Policy: no-referrer`; the data they ask for is guarded.
 *
 * JSON bodies: Node-RED's admin app already reads `application/json` up to its `apiMaxLength`
 * (5 MB by default) before these routes; a bigger body (a long record to play) is sent with another
 * content type (`text/plain`) and read here, up to 20 MB. The background picture comes as the raw
 * file (`application/octet-stream`, its name URI-encoded in `X-PS-Name`), up to 50 MB, and never
 * leaves this machine. A body
 * over its limit is answered 413 at once and the connection is closed: the rest is not read.
 *
 * Every POST comes from the pane: `application/json`, or the header `X-PS-Pane: 1` (a text body,
 * the picture, no body). A page on another site can send neither without the browser asking
 * first, so with no adminAuth a page the person happens to open cannot change the scene or save.
 */
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as poseSolve from '../pscom/pose-solve.js';
import {
  contentTypeOf, fetchCatalogBundleFile, listMachines, resolveBundle, resolveListed, serveBundleFile,
} from '../core/machines.js';
import { Offline, SignIn } from '../core/pscom-client.js';
import { removeCopy } from '../core/unsent.js';
import { Busy, type Hub } from './hub.js';
import { Answer, createActions, NAME, PLAIN, plainOf, WORDS, type Actions, type PlainJa } from './actions.js';

export { WORDS };

type Json = Record<string, any>;
type FetchLike = (url: string, init?: any) => Promise<any>;

export interface RouteOptions {
  /** Where the built pane (index.html and its module) is. */
  paneDir: string;
  cacheRoot?: string;
  fetchImpl?: FetchLike;
  /** What the routes do to the scene, the stream and the records (shared with the MCP tools); made here when not given. */
  actions?: Actions;
}

export const JSON_LIMIT = 20 * 1024 * 1024;
export const BACKGROUND_LIMIT = 50 * 1024 * 1024;

// TypeScript reads the copied JS's options and answers too narrowly (its defaults are null): typed loosely here
const { floorFromClicks, floorScaleFromEdge, poseFromFloorQuad } = poseSolve as unknown as Record<string, (...args: any[]) => any>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The whole body, or null as soon as it is longer than `limit` (or says so in Content-Length):
 * reading stops there, and the caller answers with `refuseTooLarge`, which closes the connection.
 */
export function readBody(req: any, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers?.['content-length']) > limit) { resolve(null); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.off('data', onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e: Error) => { if (!settled) { settled = true; reject(e); } });
  });
}

/** How long the refused sender is given to read the 413 before the connection is cut. */
export const REFUSED_GRACE_MS = 1000;

/**
 * 413, and none of the rest of the body is read. Once the answer is out the connection is half
 * closed (the sender reads the 413 and the end), the request stays paused (what is still sent
 * waits in the network buffers, then the sender is held back), and the connection is cut after
 * REFUSED_GRACE_MS. Cutting it at once would throw the 413 away on the sender's side with the
 * unread bytes (a reset), so the person would see a broken connection instead of the reason.
 * `body` is the answer (the MCP route answers in JSON-RPC).
 */
export function refuseTooLarge(req: any, res: any, error: string, body: Json = { error, message: wordsFor(error), reason: 'too-large' }): void {
  req.pause();
  const socket = req.socket;
  res.on('finish', () => {
    socket?.end?.();
    const cut = setTimeout(() => req.destroy(), REFUSED_GRACE_MS);
    cut.unref?.(); // never keeps Node-RED from stopping
  });
  res.status(413).json(body);
}

/** The words of a refusal in both languages (`message: {ja, en}`), for the pane to pick one; `error` stays Japanese. */
const wordsFor = (japanese: string): { ja: string; en: string } => plainOf(japanese);

/** Only the pane writes: a JSON body, or the pane's own header (see the top of this file). */
export function fromPane(req: any, res: any, next: () => void): void {
  const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (req.headers?.['x-ps-pane'] === '1' || type === 'application/json') { next(); return; }
  res.status(403).json({ error: WORDS.notPane, message: PLAIN.notPane, reason: 'not-pane' });
}

/** `req.body` as an object: the one Node-RED read, else read here (up to 20 MB). */
export function jsonBody(req: any, res: any, next: () => void): void {
  if (req._body) {
    if (!isObject(req.body)) { res.status(400).json({ error: WORDS.notJson, message: PLAIN.notJson, reason: 'not-json' }); return; }
    next();
    return;
  }
  readBody(req, JSON_LIMIT).then((bytes) => {
    if (!bytes) { refuseTooLarge(req, res, WORDS.tooLarge); return; }
    const text = bytes.toString('utf8').trim();
    let body: unknown;
    try { body = text ? JSON.parse(text) : {}; } catch { body = null; }
    if (!isObject(body)) { res.status(400).json({ error: WORDS.notJson, message: PLAIN.notJson, reason: 'not-json' }); return; }
    req.body = body;
    req._body = true;
    next();
  }, () => res.status(400).json({ error: WORDS.notJson, message: PLAIN.notJson, reason: 'not-json' }));
}

/** What a picture or a video is, by its first bytes: PNG, JPEG, WebP, MP4, QuickTime or WebM. */
export function mediaKind(bytes: Buffer): { kind: 'still' | 'video'; type: string } | null {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString('latin1');
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'still', type: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'still', type: 'image/jpeg' };
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'still', type: 'image/webp' };
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: 'video', type: 'video/webm' };
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') return { kind: 'video', type: ascii(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4' };
  if (bytes.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(4, 8))) return { kind: 'video', type: 'video/quicktime' };
  return null;
}

/** A file name's most bytes in UTF-8: file systems allow 255, and Japanese takes 3 a character. */
export const NAME_MAX_BYTES = 200;

/**
 * A file name to keep the background under: the last part of what was given, without control
 * characters or leading dots, at most 100 characters and NAME_MAX_BYTES bytes (whole characters).
 */
export function safeName(given: unknown): string {
  const last = String(typeof given === 'string' ? given : '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const chars = [...last.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\.{2,}/g, '.').replace(/^\.+/, '').trim()].slice(0, 100);
  while (Buffer.byteLength(chars.join('')) > NAME_MAX_BYTES) chars.pop();
  const clean = chars.join('').trim();
  return clean || 'background';
}

/** The name in `X-PS-Name` (URI-encoded), or '' when there is none or it is not encoded text. */
function headerName(req: any): string {
  const raw = req.headers?.['x-ps-name'];
  if (typeof raw !== 'string') return '';
  try { return decodeURIComponent(raw); } catch { return ''; }
}

export function registerRoutes(RED: any, hub: Hub, opts: RouteOptions): void {
  const app = RED.httpAdmin;
  const read = RED.auth.needsPermission('flows.read');
  const needsWrite = RED.auth.needsPermission('flows.write');
  /** Every POST: the permission, then from the pane only. */
  const write = [needsWrite, fromPane];
  const P = '/physical-sandbox';
  const actions = opts.actions ?? createActions(hub, { cacheRoot: opts.cacheRoot, fetchImpl: opts.fetchImpl });
  const { roots, catalog } = actions;

  const handle = (fn: (req: any, res: any) => Promise<void> | void) => async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof Answer) { res.status(e.status).json({ error: e.message, message: e.words, reason: e.reason, ...e.extra }); return; }
      RED.log?.warn?.(`physical-sandbox: ${req.method} ${req.path}: ${(e as Error)?.stack ?? e}`);
      if (!res.headersSent) res.status(500).json({ error: String((e as Error)?.message ?? e), reason: 'failed' });
    }
  };

  const catalogFile = (ref: string, rel: string) => {
    const token = hub.client.bearer();
    return fetchCatalogBundleFile(ref, rel, { ...catalog, token, fetchImpl: actions.catalogFetchFor(ref, token) });
  };

  // ---- the pane page ----

  // The page and its code ask for no permission, as Node-RED's editor files do: they are static and
  // carry nothing of the person's, and a page loaded in an iframe or a window cannot send a token
  // (it would have to sit in the address). The page then sends the token with every data request.
  // Only the editor (same origin) may frame the pane: another site cannot put it under its own page.
  const paneFile = {
    dotfiles: 'allow',
    headers: { 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "frame-ancestors 'self'" },
  };

  app.get(`${P}/pane`, handle((req, res) => {
    const page = join(opts.paneDir, 'index.html');
    if (!existsSync(page)) throw new Answer(404, WORDS.noPane, 'no-pane');
    res.sendFile(page, paneFile);
  }));

  app.get(/^\/physical-sandbox\/pane\/static\/(.+)$/, handle((req, res) => {
    const rel = String(req.params[0]);
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) throw new Answer(404, WORDS.noPane, 'not-found');
    let rootReal: string; let file: string;
    try {
      rootReal = realpathSync(opts.paneDir);
      file = realpathSync(join(opts.paneDir, ...parts));
    } catch { throw new Answer(404, WORDS.noPane, 'not-found'); }
    if (!file.startsWith(rootReal + sep) || !statSync(file).isFile()) throw new Answer(404, WORDS.noPane, 'not-found');
    res.sendFile(file, paneFile);
  }));

  // ---- the scene ----

  app.get(`${P}/scene`, read, handle((req, res) => { res.json(hub.scene()); }));

  app.post(`${P}/scene/background`, write, handle(async (req, res) => {
    if (req._body) throw new Answer(415, WORDS.notPicture, 'not-picture'); // a form or JSON is not a picture
    const bytes = await readBody(req, BACKGROUND_LIMIT);
    if (!bytes) { refuseTooLarge(req, res, WORDS.backgroundTooLarge); return; }
    const media = mediaKind(bytes);
    if (!media) throw new Answer(415, WORDS.notPicture, 'not-picture');
    const name = safeName(headerName(req));
    mkdirSync(hub.dirs.backgrounds, { recursive: true });
    const tmp = join(hub.dirs.backgrounds, `.${process.pid}.upload`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(hub.dirs.backgrounds, name));
    // Only the picture in use is kept
    for (const other of readdirSync(hub.dirs.backgrounds)) if (other !== name) rmSync(join(hub.dirs.backgrounds, other), { force: true });
    const scene = hub.setScene({ background: { kind: media.kind, name } });
    res.json({ background: scene.background });
  }));

  app.get(`${P}/scene/background`, read, handle((req, res) => {
    const bg = hub.scene().background;
    const file = bg ? join(hub.dirs.backgrounds, bg.name) : null;
    if (!file || !existsSync(file)) throw new Answer(404, WORDS.noBackground, 'no-background');
    const head = Buffer.alloc(16);
    const fd = openSync(file, 'r');
    try { readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
    res.type(mediaKind(head)?.type ?? 'application/octet-stream');
    res.sendFile(file, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-store' } });
  }));

  // The site whose messages the scene takes: `{site}`, or the plugin's own with none (「現地をもとに戻す」)
  app.post(`${P}/scene/site`, write, jsonBody, handle((req, res) => { res.json(actions.setSite(req.body)); }));

  app.post(`${P}/scene/floor`, write, jsonBody, handle((req, res) => {
    const { pixels, edgesM, width, height } = req.body;
    const clicks = Array.isArray(pixels) && pixels.length === 4 && pixels.every((p) => isObject(p) && finite(p.u) && finite(p.v))
      ? pixels.map((p: Json) => ({ u: p.u, v: p.v })) : null;
    if (!clicks || !(finite(width) && width > 0 && finite(height) && height > 0)) throw new Answer(400, WORDS.badFloor, 'bad-floor');
    const size = { width, height };
    const refused = (reason: unknown, mirrored: PlainJa = WORDS.reversed) => reason === 'mirrored'
      ? new Answer(422, mirrored, 'mirrored') : new Answer(422, WORDS.flat, 'flat');
    const scene = hub.scene();

    // The opened record's floor: its corners, in its order (clicked the other way round is refused)
    if (hub.floorIsKnown() && scene.floor) {
      const solved = poseFromFloorQuad(clicks, scene.floor.corners, { ...size, allowMirror: false });
      if (!solved?.extr) throw refused(solved?.reason);
      hub.setScene({ camera: { intr: solved.intr, extr: solved.extr } });
      res.json({ residualPx: solved.residualPx, mirrored: false, edgesM: scene.floor.edgesM, derived: false });
      return;
    }

    // A new floor: the lens and the depth from the clicks, then the camera. Clicked the other way
    // round (anticlockwise on the picture: the camera would be under the floor) it is refused, so
    // corner 1→2 always runs along +x with the floor on its +y side
    if (!(Array.isArray(edgesM) && edgesM.length === 2 && edgesM.every((e) => finite(e) && e > 0))) throw new Answer(400, WORDS.badFloor, 'bad-floor');
    const [edge12M, typed23M] = edgesM as [number, number];
    const found = floorFromClicks(clicks, edge12M, { ...size, edge23M: typed23M });
    if (!found || !('intr' in found) || !found.intr) throw refused(null);
    const solved = poseFromFloorQuad(clicks, floorScaleFromEdge(clicks, edge12M, found.edge23M), { ...size, intr: found.intr, allowMirror: false });
    if (!solved?.extr) throw refused(solved?.reason, WORDS.newReversed);
    const edge23M = Math.round(found.edge23M * 1000) / 1000;
    hub.setScene({
      camera: { intr: solved.intr, extr: solved.extr },
      floor: { corners: solved.siteCorners.map(({ x, y, z }: Json) => ({ x, y, z })), edgesM: [edge12M, edge23M] },
      siteFrameId: null,
    });
    res.json({ residualPx: solved.residualPx, mirrored: solved.mirrored, edgesM: [edge12M, edge23M], derived: found.derived });
  }));

  app.post(`${P}/scene/place`, write, jsonBody, handle(async (req, res) => { res.json(await actions.place(req.body)); }));
  app.post(`${P}/scene/remove`, write, jsonBody, handle((req, res) => { res.json(actions.remove(req.body)); }));

  // ---- robots ----

  app.get(`${P}/machines`, read, handle(async (req, res) => {
    const { machines, offline } = await listMachines({ ...catalog, ...roots, token: hub.client.bearer() });
    actions.noteListed(machines);
    res.json({ offline, machines: machines.map((row) => ({ ...row, bundle: resolveListed(row, roots) })) });
  }));

  app.get(`${P}/bundles/resolve`, read, handle(async (req, res) => {
    const product = String(req.query?.product ?? '');
    try {
      res.json(await resolveBundle(product, { ...catalog, ...roots, token: hub.client.bearer() }));
    } catch (e) {
      throw new Answer(404, WORDS.noProduct, 'no-product', { detail: String((e as Error)?.message ?? e) });
    }
  }));

  app.get(/^\/physical-sandbox\/bundles\/(local|cache|catalog)\/(.+)$/, read, handle(async (req, res) => {
    const source = String(req.params[0]);
    const rest = String(req.params[1]);
    if (source === 'catalog') {
      const parts = rest.split('/');
      const got = parts.length >= 4 ? await catalogFile(parts.slice(0, 3).join('/'), parts.slice(3).join('/')) : null;
      if (!got) throw new Answer(404, WORDS.noProduct, 'not-found');
      res.set({ 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); // a catalog version never changes
      res.type(got.contentType).send(got.bytes);
      return;
    }
    const file = serveBundleFile(source, rest, roots);
    if (!file) throw new Answer(404, WORDS.noProduct, 'not-found');
    // The type of what it is (bundle.json, a picture, a mesh's bytes), never guessed by the browser
    res.type(contentTypeOf(file));
    res.sendFile(file, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  }));

  // ---- the person's records on PS.com ----

  app.get(`${P}/records/mine`, read, handle(async (req, res) => {
    if (!hub.client.status().signedIn) { res.json({ rows: [], signedIn: false }); return; }
    try {
      res.json({ rows: await hub.client.myRecords(), signedIn: true });
    } catch (e) {
      if (e instanceof Offline) { res.json({ rows: [], offline: true }); return; }
      if (e instanceof SignIn) { hub.refreshStatus(); res.json({ rows: [], signedIn: false }); return; } // the token was refused
      throw e;
    }
  }));

  // ---- the stream ----

  app.post(`${P}/stream/play`, write, jsonBody, handle(async (req, res) => { res.json(await actions.play(req.body)); }));

  app.post(`${P}/stream/stop`, write, handle((req, res) => { hub.stop(); res.json({ status: hub.status() }); }));
  app.post(`${P}/stream/clear`, write, handle(async (req, res) => { res.json(await actions.clear()); }));

  // ---- saving ----

  app.post(`${P}/record/save`, write, jsonBody, handle(async (req, res) => { res.json(await actions.save(req.body)); }));

  app.post(`${P}/record/export`, write, jsonBody, handle((req, res) => {
    const { name, title } = req.body;
    const stem = typeof name === 'string' && NAME.test(name) ? name : 'record';
    const words = typeof title === 'string' && title.trim() ? title.trim() : undefined;
    const { record, skipped } = hub.recordNow({ title: words });
    mkdirSync(hub.dirs.exports, { recursive: true });
    const text = JSON.stringify(record, null, 1) + '\n';
    for (let k = 1; k < 1000; k += 1) {
      const fileName = k === 1 ? `${stem}.record.json` : `${stem}-${k}.record.json`;
      const file = join(hub.dirs.exports, fileName);
      try {
        writeFileSync(file, text, { flag: 'wx' }); // never over an earlier export
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      res.json({ file, name: fileName, skipped });
      return;
    }
    throw new Error('no free export name');
  }));

  app.post(`${P}/unsent/send`, write, handle(async (req, res) => { res.json(await hub.sendUnsent()); }));

  // 「取り除く」 on a red line: that kept copy's two files, not while a save or a send is under way
  app.post(`${P}/unsent/remove`, write, jsonBody, handle(async (req, res) => {
    const { name } = req.body;
    let removed: boolean;
    try {
      removed = await hub.exclusiveSave(async () => typeof name === 'string' && removeCopy(hub.dirs.unsent, name));
    } catch (e) {
      if (e instanceof Busy) throw new Answer(409, WORDS.busy, 'busy');
      throw e;
    }
    hub.refreshStatus();
    if (!removed) throw new Answer(404, WORDS.noUnsent, 'no-unsent');
    res.json({ removed: name, status: hub.status() });
  }));

  // ---- signing in ----

  app.post(`${P}/login/start`, write, handle(async (req, res) => {
    try {
      res.json(await hub.client.loginStart());
    } catch (e) {
      if (e instanceof Offline) throw new Answer(503, WORDS.offline, 'offline');
      throw e;
    }
  }));

  // A GET that keeps a token when the login is approved: a write (it only finishes a login the
  // person started with a POST, and its answer cannot be read from another site)
  app.get(`${P}/login/poll`, needsWrite, handle(async (req, res) => {
    const before = hub.client.status().signedIn;
    let status: 'pending' | 'approved' | 'expired';
    try {
      status = await hub.client.loginPoll();
    } catch (e) {
      if (e instanceof Offline) throw new Answer(503, WORDS.offline, 'offline');
      throw e;
    }
    if (status !== 'pending') hub.refreshStatus();
    if (status === 'approved' && !before) void hub.sendUnsent().catch(() => undefined);
    res.json({ status, login: hub.client.status() });
  }));

  app.post(`${P}/pane/agent-frames`, write, jsonBody, handle((req, res) => {
    hub.setAgentFrames(req.body.on === true);
    res.json({ agentFrames: hub.status().agentFrames });
  }));
}
