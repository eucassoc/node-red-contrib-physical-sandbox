/**
 * Robots from three places: the PS.com catalog, the psbx cache and local folders.
 *
 * - `listMachines`: every robot the pane can place, tagged with where it came from.
 * - `resolveBundle`: where a product's drawing (bundle.json) and meshes are served from. A bare
 *   name means a LOCAL robot first, then the psbx cache's `physical-sandbox/<name>`; it never goes
 *   to the catalog. `handle/name[:version]` is the cache when it holds that version, else the catalog.
 * - `serveBundleFile`: the path guard behind `GET /physical-sandbox/bundles/:source/*`. It names a
 *   file on disk only when it is bundle.json or a mesh/texture that bundle.json lists under assets/,
 *   and only when the real path (symlinks resolved) stays inside that bundle's folder.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { bundleUrl, meshUrl, parseRef, setCatalogBase } from '../pscom/catalog-client.js';

export type MachineSource = 'catalog' | 'cache' | 'local';
export interface MachineRow { ref: string; label: string; source: MachineSource; kind: 'machine' | 'object' }

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
export interface Roots { cacheRoot: string; localDirs: string[] }
export interface ListOptions extends Roots { catalogBase: string; fetchImpl: FetchLike; token?: string }
export interface ResolveOptions extends Roots { catalogBase: string; fetchImpl: FetchLike }
export interface Resolved { bundleUrl: string; meshUrl(rel: string): string }

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
  try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort(); }
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

const kindOf = (value: unknown): 'machine' | 'object' => (value === 'object' ? 'object' : 'machine');

export async function listMachines(opts: ListOptions): Promise<{ machines: MachineRow[]; offline: boolean }> {
  const machines: MachineRow[] = [];
  let offline = false;
  const seen = new Set<string>();

  const queries: { kind: string; token?: string }[] = [{ kind: 'machine' }, { kind: 'object' }];
  if (opts.token) queries.push({ kind: 'machine', token: opts.token }, { kind: 'object', token: opts.token });
  const base = String(opts.catalogBase ?? '').replace(/\/+$/, '');
  for (const q of queries) {
    const url = `${base}/api/catalog/search?q=&kind=${q.kind}${q.token ? '&owner=me' : ''}&limit=500`;
    try {
      const res = await opts.fetchImpl(url, q.token ? { headers: { Authorization: `Bearer ${q.token}` } } : undefined);
      if (res.status === 401) continue;
      if (!res.ok) { offline = true; continue; }
      const body = await res.json();
      for (const item of Array.isArray(body?.items) ? body.items : []) {
        const version = item.latest_version ?? item.version;
        if (typeof item?.handle !== 'string' || typeof item?.name !== 'string' || version == null) continue;
        const ref = `${item.handle}/${item.name}:${version}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        machines.push({ ref, label: item.display?.ja || item.display?.en || item.name, source: 'catalog', kind: kindOf(item.kind ?? q.kind) });
      }
    } catch { offline = true; }
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

/** A relative path to be put in a URL: no empty, `.` or `..` part, no backslash or NUL, not absolute. */
function urlPath(rel: string): string {
  const parts = typeof rel === 'string' ? rel.split('/') : [];
  if (parts.length === 0 || parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) {
    throw new Error(`${JSON.stringify(rel)} is not a file path`);
  }
  return parts.map(encodeURIComponent).join('/');
}

const localResolved = (slot: string): Resolved => {
  const prefix = `${BUNDLE_ROUTE}/local/${slot.split('/').map(encodeURIComponent).join('/')}`;
  return { bundleUrl: `${prefix}/bundle.json`, meshUrl: (rel) => `${prefix}/${urlPath(rel)}` };
};
const cacheResolved = (c: { handle: string; name: string; version: string }): Resolved => {
  const prefix = `${BUNDLE_ROUTE}/cache/${[c.handle, c.name, c.version].map(encodeURIComponent).join('/')}`;
  return { bundleUrl: `${prefix}/bundle.json`, meshUrl: (rel) => `${prefix}/${urlPath(rel)}` };
};

/**
 * Where a product's bundle is served from. Throws when a bare name matches nothing local or cached
 * (a bare name never goes to the catalog), or when the product is not a name or a reference.
 */
export async function resolveBundle(product: string, opts: ResolveOptions): Promise<Resolved> {
  if (typeof product !== 'string' || product === '') throw new Error('no product');
  if (!product.includes('/')) {
    const local = localEntries(opts.localDirs).find((l) => l.name === product);
    if (local) return localResolved(local.slot);
    const version = latestMarker(opts.cacheRoot, 'physical-sandbox', product);
    if (version && isFile(join(opts.cacheRoot, 'catalog', 'physical-sandbox', product, version, 'bundle.json'))) {
      return cacheResolved({ handle: 'physical-sandbox', name: product, version });
    }
    throw new Error(`${product}: no local folder or cached robot of that name`);
  }
  const parts = parseRef(product);
  if (!parts) throw new Error(`${product} is not a catalog reference`);
  const version = parts.version === 'latest' ? latestMarker(opts.cacheRoot, parts.handle, parts.name) : parts.version;
  if (version && isFile(join(opts.cacheRoot, 'catalog', parts.handle, parts.name, version, 'bundle.json'))) {
    return cacheResolved({ handle: parts.handle, name: parts.name, version });
  }
  const refText = `${parts.handle}/${parts.name}:${parts.version}`;
  setCatalogBase(opts.catalogBase, opts.fetchImpl);
  const url = await bundleUrl(refText, opts.fetchImpl as any);
  return { bundleUrl: url, meshUrl: (rel) => meshUrl(refText, rel) };
}

/** `real` is `root` or inside it, after both have had their symlinks resolved. */
const inside = (root: string, real: string): boolean => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** A path as bundle.json may name it: `assets/...`, relative, no `.`/`..`/empty/backslash/NUL part. */
function assetPath(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel.startsWith('assets/')) return null;
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

