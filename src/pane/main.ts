/**
 * The pane page: the stage over the background, and the panel beside it (background, floor,
 * robots, playback, saving, PS.com). The same page runs in the editor's sidebar (an iframe the
 * editor forwards the hub's messages to) and in a window of its own (which hears `/comms` itself).
 */
import { adminRootOf, answerEditorRequest, commsUrlOf, connectComms, createApi, listenToEditor, PaneError, tokenOf, type PaneHandlers } from './comms-client.js';
import { mountFloorUi } from './floor-ui.js';
import { mountPlaceUi } from './place-ui.js';
import { mountRecordsUi, type PaneStatus } from './records-ui.js';
import { createPaneStage, type PaneScene } from './stage.js';
import { en, ja, labelOf } from './words.js';

type Json = Record<string, any>;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

const adminRoot = adminRootOf(location.pathname);
const inEditor = window.parent !== window;
/**
 * The editor's token (null without adminAuth). In a window of its own the pane reads it where the
 * editor keeps it (same origin); in the sidebar the editor hands it over first (see the end). It
 * goes only in `Authorization` headers and in `/comms`' `{auth}`, never in an address.
 */
let token: string | null = inEditor ? null : tokenOf(storage(), adminRoot);
const api = createApi({ base: adminRoot, token: () => token });
const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

// ---- what the pane says ----

const message = byId<HTMLParagraphElement>('ps-message');
let messageTimer: ReturnType<typeof setTimeout> | null = null;
function say(text: string, title = ''): void {
  message.textContent = text;
  message.title = title;
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { message.textContent = ''; }, 10_000);
}

// ---- the stage ----

const stageBox = byId<HTMLDivElement>('ps-stage');
const canvas = byId<HTMLCanvasElement>('ps-canvas');
const overlay = document.getElementById('ps-overlay') as unknown as SVGSVGElement;

/**
 * A bundle the routes resolve, its files under Node-RED (the catalog's through the plugin).
 * The bundle and its meshes are fetched with the token (fetchWithAuth). A texture is not:
 * robot-build.js loads it with THREE.TextureLoader, which sends no header, so under adminAuth a
 * textured robot is drawn without its texture (a known limit).
 */
async function resolveBundle(product: string) {
  const resolved = await api.get(`bundles/resolve?product=${encodeURIComponent(product)}`);
  const inNodeRed = (path: string) => `${adminRoot}${String(path).replace(/^\/+/, '')}`;
  return {
    bundleUrl: inNodeRed(resolved.bundleUrl),
    meshUrl: (relative: string) => {
      const parts = String(relative).split('/');
      if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`${relative} is not a file of the bundle`);
      return inNodeRed(resolved.meshBase + parts.map(encodeURIComponent).join('/'));
    },
  };
}

const fetchWithAuth = (url: string, init: Json = {}) => fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });

let floorPicking = (): boolean => false;
const stage = createPaneStage(canvas, {
  resolveBundle,
  fetchImpl: fetchWithAuth,
  overlay,
  canOrbit: () => !floorPicking(),
});

// ---- the background ----

let background: HTMLImageElement | HTMLVideoElement | null = null;
let backgroundUrl: string | null = null;
let backgroundKey: string | null = null;
let backgroundSize: { width: number; height: number } | null = null;

function dropBackground(): void {
  background?.remove();
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  background = null;
  backgroundUrl = null;
  backgroundSize = null;
  stage.setBackground(null, null);
}

/** The scene's background, fetched again when it changed (or this pane just sent a new one). */
async function showBackground(bg: PaneScene['background'], force = false): Promise<void> {
  const key = bg ? `${bg.kind}:${bg.name}` : null;
  if (key === backgroundKey && !force) return;
  backgroundKey = key;
  if (!bg) { dropBackground(); return; }
  let blob: Blob;
  try {
    const res = await fetchWithAuth(api.url('scene/background'), { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    blob = await res.blob();
  } catch {
    say(ja('backgroundLost'), en('backgroundLost'));
    if (backgroundKey === key) backgroundKey = null; // the next scene tries again
    return;
  }
  if (backgroundKey !== key) return; // another came meanwhile
  const url = URL.createObjectURL(blob);
  const element = bg.kind === 'video' ? document.createElement('video') : document.createElement('img');
  element.className = 'ps-background';
  element.src = url;
  if (element instanceof HTMLVideoElement) {
    Object.assign(element, { muted: true, loop: true, autoplay: true, playsInline: true });
    await new Promise((done) => { element.onloadedmetadata = done; element.onerror = done; });
    void element.play().catch(() => undefined);
  } else {
    await element.decode().catch(() => undefined);
  }
  const size = element instanceof HTMLVideoElement
    ? { width: element.videoWidth, height: element.videoHeight }
    : { width: element.naturalWidth, height: element.naturalHeight };
  if (backgroundKey !== key || !(size.width > 0 && size.height > 0)) { URL.revokeObjectURL(url); return; }
  background?.remove();
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  background = element;
  backgroundUrl = url;
  backgroundSize = size;
  stageBox.prepend(element);
  stage.setBackground(element, size);
}

const backgroundSection = byId<HTMLElement>('ps-background-section');
const backgroundHeading = labelOf('background', 'h2');
const backgroundRow = document.createElement('div');
backgroundRow.className = 'ps-row';
const chooseLabel = labelOf('chooseBackground', 'label');
chooseLabel.className = 'ps-button ps-file';
const chooseInput = document.createElement('input');
chooseInput.type = 'file';
chooseInput.name = 'background';
chooseInput.accept = 'image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime';
chooseLabel.append(chooseInput);
backgroundRow.append(chooseLabel);
const backgroundHint = labelOf('backgroundHint', 'p');
backgroundHint.className = 'ps-hint';
const floorRoot = document.createElement('div');
backgroundSection.append(backgroundHeading, backgroundRow, backgroundHint, floorRoot);

chooseInput.addEventListener('change', async () => {
  const file = chooseInput.files?.[0];
  chooseInput.value = '';
  if (!file) return;
  try {
    const answer = await api.upload('scene/background', file, file.name);
    say(ja('backgroundSent', { name: answer.background?.name ?? file.name }));
    await showBackground(answer.background ?? null, true);
  } catch (e) {
    say(e instanceof PaneError ? e.message : ja('failed'));
  }
});

// ---- the floor, the robots, the records ----

const floor = mountFloorUi({
  root: floorRoot,
  overlay,
  api,
  pixelAt: (x, y) => stage.pixelAt(x, y),
  pictureSize: () => backgroundSize,
});
floorPicking = () => floor.picking();
canvas.addEventListener('click', (event) => {
  floor.click(event.clientX, event.clientY);
  stageBox.classList.toggle('ps-picking', floor.picking());
});
new MutationObserver(() => stageBox.classList.toggle('ps-picking', floor.picking())).observe(floorRoot, { subtree: true, childList: true, characterData: true });

const robotsSection = byId<HTMLElement>('ps-robots-section');
robotsSection.append(labelOf('robots', 'h2'));
const placedSection = byId<HTMLElement>('ps-placed-section');
placedSection.append(labelOf('placed', 'h2'));
const place = mountPlaceUi({
  robotsRoot: robotsSection,
  placedRoot: placedSection,
  api,
  dropTarget: canvas,
  floorPointAt: (x, y) => stage.floorPointAt(x, y),
  say,
});

const playSection = byId<HTMLElement>('ps-play-section');
playSection.append(labelOf('playback', 'h2'));
const saveSection = byId<HTMLElement>('ps-save-section');
saveSection.append(labelOf('records', 'h2'));
const accountSection = byId<HTMLElement>('ps-account-section');
accountSection.append(labelOf('account', 'h2'));
const records = mountRecordsUi({ playRoot: playSection, saveRoot: saveSection, accountRoot: accountSection, api, say });

// ---- what the hub says ----

let scene: PaneScene | null = null;
let deviceIds = '';
/** This page, for the plugin's count of open panes. */
const page = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const handlers: PaneHandlers = {
  scene(next) {
    scene = next as PaneScene;
    const shown = scene;
    floor.setKnownEdges(shown.floor?.edgesM ?? null);
    records.setSite(shown.site);
    void showBackground(shown.background ?? null);
    place.setScene(shown, stage.missing());
    const ids = JSON.stringify(shown.devices.map((d) => d.id));
    void stage.setScene(shown).then(() => {
      if (scene !== shown) return;
      place.setScene(shown, stage.missing());
      // A new set of devices on the empty stage: the orbit camera takes them all in
      if (ids !== deviceIds && !shown.camera) stage.fit();
      deviceIds = ids;
    });
  },
  state(m) { stage.applyState(m as { topic: string; payload: Json }); },
  snapshot(messages) {
    if (!messages.length) { stage.clearStates(); return; }
    for (const m of messages) stage.applyState(m as { topic: string; payload: Json });
  },
  status(status) { records.setStatus(status as PaneStatus); },
  request(request) { void answerEditorRequest(api, request, page); },
};

// In the sidebar the editor sends its token before anything else: the robot list waits for it
if (inEditor) {
  let listed = false;
  listenToEditor(window, handlers, (given) => {
    token = given;
    if (!listed) { listed = true; void place.refresh(); }
  });
} else {
  connectComms({ url: commsUrlOf(location, adminRoot), token, handlers });
  void place.refresh();
}

// For checking the page by hand and for the agent (part 2): the stage as it is
(globalThis as any).psPane = { stage, scene: () => scene };
