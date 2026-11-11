/**
 * Robots from three places: the PS.com catalog, the psbx cache and local folders.
 *
 * - `listMachines`: every robot the pane can place, tagged with where it came from.
 * - `resolveBundle`: where a product's drawing (bundle.json) and meshes are served from, as plain
 *   data (`{source, bundleUrl, meshBase}`) of Node-RED-relative URLs; the browser never talks to
 *   PS.com for bundle files. A bare name means a LOCAL robot first, then the psbx cache's
 *   `physical-sandbox/<name>`; it never goes to the catalog. `handle/name[:version]` is the cache
 *   when it holds that version, else the catalog.
 * - `fetchCatalogBundleFile`: the catalog side of the bundle route (private robots need the token).
 * - `serveBundleFile`: the path guard behind `GET /physical-sandbox/bundles/:source/*`. It names a
 *   file on disk only when it is bundle.json or a mesh/texture (`.bin`, `.png`, `.jpg`, `.jpeg`,
 *   `.webp`) that bundle.json lists under assets/, and only when the real path (symlinks resolved)
 *   stays inside that bundle's folder.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { parseRef } from '../pscom/catalog-client.js';

export type MachineSource = 'catalog' | 'cache' | 'local';
export interface MachineRow { ref: string; label: string; source: MachineSource; kind: 'machine' | 'object' }

type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean; status: number; json: () => Promise<any>;
  arrayBuffer?: () => Promise<ArrayBuffer>; headers?: { get(name: string): string | null };
}>;
export interface Roots { cacheRoot: string; localDirs: string[] }
export interface ListOptions extends Roots { catalogBase: string; fetchImpl: FetchLike; token?: string; timeoutMs?: number }
export interface ResolveOptions extends Roots { catalogBase: string; fetchImpl: FetchLike; token?: string; timeoutMs?: number }
/** Plain data: a mesh or texture named `rel` in bundle.json is at `meshBase + encodePath(rel)`. */
export interface Resolved { source: MachineSource; bundleUrl: string; meshBase: string }
export interface CatalogFileOptions { catalogBase: string; fetchImpl: FetchLike; token?: string; timeoutMs?: number }

/** The URL prefix of the bundle route. */
export const BUNDLE_ROUTE = '/physical-sandbox/bundles';
/** In a local source path, this stands for "the configured folder itself holds bundle.json". */
const SELF = '@';

/** `$PS_CACHE_DIR` or `~/.cache/physical-sandbox`, the same place psbx uses. */
export function defaultCacheRoot(): string {
  return process.env.PS_CACHE_DIR || join(homedir(), '.cache', 'physical-sandbox');
}

const readJson = (file: string): any => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
const subdirs = (p: string): string[] => {
  // names starting with `.` are skipped: psbx downloads into `<name>/.<version>.partial-<pid>`
  try { return readdirSync(p, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name).sort(); }
  catch { return []; }
};
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

interface LocalEntry { name: string; slot: string; dir: string }

/** Each `<dir>/<name>/bundle.json` and `<dir>/bundle.json` of the configured folders. */
function localEntries(localDirs: string[]): LocalEntry[] {
  const out: LocalEntry[] = [];
  localDirs.forEach((dir, i) => {
    if (isFile(join(dir, 'bundle.json'))) out.push({ name: baseName(dir), slot: `${i}/${SELF}`, dir });
    for (const sub of subdirs(dir)) {
      if (sub === SELF) continue;
      if (isFile(join(dir, sub, 'bundle.json'))) out.push({ name: sub, slot: `${i}/${sub}`, dir: join(dir, sub) });
    }
  });
  return out;
}

interface CacheEntry { handle: string; name: string; version: string; dir: string }

function cacheEntries(cacheRoot: string): CacheEntry[] {
  const out: CacheEntry[] = [];
  const base = join(cacheRoot, 'catalog');
  for (const handle of subdirs(base)) for (const name of subdirs(join(base, handle))) for (const version of subdirs(join(base, handle, name))) {
    const dir = join(base, handle, name, version);
    if (isFile(join(dir, 'bundle.json'))) out.push({ handle, name, version, dir });
  }
  return out;
}

/** The version a `latest` marker names, or null. */
function latestMarker(cacheRoot: string, handle: string, name: string): string | null {
  try {
    const v = readFileSync(join(cacheRoot, 'catalog', handle, name, 'latest'), 'utf8').trim();
    return v || null;
  } catch { return null; }
}

const withTimeout = (init: any, ms = 5000): any => ({ ...init, signal: AbortSignal.timeout(ms) });

const kindOf = (value: unknown): 'machine' | 'object' => (value === 'object' ? 'object' : 'machine');

export async function listMachines(opts: ListOptions): Promise<{ machines: MachineRow[]; offline: boolean }> {
  const machines: MachineRow[] = [];
  let offline = false;
  const seen = new Set<string>();

  const queries: { kind: string; token?: string }[] = [{ kind: 'machine' }, { kind: 'object' }];
  if (opts.token) queries.push({ kind: 'machine', token: opts.token }, { kind: 'object', token: opts.token });
  const base = String(opts.catalogBase ?? '').replace(/\/+$/, '');
  const answers = await Promise.all(queries.map(async (q) => {
    const url = `${base}/api/catalog/search?q=&kind=${q.kind}${q.token ? '&owner=me' : ''}&limit=500`;
    try {
      const res = await opts.fetchImpl(url, withTimeout(q.token ? { headers: { Authorization: `Bearer ${q.token}` } } : {}, opts.timeoutMs));
      if (res.status === 401) return { q, items: [] as any[] };
      if (!res.ok) { offline = true; return { q, items: [] as any[] }; }
      const body = await res.json();
      return { q, items: Array.isArray(body?.items) ? body.items : [] };
    } catch { offline = true; return { q, items: [] as any[] }; }
  }));
  for (const { q, items } of answers) {
    for (const item of items) {
      const version = item?.latest_version ?? item?.version;
      if (typeof item?.handle !== 'string' || typeof item?.name !== 'string' || version == null) continue;
      const ref = `${item.handle}/${item.name}:${version}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      machines.push({ ref, label: item.display?.ja || item.display?.en || item.name, source: 'catalog', kind: kindOf(item.kind ?? q.kind) });
    }
  }

  for (const c of cacheEntries(opts.cacheRoot)) {
    const bundle = readJson(join(c.dir, 'bundle.json'));
    const manifest = readJson(join(c.dir, 'manifest.json'));
    machines.push({
      ref: `${c.handle}/${c.name}:${c.version}`,
      label: manifest?.display?.ja || manifest?.display?.en || bundle?.displayName || c.name,
      source: 'cache', kind: kindOf(manifest?.kind ?? bundle?.kind),
    });
  }

  for (const l of localEntries(opts.localDirs)) {
    const bundle = readJson(join(l.dir, 'bundle.json'));
    machines.push({ ref: l.name, label: bundle?.displayName || l.name, source: 'local', kind: kindOf(bundle?.kind) });
  }
  return { machines, offline };
}

/** Whether a bare product name is a robot of a configured local folder (one PS.com does not have). */
export function isLocalMachine(name: string, localDirs: string[]): boolean {
  return typeof name === 'string' && !name.includes('/') && localEntries(localDirs).some((l) => l.name === name);
}

/**
 * Where a row of `listMachines` is served from, without asking the catalog again (the listing
 * found it): a local row from its folder, a cache row from the cache, a catalog row through the
 * catalog route. Null when the row's place is gone meanwhile.
 */
export function resolveListed(row: MachineRow, roots: Roots): Resolved | null {
  if (row.source === 'local') {
    const local = localEntries(roots.localDirs).find((l) => l.name === row.ref);
    return local ? resolvedAt('local', local.slot) : null;
  }
  const parts = parseRef(row.ref);
  if (!parts || parts.version === 'latest') return null;
  return resolvedAt(row.source, `${parts.handle}/${parts.name}/${parts.version}`);
}

/** A relative path to be put in a URL: no empty, `.` or `..` part, no backslash or NUL, not absolute. */
function urlPath(rel: string): string {
  const parts = typeof rel === 'string' ? rel.split('/') : [];
  if (parts.length === 0 || parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) {
    throw new Error(`${JSON.stringify(rel)} is not a file path`);
  }
  return parts.map(encodeURIComponent).join('/');
}

const resolvedAt = (source: MachineSource, path: string): Resolved => {
  const prefix = `${BUNDLE_ROUTE}/${source}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return { source, bundleUrl: `${prefix}/bundle.json`, meshBase: `${prefix}/` };
};

/** The URL of a mesh or texture of a resolved bundle (refuses empty, `.`, `..` parts). */
export const meshUrlOf = (resolved: Resolved, rel: string): string => resolved.meshBase + urlPath(rel);

/**
 * Where a product's bundle is served from. Throws when a bare name matches nothing local or cached
 * (a bare name never goes to the catalog), when the product is not a name or a reference, or when
 * the catalog has no such robot (or it is private and the token is missing).
 */
export async function resolveBundle(product: string, opts: ResolveOptions): Promise<Resolved> {
  if (typeof product !== 'string' || product === '') throw new Error('no product');
  if (!product.includes('/')) {
    const local = localEntries(opts.localDirs).find((l) => l.name === product);
    if (local) return resolvedAt('local', local.slot);
    const version = latestMarker(opts.cacheRoot, 'physical-sandbox', product);
    if (version && isFile(join(opts.cacheRoot, 'catalog', 'physical-sandbox', product, version, 'bundle.json'))) {
      return resolvedAt('cache', `physical-sandbox/${product}/${version}`);
    }
    throw new Error(`${product}: no local folder or cached robot of that name`);
  }
  const parts = parseRef(product);
  if (!parts) throw new Error(`${product} is not a catalog reference`);
  const version = parts.version === 'latest' ? latestMarker(opts.cacheRoot, parts.handle, parts.name) : parts.version;
  if (version && isFile(join(opts.cacheRoot, 'catalog', parts.handle, parts.name, version, 'bundle.json'))) {
    return resolvedAt('cache', `${parts.handle}/${parts.name}/${version}`);
  }
  await catalogManifest(parts, opts); // throws when absent or private without a token
  return resolvedAt('catalog', `${parts.handle}/${parts.name}/${parts.version}`);
}

const authInit = (opts: CatalogFileOptions): any => withTimeout(opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : {}, opts.timeoutMs);
const catalogRoot = (opts: CatalogFileOptions, p: { handle: string; name: string; version: string }): string =>
  `${String(opts.catalogBase ?? '').replace(/\/+$/, '')}/api/catalog/${p.handle}/${p.name}/${encodeURIComponent(p.version)}`;

/** The manifest's bundle path (`bundle.json` or `dir/bundle.json`), lexically checked. */
async function catalogManifest(p: { handle: string; name: string; version: string }, opts: CatalogFileOptions): Promise<string> {
  const res = await opts.fetchImpl(`${catalogRoot(opts, p)}/manifest`, authInit(opts));
  if (!res.ok) throw new Error(`${p.handle}/${p.name}: the catalog has no such robot (${res.status})`);
  const manifest = await res.json();
  const bundle = manifest?.bundle;
  if (typeof bundle !== 'string' || bundle.split('/').some((x) => x === '' || x === '.' || x === '..' || x.includes('\\') || x.includes('\0'))) {
    throw new Error(`${p.handle}/${p.name}: the manifest names no usable bundle`);
  }
  return bundle;
}

/** The type a bundle file is served with: bundle.json, a picture, else bytes (a mesh). */
export const contentTypeOf = (file: string): string => {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return ({ json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext] ?? 'application/octet-stream';
};

/**
 * The catalog side of the bundle route: `ref` is `<handle>/<name>/<version>` (the route's path
 * before the file), `relPath` the file. Same allowlist as `serveBundleFile` (bundle.json and the
 * `assets/` files it names, lexically checked). The files are fetched from PS.com with the bearer
 * token when there is one, so private robots load. Null for anything refused or missing.
 */
export async function fetchCatalogBundleFile(ref: string, relPath: string, opts: CatalogFileOptions): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    if (typeof ref !== 'string' || typeof relPath !== 'string' || relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/')) return null;
    const seg = ref.split('/');
    if (seg.length !== 3) return null;
    const parts = parseRef(`${seg[0]}/${seg[1]}:${seg[2]}`);
    if (!parts || seg[2] === '' ) return null;
    const rel = relPath.split('/');
    if (rel.some((x) => x === '' || x === '.' || x === '..')) return null;
    const bundlePath = await catalogManifest(parts, opts);
    const folder = bundlePath.includes('/') ? bundlePath.slice(0, bundlePath.lastIndexOf('/') + 1) : '';
    const fetchFile = async (path: string) => {
      const res = await opts.fetchImpl(`${catalogRoot(opts, parts)}/files/${path.split('/').map(encodeURIComponent).join('/')}`, authInit(opts));
      return res.ok && res.arrayBuffer ? { res, buffer: Buffer.from(await res.arrayBuffer()) } : null;
    };
    const bundleFile = await fetchFile(bundlePath);
    if (!bundleFile) return null;
    let wanted = bundlePath;
    if (relPath !== 'bundle.json') {
      const asset = assetPath(relPath);
      let bundle: any = null;
      try { bundle = JSON.parse(bundleFile.buffer.toString('utf8')); } catch { return null; }
      if (!asset || !namedFiles(bundle).has(asset)) return null;
      wanted = folder + asset;
    }
    const got = wanted === bundlePath ? bundleFile : await fetchFile(wanted);
    if (!got) return null;
    return { bytes: got.buffer, contentType: contentTypeOf(relPath) };
  } catch { return null; }
}

/** A resolved bundle's path after `/bundles/<source>/` (decoded): `<handle>/<name>/<version>`, or `<folder index>/<name or @>` for a local one. */
export const bundlePathOf = (r: Resolved): string =>
  r.bundleUrl.slice(`${BUNDLE_ROUTE}/${r.source}/`.length, -'/bundle.json'.length).split('/').map(decodeURIComponent).join('/');

/**
 * A product's bundle.json, parsed, from where `resolveBundle` finds it (and throwing as it does);
 * null when the file cannot be had. A catalog robot's files are fetched with `catalogFetch(ref)`
 * when given (the routes keep a cache), else with `opts.fetchImpl`.
 */
export async function readBundleJson(product: string, opts: ResolveOptions, catalogFetch?: (ref: string) => FetchLike): Promise<any | null> {
  const r = await resolveBundle(product, opts);
  const path = bundlePathOf(r);
  if (r.source === 'catalog') {
    const got = await fetchCatalogBundleFile(path, 'bundle.json', { ...opts, fetchImpl: catalogFetch?.(path) ?? opts.fetchImpl });
    return got ? JSON.parse(got.bytes.toString('utf8')) : null;
  }
  const file = serveBundleFile(r.source, `${path}/bundle.json`, opts);
  return file ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/**
 * The catalog manifest's `profile` of a product (its chains, among others): from the psbx cache's
 * manifest.json or from the catalog. Null for a local robot, or when there is none.
 */
export async function readProfile(product: string, opts: ResolveOptions): Promise<any | null> {
  const r = await resolveBundle(product, opts);
  const path = bundlePathOf(r);
  let manifest: any = null;
  if (r.source === 'cache') {
    const seg = path.split('/');
    const dir = join(opts.cacheRoot, 'catalog', ...seg);
    const realRoot = real(join(opts.cacheRoot, 'catalog'));
    const file = real(join(dir, 'manifest.json'));
    if (seg.length === 3 && realRoot && file && inside(realRoot, file)) manifest = readJson(file);
  } else if (r.source === 'catalog') {
    const [handle, name, version] = path.split('/');
    try {
      const res = await opts.fetchImpl(`${catalogRoot(opts, { handle, name, version })}/manifest`, authInit(opts));
      if (res.ok) manifest = await res.json();
    } catch { manifest = null; }
  }
  return manifest && typeof manifest.profile === 'object' && manifest.profile !== null ? manifest.profile : null;
}

/** `real` is `root` or inside it, after both have had their symlinks resolved. */
const inside = (root: string, real: string): boolean => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/**
 * What a bundle's assets may be: a mesh (`.bin`, robot-build.js's format) or a texture picture.
 * Nothing else is served, so a bundle cannot have a page or a script served from Node-RED's origin.
 */
const ASSET_EXTENSION = /\.(bin|png|jpe?g|webp)$/i;

/** A path as bundle.json may name it: `assets/...` of an ASSET_EXTENSION, relative, no `.`/`..`/empty/backslash/NUL part. */
function assetPath(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel.startsWith('assets/') || !ASSET_EXTENSION.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return null;
  return rel;
}

/** The files a bundle names: each visual's mesh and texture. */
function namedFiles(bundle: any): Set<string> {
  const out = new Set<string>();
  const links = bundle && typeof bundle.links === 'object' && bundle.links ? bundle.links : {};
  for (const link of Object.values<any>(links)) {
    for (const visual of Array.isArray(link?.visuals) ? link.visuals : []) {
      for (const key of ['mesh', 'texture']) {
        const p = assetPath(visual?.[key]);
        if (p) out.add(p);
      }
    }
  }
  return out;
}

/**
 * The absolute path of a file the route may serve, or null. `source` is `cache` (relPath
 * `<handle>/<name>/<version>/<file>`) or `local` (`<folder index>/<name or @>/<file>`; `@` is the
 * configured folder itself). Only `bundle.json` and the `assets/` files it names are served, and
 * only when their real paths stay inside the bundle's own folder, which itself must be inside the
 * configured root. Anything else (`..`, absolute paths, backslashes, symlinks out) gives null.
 */
export function serveBundleFile(source: string, relPath: string, roots: Roots): string | null {
  if (typeof relPath !== 'string' || relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/')) return null;
  const parts = relPath.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  let rootDir: string; let bundleDir: string; let file: string;
  if (source === 'cache') {
    if (parts.length < 4) return null;
    rootDir = join(roots.cacheRoot, 'catalog');
    bundleDir = join(rootDir, parts[0], parts[1], parts[2]);
    file = parts.slice(3).join('/');
  } else if (source === 'local') {
    if (parts.length < 3 || !/^\d+$/.test(parts[0])) return null;
    const configured = roots.localDirs[Number(parts[0])];
    if (configured === undefined) return null;
    rootDir = configured;
    bundleDir = parts[1] === SELF ? configured : join(configured, parts[1]);
    file = parts.slice(2).join('/');
  } else return null;

  const realRoot = real(rootDir); const realBundle = real(bundleDir);
  if (!realRoot || !realBundle || !inside(realRoot, realBundle) || !isDir(realBundle)) return null;
  const bundleFile = real(join(realBundle, 'bundle.json'));
  if (!bundleFile || !inside(realBundle, bundleFile) || !isFile(bundleFile)) return null;
  if (file !== 'bundle.json') {
    const wanted = assetPath(file);
    if (!wanted || !namedFiles(readJson(bundleFile)).has(wanted)) return null;
  }
  const target = file === 'bundle.json' ? bundleFile : real(join(realBundle, file));
  if (!target || !inside(realBundle, target) || !isFile(target)) return null;
  return target;
}

