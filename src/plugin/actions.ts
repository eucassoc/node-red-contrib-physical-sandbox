/**
 * What the pane and the agent both do to the scene, the stream and the records, in one place: the
 * routes (routes.ts) answer the pane with these and the MCP tools (tools/*.ts) call them in
 * process, so a robot placed, a record opened or a save goes by the same rules either way.
 *
 * A refusal is an `Answer`: the HTTP status the route gives it, the words for the person (案内文調)
 * and a reason code for the pane (and the agent).
 *
 * The catalog's manifests and bundle.json files are kept in a small cache that the bundle routes
 * share, and the kind of each robot of the last listing (machine or object) is noted for placing it.
 */
import { deviceStem, parseRef } from '../pscom/catalog-client.js';
import { isTopicName } from '../pscom/state.js';
import type { Device } from '../core/stream.js';
import { defaultCacheRoot, readBundleJson, type MachineRow } from '../core/machines.js';
import { Offline, Refused, SignIn, Taken } from '../core/pscom-client.js';
import { save, type SaveResult } from '../core/unsent.js';
import { Busy, type Hub, type Status } from './hub.js';

type Json = Record<string, any>;
type FetchLike = (url: string, init?: any) => Promise<any>;

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
  noUnsent: 'その名前の PS.com 未保存の記録はありません',
  badSite: '現地の名前が正しくありません（英数字など 1〜80 文字で、/ + # は使えません）',
};

/** A catalog name (pscom-client.ts NAME). */
export const NAME = /^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$/;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** An answer other than 200, with the words for the person and a reason code for the pane. */
export class Answer extends Error {
  constructor(readonly status: number, message: string, readonly reason: string, readonly extra: Json = {}) { super(message); }
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

export interface ActionOptions {
  cacheRoot?: string;
  fetchImpl?: FetchLike;
}

export interface Actions {
  /** Where robots are found on this machine. */
  readonly roots: { cacheRoot: string; localDirs: string[] };
  /** The catalog and how it is reached. */
  readonly catalog: { catalogBase: string; fetchImpl: FetchLike };
  /** A fetch for one catalog ref, through the cache. */
  catalogFetchFor(ref: string, token: string | undefined): FetchLike;
  /** The kinds of a listing's robots, for placing them later. */
  noteListed(rows: MachineRow[]): void;
  /** Place a robot or a box (`{id?, product, xyz, yaw?}`), or move one placed already. */
  place(body: Json): Promise<{ device: Device }>;
  /** Take a device off the scene (`{id}`). */
  remove(body: Json): { removed: string };
  /** Take another site's messages (`{site}`), or the plugin's own with none. */
  setSite(body: Json): { site: string; status: Status };
  /**
   * Open a record and play it (`{record, file?}`, `{ref}` from PS.com, or `{replay: true}`, the
   * opened one again from the hub's copy), with `loop` and `speed`.
   */
  play(body: Json): Promise<{ source: string; count: number; duration: number; status: Status }>;
  /**
   * Save the stream (`{mode: 'new'|'over', name?, title?}`) as hub.recordNow writes it: one save at a
   * time, kept when PS.com cannot be reached. Saved, it is the opened record and the stream is re-based on it.
   */
  save(body: Json): Promise<SaveResult & { skipped: string[] }>;
  /** 「記録を空にする」 (the pane's button and ps_stream_clear): hub.clearStream, after a save under way. */
  clear(): Promise<{ status: Status }>;
}

export function createActions(hub: Hub, opts: ActionOptions = {}): Actions {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const roots = { cacheRoot: opts.cacheRoot ?? defaultCacheRoot(), localDirs: hub.settings.localMachineDirs };
  const catalog = { catalogBase: hub.settings.catalogBase, fetchImpl };
  const catalogCache = new CatalogCache(fetchImpl);
  /** The kind of each robot of the last listing (machine or object), for placing it. */
  const listedKinds = new Map<string, MachineRow['kind']>();

  async function bundleJsonOf(product: string): Promise<Json | null> {
    const token = hub.client.bearer();
    return readBundleJson(product, { ...catalog, ...roots, token }, (ref) => catalogCache.fetchFor(ref, token));
  }

  async function place(body: Json): Promise<{ device: Device }> {
    const { id, product, xyz, yaw } = body;
    const productOk = typeof product === 'string' && (parseRef(product) !== null || (isTopicName(product) && !product.includes(':')));
    if (!productOk || !(Array.isArray(xyz) && finite(xyz[0]) && finite(xyz[1])) || (yaw !== undefined && !finite(yaw))) {
      throw new Answer(400, WORDS.badPlace, 'bad-place');
    }
    if (id !== undefined && !isTopicName(id)) throw new Answer(400, WORDS.badPlace, 'bad-place');
    const turn = finite(yaw) ? yaw : 0;

    // An object of the catalog is an item: a box of its own size (bundle.json's dimensions), else
    // 0.2 m; a robot found nowhere is refused. Asked before the scene is read: from reading it to
    // setScene nothing may wait, or two places at once (or a record opened meanwhile) would write
    // over each other
    const moving = id !== undefined && hub.scene().devices.some((d) => d.id === id);
    let kind = listedKinds.get(product);
    let bundle: Json | null = null;
    if (!moving && kind !== 'machine') {
      try { bundle = await bundleJsonOf(product); } catch { bundle = null; }
      // A robot the listing did not have and that resolves nowhere could never be drawn
      if (!bundle && kind === undefined) throw new Answer(404, WORDS.noProduct, 'no-product');
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
      return { device: devices[at] };
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
    return { device };
  }

  function remove(body: Json): { removed: string } {
    const { id } = body;
    const scene = hub.scene();
    if (typeof id !== 'string' || !scene.devices.some((d) => d.id === id)) throw new Answer(404, WORDS.noDevice, 'no-device');
    const drop = (table: Record<string, string> = {}) => Object.fromEntries(Object.entries(table).filter(([, to]) => to !== id));
    const streamNames = drop(scene.streamNames);
    hub.setScene({
      devices: scene.devices.filter((d) => d.id !== id),
      names: drop(scene.names),
      streamNames: Object.keys(streamNames).length ? streamNames : undefined,
    });
    return { removed: id };
  }

  function setSite(body: Json): { site: string; status: Status } {
    const { site } = body;
    if (site !== undefined && site !== null && !isTopicName(site)) throw new Answer(400, WORDS.badSite, 'bad-site');
    const scene = hub.setSite(typeof site === 'string' ? site : undefined);
    return { site: scene.site, status: hub.status() };
  }

  async function play(body: Json): Promise<{ source: string; count: number; duration: number; status: Status }> {
    const { record, ref, file, loop, speed, replay } = body;
    let source: string;
    let played: Json;
    if (replay === true) {
      // 再生・頭へ: the record already open, from the hub's copy (not opened again: the stream, the
      // live recording and the opened record stay as they are, and PS.com is not asked)
      const opened = hub.openedRecord();
      if (!opened) throw new Answer(400, WORDS.noRecord, 'no-record');
      source = 'ref' in opened ? `${opened.ref}:${opened.version}` : opened.file;
      played = opened.record;
    } else if (typeof ref === 'string' && ref) {
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
    return { source, ...result, status: hub.status() };
  }

  async function saveStream(body: Json): Promise<SaveResult & { skipped: string[] }> {
    const { mode, name, title } = body;
    const words = typeof title === 'string' && title.trim() ? title.trim() : undefined;
    if (mode === 'new' && (typeof name !== 'string' || !NAME.test(name))) throw new Answer(400, WORDS.badName, 'bad-name');
    if (mode !== 'new' && mode !== 'over') throw new Answer(400, WORDS.notJson, 'bad-mode');
    try {
      return await hub.exclusiveSave(async () => {
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
        const { record, skipped } = hub.recordNow({ title: words, basedOn: mode === 'new' });
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
        // The saved record is the opened one and the stream is re-based on it, unless another was
        // opened while this one was saved
        if (result.saved && hub.openedRecord() === opened) {
          hub.rebase({ ref: result.ref, version: result.version, latest: result.version, own: true, record });
        }
        if (result.saved) hub.noteSent(result.unsentSend?.sent);
        return { ...result, skipped };
      });
    } catch (e) {
      if (e instanceof Busy) throw new Answer(409, WORDS.busy, 'busy');
      throw e;
    }
  }

  return {
    roots,
    catalog,
    catalogFetchFor: (ref, token) => catalogCache.fetchFor(ref, token),
    noteListed: (rows) => { for (const row of rows) listedKinds.set(row.ref, row.kind); },
    place,
    remove,
    setSite,
    play,
    save: saveStream,
    clear: () => hub.afterSaves(() => { hub.clearStream(); return { status: hub.status() }; }),
  };
}
