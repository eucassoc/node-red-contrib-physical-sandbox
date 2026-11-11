// Copied from app/src/catalog-client.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * The machine catalog, as the screen reads it: which machines there are, and where a machine's
 * drawing (its bundle) and meshes are served from.
 *
 * **A machine is named by a reference, `handle/name:version`** (`physical-sandbox/so101:1`). A
 * recording written before the catalog names a bare id (`so101`); record-upgrade.js turns that
 * into `legacyRef(id)` as it reads the recording, and that is the only place old ids are mended
 * (the server never rewrites a stored recording).
 *
 * The index has the same rows the open build's products.json had (products.js reads them), made
 * from the catalog's search answer: each item carries its latest version's manifest `product`
 * (class, mover, arm, hand, ...) and `bundle`.
 *
 * Touches neither the DOM nor three. The fetch is passed in.
 */

/** The handle the open build's machines were registered under (tools/seed-catalog.mjs). */
export const OFFICIAL_HANDLE = 'physical-sandbox';
/** The version the open build's machines were registered as. */
const LEGACY_VERSION = '1';

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,37})[a-z0-9]$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$/;
const VERSION_RE = /^[a-z0-9][a-z0-9.-]{0,31}$/;
/** A bare id of the open build (what robots/<id>/ was called). */
const LEGACY_ID = /^[a-z0-9][a-z0-9_-]*$/;

export const ref = (handle, name, version = 'latest') => `${handle}/${name}:${version}`;

/**
 * `handle/name:version` (the version may be left out, meaning 'latest') → its parts, or null for
 * anything else. The same rules as shared/catalog-names.js, which the screen cannot import.
 */
export function parseRef(text) {
  if (typeof text !== 'string') return null;
  const match = /^([^/:]+)\/([^/:]+)(?::([^/:]*))?$/.exec(text);
  if (!match) return null;
  const [, handle, name, version = 'latest'] = match;
  if (!HANDLE_RE.test(handle) || !NAME_RE.test(name)) return null;
  if (version !== 'latest' && !VERSION_RE.test(version)) return null;
  return { handle, name, version };
}

/** Whether a text is a reference (`handle/name:version`). */
export const isRef = (text) => parseRef(text) !== null;

/** An id of the open build as the catalog has it: `physical-sandbox/<id>:1`. */
export function legacyRef(id) {
  return ref(OFFICIAL_HANDLE, id, LEGACY_VERSION);
}

/** A bare id of the open build as its reference; a reference (or anything else) as it is. */
export function refOf(id) {
  return typeof id === 'string' && !id.includes('/') && LEGACY_ID.test(id) ? legacyRef(id) : id;
}

/**
 * The key the screen's own tables of poses, gaits, wheels and lifts are written under (pose.js,
 * gait.js, drive.js, lift.js): the bare id for an official machine, the reference as it is for
 * anyone else's (so another account's `g1` never walks like ours).
 */
export function machineKey(robotId) {
  const parts = parseRef(robotId);
  return parts && parts.handle === OFFICIAL_HANDLE ? parts.name : robotId;
}

/** A short stem for the ids of placed devices (`so101` → `so101-1`): the item's name. */
export function deviceStem(productId) {
  return parseRef(productId)?.name ?? productId;
}

/** Reference → the bundle path its manifest names. Filled by loadMachineIndex and bundleUrl. */
const bundles = new Map();

/** Forget what was learnt of bundles (the tests). */
export function forgetBundles() {
  bundles.clear();
}

/**
 * A file path inside a version, encoded. **Refused** (throws) when it is empty or has an empty, `.`
 * or `..` part: bundle and mesh paths come from uploaded JSON, and `encodeURIComponent('..')` is
 * still `..`, which would climb out of the version's files.
 */
function encodePath(path) {
  const parts = typeof path === 'string' ? path.split('/') : [];
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${JSON.stringify(path)} is not a file path`);
  }
  return parts.map(encodeURIComponent).join('/');
}
// PSCOM-SEAM-BEGIN
/** Where the catalog lives. Empty means the page's own origin (PS.com); the pane sets its Node-RED route. */
let catalogBase = '';
/** The fetch used when a caller passes none. */
let defaultFetch = (url) => fetch(url);
/**
 * Point the catalog calls at another place: every URL becomes `${base}/api/catalog/...`.
 * @param {string} base no trailing slash needed
 * @param {(url: string) => Promise<any>} [fetchImpl] used when a caller passes no fetch
 */
export function setCatalogBase(base, fetchImpl) {
  catalogBase = String(base ?? '').replace(/\/+$/, '');
  defaultFetch = fetchImpl ?? ((url) => fetch(url));
}
// PSCOM-SEAM-END
// PSCOM-SEAM-WAS const rootOf = ({ handle, name, version }) => `/api/catalog/${handle}/${name}/${encodeURIComponent(version)}`;
const rootOf = ({ handle, name, version }) => `${catalogBase}/api/catalog/${handle}/${name}/${encodeURIComponent(version)}`; // PSCOM-SEAM-NEW

function partsOrThrow(machine) {
  const parts = parseRef(machine);
  if (!parts) throw new Error(`${machine} is not a catalog reference`);
  return parts;
}

/**
 * Where a machine's bundle (the drawing robot.js reads) is served. The manifest is read the first
 * time a machine is asked for that the index did not already tell about, and kept.
 *
 * @param {string} machine a reference
 * @param {(url: string) => Promise<{ ok: boolean, json: () => Promise<any> }>} [fetchImpl]
 * @returns {Promise<string>}
 */
// PSCOM-SEAM-WAS export async function bundleUrl(machine, fetchImpl = (url) => fetch(url)) {
export async function bundleUrl(machine, fetchImpl = (url) => defaultFetch(url)) { // PSCOM-SEAM-NEW
  const parts = partsOrThrow(machine);
  if (!bundles.has(machine)) {
    const response = await fetchImpl(`${rootOf(parts)}/manifest`);
    if (!response.ok) throw new Error(`${machine}: the catalog has no such machine (${response.status})`);
    const manifest = await response.json();
    if (typeof manifest?.bundle !== 'string') throw new Error(`${machine}: the manifest names no bundle`);
    encodePath(manifest.bundle);
    bundles.set(machine, manifest.bundle);
  }
  return `${rootOf(parts)}/files/${encodePath(bundles.get(machine))}`;
}

/**
 * Where a file the bundle names (a mesh, a texture) is served. **Relative to the bundle's folder**,
 * as the open build had it relative to meshes/<id>/. Call bundleUrl first; until then the bundle
 * is taken to be at the version's top.
 */
export function meshUrl(machine, relative) {
  const parts = partsOrThrow(machine);
  const bundle = bundles.get(machine) ?? '';
  const folder = bundle.includes('/') ? bundle.slice(0, bundle.lastIndexOf('/') + 1) : '';
  return `${rootOf(parts)}/files/${encodePath(folder + relative)}`;
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One search item as a row of the open build's products.json (`hands[]` for an end effector). */
function rowOf(item) {
  const id = ref(item.handle, item.name, item.version ?? item.latest_version);
  const product = isPlain(item.product) ? item.product : {};
  const common = {
    id,
    displayName: item.display,
    licenseId: item.license ?? product.licenseId,
    // What the Place menu groups and searches by (placing.js): the category, and whether the
    // account owns it (it came from the owner=me search)
    ...(typeof item.category === 'string' ? { category: item.category } : {}),
    ...(item.own === true ? { own: true } : {}),
    ...(item.maker ?? product.maker ? { maker: item.maker ?? product.maker } : {}),
  };
  if (item.category === 'end-effector' || isPlain(product.hand)) {
    const hand = isPlain(product.hand) ? product.hand : {};
    return {
      hand: {
        ...common,
        ...hand,
        // Seeded hands name the arms they fit by the open build's ids; a mounting standard
        // ("ISO 9409-1-50-4-M6") is not an id and stays as it is
        fits: Array.isArray(hand.fits) ? hand.fits.map(refOf) : [],
      },
    };
  }
  // **A machine with no class of its own** (a fixture, an object) is still in the list, so it can
  // be placed: as an `object` (products.js stands it where it is put)
  if (typeof product.class !== 'string' || !isPlain(product[product.class])) {
    return { product: { ...common, generic: product.generic === true, class: 'object', object: { robotId: id }, arm: null } };
  }
  const own = product[product.class];
  return {
    product: {
      ...common,
      generic: product.generic === true,
      class: product.class,
      // The class's block draws the catalog's own machine: its robotId is this reference
      [product.class]: 'robotId' in own ? { ...own, robotId: id } : { ...own },
      arm: isPlain(product.arm) ? product.arm : null,
    },
  };
}

/**
 * How many machines one search asks for. **The list is not paged yet**: 500 is the server's cap
 * (functions/api/catalog/search.js), and a recording that names a machine beyond it is still
 * found by its own reference (resolveMissing).
 */
const INDEX_LIMIT = 500;

async function searchItems(fetchImpl, query, extra = {}) {
// PSCOM-SEAM-WAS   const response = await fetchImpl(`/api/catalog/search?${query}`);
  const response = await fetchImpl(`${catalogBase}/api/catalog/search?${query}`); // PSCOM-SEAM-NEW
  if (!response.ok) throw new Error(`the catalog's search answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.items)) throw new Error('the catalog\'s search answered no items');
  return extra.own ? body.items.map((item) => (item && typeof item === 'object' ? { ...item, own: true } : item)) : body.items;
}

/**
 * The machines there are, as the open build's products.json rows. Signed in, the account's own
 * machines (private ones too) are asked for as well and added after the public ones, each once.
 * **Throws** when the search cannot be read; products.js turns that into an index that says so.
 *
 * @param {(url: string) => Promise<{ ok: boolean, json: () => Promise<any> }>} fetchImpl
 * @param {{ signedIn?: boolean }} [options]
 * @returns {Promise<{ products: object[], hands: object[] }>}
 */
export async function loadMachineIndex(fetchImpl, { signedIn = false } = {}) {
  const items = await searchItems(fetchImpl, `kind=machine&limit=${INDEX_LIMIT}`);
  // **psbx pushes objects as `kind: 'object'`** and the search takes one kind, so they are asked
  // for apart; each list after the first only adds: the machines stand when it cannot be read
  const more = [`kind=object&limit=${INDEX_LIMIT}`];
  if (signedIn) more.push(`kind=machine&limit=${INDEX_LIMIT}&owner=me`, `kind=object&limit=${INDEX_LIMIT}&owner=me`);
  for (const query of more) {
    try {
      items.push(...await searchItems(fetchImpl, query, { own: query.endsWith('&owner=me') }));
    } catch {
      // Signed out meanwhile, or offline: that list is left out
    }
  }
  const products = [];
  const hands = [];
  const seen = new Map();
  for (const item of items) {
    if (!item || typeof item.handle !== 'string' || typeof item.name !== 'string') continue;
    const row = rowOf(item);
    const id = (row.product ?? row.hand).id;
    if (seen.has(id)) {
      // Listed public first and again as the account's own: it is the account's
      if (item.own === true && seen.get(id)) seen.get(id).own = true;
      continue;
    }
    seen.set(id, row.product ?? null);
    if (typeof item.bundle === 'string') bundles.set(id, item.bundle);
    if (row.hand) hands.push(row.hand);
    else products.push(row.product);
  }
  return { products, hands };
}

/**
 * **Before a machine is called missing, it is asked for by its own reference**: the index is only
 * what the search listed, and a recording may name a machine it did not (beyond the search's cap,
 * or one shared with this account by its link). Each product or end effector a recording names
 * that the index lacks is looked up by its manifest; what answers is added to the index (the same
 * row the search would have made), and only what the catalog answers 404 for (or cannot be
 * reached) stays missing, for products.js to report.
 *
 * @param {{ equipment?: { devices?: object[] } } | null | undefined} project
 * @param {{ products: Map<string, object>, hands: Map<string, object> }} index changed in place
 * @param {(url: string) => Promise<{ ok: boolean, json: () => Promise<any> }>} [fetchImpl]
 * @returns {Promise<string[]>} the references that were found and added
 */
// PSCOM-SEAM-WAS export async function resolveMissing(project, index, fetchImpl = (url) => fetch(url)) {
export async function resolveMissing(project, index, fetchImpl = (url) => defaultFetch(url)) { // PSCOM-SEAM-NEW
  const devices = Array.isArray(project?.equipment?.devices) ? project.equipment.devices : [];
  const wanted = new Set();
  for (const device of devices) {
    if (!device || typeof device !== 'object') continue;
    if (isRef(device.product) && !index.products.has(device.product)) wanted.add(device.product);
    if (isRef(device.endEffector) && !index.hands.has(device.endEffector)) wanted.add(device.endEffector);
  }
  const found = [];
  for (const machine of wanted) {
    const parts = parseRef(machine);
    try {
      const response = await fetchImpl(`${rootOf(parts)}/manifest`);
      if (!response.ok) continue;
      const manifest = await response.json();
      if (!isPlain(manifest) || manifest.kind === 'record') continue;
      const row = rowOf({
        handle: parts.handle, name: parts.name, version: parts.version, category: manifest.category,
        display: manifest.display, license: manifest.license, maker: manifest.maker ?? null, product: manifest.product,
      });
      if (typeof manifest.bundle === 'string') {
        encodePath(manifest.bundle);
        bundles.set(machine, manifest.bundle);
      }
      if (row.hand) index.hands.set(machine, row.hand);
      else index.products.set(machine, row.product);
      found.push(machine);
    } catch (error) {
      // Offline, or a manifest that does not hold up: it stays missing
      console.warn(`${machine}: could not be looked up in the catalog`, error);
    }
  }
  return found;
}
