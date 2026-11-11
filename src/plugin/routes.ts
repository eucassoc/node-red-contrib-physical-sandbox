/**
 * The plugin's HTTP side, on Node-RED's admin app under `/physical-sandbox/`: reads need
 * `flows.read`, everything that changes something needs `flows.write`. The pane page and its
 * static files are the exception: they are served to anyone who can reach the admin app, as the
 * editor's own files are, with `Referrer-Policy: no-referrer`; the data they ask for is guarded.
 *
 * JSON bodies: Node-RED's admin app already reads `application/json` up to its `apiMaxLength`
 * (5 MB by default) before these routes; a bigger body (a long record to play) is sent with another
 * content type (`text/plain`) and read here, up to 20 MB. The background picture comes as the raw
 * file (`application/octet-stream`, `?name=`), up to 50 MB, and never leaves this machine. A body
 * over its limit is answered 413 at once and the connection is closed: the rest is not read.
 *
 * Every POST comes from the pane: `application/json`, or the header `X-PS-Pane: 1` (a text body,
 * the picture, no body). A page on another site can send neither without the browser asking
 * first, so with no adminAuth a page the person happens to open cannot change the scene or save.
 */
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as poseSolve from '../pscom/pose-solve.js';
import { isTopicName } from '../pscom/state.js';
import { deviceStem, parseRef } from '../pscom/catalog-client.js';
import { messagesToRecord, mergeStreamInto, type Device } from '../core/stream.js';
import {
  BUNDLE_ROUTE, defaultCacheRoot, fetchCatalogBundleFile, listMachines, resolveBundle, resolveListed, serveBundleFile,
  type MachineRow, type Resolved,
} from '../core/machines.js';
import { Offline, Refused, SignIn, Taken } from '../core/pscom-client.js';
import { save } from '../core/unsent.js';
import { Busy, type Hub, type Opened } from './hub.js';

type Json = Record<string, any>;
type FetchLike = (url: string, init?: any) => Promise<any>;

export interface RouteOptions {
  /** Where the built pane (index.html and its module) is. */
  paneDir: string;
  cacheRoot?: string;
  fetchImpl?: FetchLike;
}

export const JSON_LIMIT = 20 * 1024 * 1024;
export const BACKGROUND_LIMIT = 50 * 1024 * 1024;

// What the person is told (案内文調); `reason` beside each lets the pane say it in its own words
export const WORDS = {
  notJson: '送られた内容を読み込めませんでした',
  tooLarge: '送られた内容が大きすぎます（20 MB まで）',
  backgroundTooLarge: '背景のファイルが大きすぎます（50 MB まで）',
  notPicture: '背景には画像（PNG・JPEG・WebP）か動画（MP4・WebM・QuickTime）を選択してください',
  noBackground: '背景は選択されていません',
  badFloor: '床の角 4 つ（映像の上の位置と映像の大きさ）と、角 1→2・角 2→3 の長さ（m）を指定してください',
  reversed: '角の順番が逆です。角 1 から、同じ回り方でもう一度指定してください',
  newReversed: '床の角の順番が逆回りです。映像の上で、角 1 から時計回りにもう一度指定してください',
  flat: '床の遠近が足りず画角を求められません。カメラをもっと見下ろす位置に置いて、角をもう一度指定してください',
  badPlace: 'ロボットと置く位置（x, y）を指定してください',
  idTaken: 'その名前はもう使われています。別の名前を指定してください',
  noDevice: 'その名前のロボットはありません',
  noProduct: 'そのロボットは見つかりませんでした',
  noRecord: '記録か、PS.com の記録の名前（handle/name）を指定してください',
  offline: 'PS.com に接続できませんでした',
  signIn: 'PS.com にログインしてください',
  notFound: '記録が見つかりませんでした',
  badName: '名前は英小文字・数字・- の 2〜39 文字で、先頭と末尾は英小文字か数字にしてください',
  notOwn: '上書き保存できるのは、ログイン中のアカウントの PS.com の記録だけです',
  noPane: '画面はまだ用意されていません',
  notPane: 'Physical Sandbox の画面から操作してください',
  busy: '保存中です。終わるまでお待ちください',
};

/** A catalog name (pscom-client.ts NAME). */
const NAME = /^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$/;

// TypeScript reads the copied JS's options and answers too narrowly (its defaults are null): typed loosely here
const { floorFromClicks, floorScaleFromEdge, poseFromFloorQuad } = poseSolve as unknown as Record<string, (...args: any[]) => any>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** An answer other than 200, with the words for the person and a reason code for the pane. */
class Answer extends Error {
  constructor(readonly status: number, message: string, readonly reason: string, readonly extra: Json = {}) { super(message); }
}

/**
 * The whole body, or null as soon as it is longer than `limit` (or says so in Content-Length):
 * reading stops there, and the caller answers with `refuseTooLarge`, which closes the connection.
 */
function readBody(req: any, limit: number): Promise<Buffer | null> {
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
 */
function refuseTooLarge(req: any, res: any, error: string): void {
  req.pause();
  const socket = req.socket;
  res.on('finish', () => {
    socket?.end?.();
    const cut = setTimeout(() => req.destroy(), REFUSED_GRACE_MS);
    cut.unref?.(); // never keeps Node-RED from stopping
  });
  res.status(413).json({ error, reason: 'too-large' });
}

/** Only the pane writes: a JSON body, or the pane's own header (see the top of this file). */
function fromPane(req: any, res: any, next: () => void): void {
  const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (req.headers?.['x-ps-pane'] === '1' || type === 'application/json') { next(); return; }
  res.status(403).json({ error: WORDS.notPane, reason: 'not-pane' });
}

/** `req.body` as an object: the one Node-RED read, else read here (up to 20 MB). */
function jsonBody(req: any, res: any, next: () => void): void {
  if (req._body) {
    if (!isObject(req.body)) { res.status(400).json({ error: WORDS.notJson, reason: 'not-json' }); return; }
    next();
    return;
  }
  readBody(req, JSON_LIMIT).then((bytes) => {
    if (!bytes) { refuseTooLarge(req, res, WORDS.tooLarge); return; }
    const text = bytes.toString('utf8').trim();
    let body: unknown;
    try { body = text ? JSON.parse(text) : {}; } catch { body = null; }
    if (!isObject(body)) { res.status(400).json({ error: WORDS.notJson, reason: 'not-json' }); return; }
    req.body = body;
    req._body = true;
    next();
  }, () => res.status(400).json({ error: WORDS.notJson, reason: 'not-json' }));
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

/** A file name to keep the background under: the last part of what was given, without control characters or leading dots. */
export function safeName(given: unknown): string {
  const last = String(typeof given === 'string' ? given : '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = [...last.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\.{2,}/g, '.').replace(/^\.+/, '').trim()].slice(0, 100).join('');
  return clean || 'background';
}

/** [length, width, height] from a bundle's `dimensions` (an array or {length,width,height}/{x,y,z}), as PS.com's catalog reads it. */
function dimensionsOf(bundle: unknown): [number, number, number] | null {
  const own = isObject(bundle) ? bundle.dimensions : undefined;
  const numbers = (list: unknown[]) => (list.length === 3 && list.every((n) => finite(n) && (n as number) > 0) ? list as [number, number, number] : null);
  if (Array.isArray(own)) return numbers(own);
  if (isObject(own)) return numbers([own.length ?? own.x, own.width ?? own.y, own.height ?? own.z].map(Number));
  return null;
}

/** A small cache of the catalog's manifests and bundle.json files (a version never changes), by ref. */
class CatalogCache {
  private readonly refs = new Map<string, { at: number; files: Map<string, { ok: boolean; status: number; bytes: Buffer }> }>();
  constructor(private readonly fetchImpl: FetchLike, private readonly maxRefs = 50, private readonly ttlMs = 10 * 60_000) {}

  /** A fetch for one ref: its manifest and bundle.json come from the cache after the first time. */
  fetchFor(ref: string, token: string | undefined): FetchLike {
    return async (url, init) => {
      if (!/\/manifest$|\/bundle\.json$/.test(new URL(url).pathname)) return this.fetchImpl(url, init);
      const key = `${token ?? ''}|${ref}`; // a private robot's files are never given to another account
      let entry = this.refs.get(key);
      if (!entry || Date.now() - entry.at > this.ttlMs) {
        entry = { at: Date.now(), files: new Map() };
        this.refs.set(key, entry);
        while (this.refs.size > this.maxRefs) this.refs.delete(this.refs.keys().next().value!);
      }
      let file = entry.files.get(url);
      if (!file) {
        const res = await this.fetchImpl(url, init);
        const bytes = res.arrayBuffer ? Buffer.from(await res.arrayBuffer()) : Buffer.from(JSON.stringify(await res.json()));
        file = { ok: res.ok, status: res.status, bytes };
        if (res.ok) entry.files.set(url, file);
      }
      const { ok, status, bytes } = file;
      return {
        ok, status,
        json: async () => JSON.parse(bytes.toString('utf8')),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        headers: { get: () => null },
      };
    };
  }
}

export function registerRoutes(RED: any, hub: Hub, opts: RouteOptions): void {
  const app = RED.httpAdmin;
  const read = RED.auth.needsPermission('flows.read');
  const needsWrite = RED.auth.needsPermission('flows.write');
  /** Every POST: the permission, then from the pane only. */
  const write = [needsWrite, fromPane];
  const P = '/physical-sandbox';
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const roots = { cacheRoot: opts.cacheRoot ?? defaultCacheRoot(), localDirs: hub.settings.localMachineDirs };
  const catalog = { catalogBase: hub.settings.catalogBase, fetchImpl };
  const catalogCache = new CatalogCache(fetchImpl);
  /** The kind of each robot of the last listing (machine or object), for placing it. */
  const listedKinds = new Map<string, MachineRow['kind']>();

  const handle = (fn: (req: any, res: any) => Promise<void> | void) => async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof Answer) { res.status(e.status).json({ error: e.message, reason: e.reason, ...e.extra }); return; }
      RED.log?.warn?.(`physical-sandbox: ${req.method} ${req.path}: ${(e as Error)?.stack ?? e}`);
      if (!res.headersSent) res.status(500).json({ error: String((e as Error)?.message ?? e), reason: 'failed' });
    }
  };

  const catalogFile = (ref: string, rel: string) => {
    const token = hub.client.bearer();
    return fetchCatalogBundleFile(ref, rel, { ...catalog, token, fetchImpl: catalogCache.fetchFor(ref, token) });
  };

  /** A resolved bundle's path after `/bundles/<source>/` (decoded). */
  const pathOf = (r: Resolved): string =>
    r.bundleUrl.slice(`${BUNDLE_ROUTE}/${r.source}/`.length, -'/bundle.json'.length).split('/').map(decodeURIComponent).join('/');

  async function bundleJsonOf(product: string): Promise<Json | null> {
    const r = await resolveBundle(product, { ...catalog, ...roots, token: hub.client.bearer() });
    if (r.source === 'catalog') {
      const got = await catalogFile(pathOf(r), 'bundle.json');
      return got ? JSON.parse(got.bytes.toString('utf8')) : null;
    }
    const file = serveBundleFile(r.source, `${pathOf(r)}/bundle.json`, roots);
    return file ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  // ---- the pane page ----

  // The page and its code ask for no permission, as Node-RED's editor files do: they are static and
  // carry nothing of the person's, and a page loaded in an iframe or a window cannot send a token
  // (it would have to sit in the address). The page then sends the token with every data request.
  const paneFile = { dotfiles: 'allow', headers: { 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer' } };

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
    const name = safeName(req.query?.name);
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

  app.post(`${P}/scene/floor`, write, jsonBody, handle((req, res) => {
    const { pixels, edgesM, width, height } = req.body;
    const clicks = Array.isArray(pixels) && pixels.length === 4 && pixels.every((p) => isObject(p) && finite(p.u) && finite(p.v))
      ? pixels.map((p: Json) => ({ u: p.u, v: p.v })) : null;
    if (!clicks || !(finite(width) && width > 0 && finite(height) && height > 0)) throw new Answer(400, WORDS.badFloor, 'bad-floor');
    const size = { width, height };
    const refused = (reason: unknown, mirrored = WORDS.reversed) => reason === 'mirrored'
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

  app.post(`${P}/scene/place`, write, jsonBody, handle(async (req, res) => {
    const { id, product, xyz, yaw } = req.body;
    const productOk = typeof product === 'string' && (parseRef(product) !== null || (isTopicName(product) && !product.includes(':')));
    if (!productOk || !(Array.isArray(xyz) && finite(xyz[0]) && finite(xyz[1])) || (yaw !== undefined && !finite(yaw))) {
      throw new Answer(400, WORDS.badPlace, 'bad-place');
    }
    if (id !== undefined && !isTopicName(id)) throw new Answer(400, WORDS.badPlace, 'bad-place');
    const turn = finite(yaw) ? yaw : 0;

    // An object of the catalog is an item: a box of its own size (bundle.json's dimensions), else
    // 0.2 m. Asked before the scene is read: from reading it to setScene nothing may wait, or two
    // places at once (or a record opened meanwhile) would write over each other
    const moving = id !== undefined && hub.scene().devices.some((d) => d.id === id);
    let kind = listedKinds.get(product);
    let bundle: Json | null = null;
    if (!moving && kind !== 'machine') {
      try { bundle = await bundleJsonOf(product); } catch { bundle = null; }
      kind ??= bundle?.kind === 'object' ? 'object' : 'machine';
    }

    const scene = hub.scene();
    const devices = [...scene.devices];
    const names = { ...scene.names };

    const at = id === undefined ? -1 : devices.findIndex((d) => d.id === id);
    if (at >= 0) {
      // Placed again: moved and turned, keeping its height, roll and pitch
      const held = devices[at];
      const z = finite(held.pose?.xyz?.[2]) ? held.pose!.xyz[2] : 0;
      const rpy = held.pose?.rpy ?? [0, 0, 0];
      devices[at] = { ...held, pose: { xyz: [xyz[0], xyz[1], z], rpy: [rpy[0], rpy[1], turn] } };
      hub.setScene({ devices });
      res.json({ device: devices[at] });
      return;
    }

    const taken = (name: string) => devices.some((d) => d.id === name) || Object.hasOwn(names, name);
    let newId: string;
    if (id !== undefined) {
      if (taken(id)) throw new Answer(409, WORDS.idTaken, 'id-taken');
      newId = id;
    } else {
      const stem = deviceStem(product);
      let n = 1;
      while (taken(`${stem}-${n}`)) n += 1;
      newId = `${stem}-${n}`;
    }

    // A box is drawn centred on its pose (PS.com devices/view.js): half its height up, it stands on the floor
    const sizeM = kind === 'object' ? dimensionsOf(bundle) ?? [0.2, 0.2, 0.2] : null;
    const device: Device = {
      id: newId, product, owner: 'viewer', parent: 'site',
      pose: { xyz: [xyz[0], xyz[1], sizeM ? sizeM[2] / 2 : 0], rpy: [0, 0, turn] },
      ...(sizeM ? { type: 'item', shape: { sizeM } } : {}),
    };
    devices.push(device);
    names[newId] = newId;
    hub.setScene({ devices, names });
    res.json({ device });
  }));

  app.post(`${P}/scene/remove`, write, jsonBody, handle((req, res) => {
    const { id } = req.body;
    const scene = hub.scene();
    if (typeof id !== 'string' || !scene.devices.some((d) => d.id === id)) throw new Answer(404, WORDS.noDevice, 'no-device');
    const drop = (table: Record<string, string> = {}) => Object.fromEntries(Object.entries(table).filter(([, to]) => to !== id));
    const streamNames = drop(scene.streamNames);
    hub.setScene({
      devices: scene.devices.filter((d) => d.id !== id),
      names: drop(scene.names),
      streamNames: Object.keys(streamNames).length ? streamNames : undefined,
    });
    res.json({ removed: id });
  }));

  // ---- robots ----

  app.get(`${P}/machines`, read, handle(async (req, res) => {
    const { machines, offline } = await listMachines({ ...catalog, ...roots, token: hub.client.bearer() });
    for (const row of machines) listedKinds.set(row.ref, row.kind);
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
      res.set('Cache-Control', 'private, max-age=86400'); // a catalog version never changes
      res.type(got.contentType).send(got.bytes);
      return;
    }
    const file = serveBundleFile(source, rest, roots);
    if (!file) throw new Answer(404, WORDS.noProduct, 'not-found');
    res.sendFile(file, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-cache' } });
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

  app.post(`${P}/stream/play`, write, jsonBody, handle(async (req, res) => {
    const { record, ref, file, loop, speed } = req.body;
    let source: string;
    let played: Json;
    if (typeof ref === 'string' && ref) {
      let got;
      try {
        got = await hub.client.openRecord(ref);
      } catch (e) {
        hub.refreshStatus(); // a token PS.com refused is forgotten
        if (e instanceof Offline) throw new Answer(503, WORDS.offline, 'offline');
        if (e instanceof SignIn) throw new Answer(401, WORDS.signIn, 'sign-in');
        if (e instanceof Refused && e.status === 404) throw new Answer(404, `${WORDS.notFound}（${ref}）`, 'not-found');
        if (e instanceof Refused || e instanceof TypeError) throw new Answer(400, e instanceof Refused && e.message !== e.code ? e.message : WORDS.noRecord, e instanceof Refused ? e.code : 'bad-ref');
        throw e;
      }
      const base = ref.split(':')[0];
      hub.open(got.record, { ref: base, version: got.version, latest: got.latest, own: got.own, record: got.record });
      source = `${base}:${got.version}`;
      played = got.record;
    } else if (isObject(record)) {
      source = typeof file === 'string' && file ? file : 'record';
      hub.open(record, { file: source, record });
      played = record;
    } else {
      throw new Answer(400, WORDS.noRecord, 'no-record');
    }
    const result = hub.play(played, { loop: loop === true, speed: finite(speed) ? speed : undefined, source });
    res.json({ source, ...result, status: hub.status() });
  }));

  app.post(`${P}/stream/stop`, write, handle((req, res) => { hub.stop(); res.json({ status: hub.status() }); }));
  app.post(`${P}/stream/clear`, write, handle((req, res) => { hub.clearStream(); res.json({ status: hub.status() }); }));

  // ---- saving ----

  /**
   * What a save writes: over the opened record (its states are in the stream on its own time, so
   * what the stream did not change stays as it was), else the stream as a new record.
   */
  function recordToSave(opened: Opened | null, title: string | undefined, basedOn: boolean): { record: Json; skipped: string[] } {
    const scene = hub.scene();
    const buffer = hub.streamBuffer();
    const built = messagesToRecord(scene, buffer, { title });
    if (!opened) return built;
    const record = mergeStreamInto(opened.record, scene, buffer);
    if (title) record.name = title;
    if (basedOn && 'ref' in opened) record.basedOn = `${opened.ref}:${opened.version}`;
    return { record, skipped: built.skipped };
  }

  app.post(`${P}/record/save`, write, jsonBody, handle(async (req, res) => {
    const { mode, name, title } = req.body;
    const words = typeof title === 'string' && title.trim() ? title.trim() : undefined;
    if (mode === 'new' && (typeof name !== 'string' || !NAME.test(name))) throw new Answer(400, WORDS.badName, 'bad-name');
    if (mode !== 'new' && mode !== 'over') throw new Answer(400, WORDS.notJson, 'bad-mode');
    let answer: Json;
    try {
      answer = await hub.exclusiveSave(async () => {
        // Everything is read here, inside the one save at a time: the opened record and its latest
        // version are the ones this save goes over
        const opened = hub.openedRecord();
        let target: { ref: string; mode: 'new' | 'over'; base: string | null };
        if (mode === 'new') {
          target = { ref: name, mode: 'new', base: null };
        } else {
          if (!opened || !('ref' in opened) || !opened.own) throw new Answer(409, WORDS.notOwn, 'not-own');
          target = { ref: opened.ref, mode: 'over', base: opened.latest };
        }
        const { record, skipped } = recordToSave(opened, words, mode === 'new');
        let result;
        try {
          result = await save(hub.dirs.unsent, hub.sender, record, target);
        } catch (e) {
          if (e instanceof Taken) throw new Answer(409, e.message, 'taken');
          if (e instanceof Refused) throw new Answer(e.status >= 400 && e.status < 500 ? e.status : 400, e.message, e.code);
          throw e;
        } finally {
          hub.refreshStatus();
        }
        // The saved record is the opened one, unless another was opened while this one was saved
        if (result.saved && hub.openedRecord() === opened) {
          hub.setOpened({ ref: result.ref, version: result.version, latest: result.version, own: true, record });
        }
        return { ...result, skipped };
      });
    } catch (e) {
      if (e instanceof Busy) throw new Answer(409, WORDS.busy, 'busy');
      throw e;
    }
    res.json(answer);
  }));

  app.post(`${P}/record/export`, write, jsonBody, handle((req, res) => {
    const { name, title } = req.body;
    const stem = typeof name === 'string' && NAME.test(name) ? name : 'record';
    const words = typeof title === 'string' && title.trim() ? title.trim() : undefined;
    const { record } = recordToSave(hub.openedRecord(), words, false);
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
      res.json({ file, name: fileName });
      return;
    }
    throw new Error('no free export name');
  }));

  app.post(`${P}/unsent/send`, write, handle(async (req, res) => { res.json(await hub.sendUnsent()); }));

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
