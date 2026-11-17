/**
 * Robots: the list from `GET machines` (the catalog, the psbx cache, local folders), each dragged
 * onto the floor to place it (`POST scene/place`). A placed robot is picked by a click on it, as on
 * PS.com's screen: 「置き直す」 (the next click on the floor puts it there) and 「削除」 beside it, ← → to
 * turn it. Its row in the list has the same two and its facing in degrees. Moving and turning are
 * `POST scene/place` under its own id; removing is `POST scene/remove`.
 */
import type { Api } from './comms-client.js';
import { PaneError } from './comms-client.js';
import type { PaneScene } from './stage.js';
import { buttonOf, labelOf, say as word, type WordKey } from './words.js';

type Json = Record<string, any>;

export interface MachineRow { ref: string; label: string; source: string; kind: string }
/** `xy`: where it stands on the site [m]; `yawDeg`: the way it faces, whole degrees in -180..180. */
export interface PlacedRow { id: string; product: string; note: string | null; xy: [number, number]; yawDeg: number }

/** Degrees a press of ← or → turns a placed robot by. */
export const TURN_STEP_DEG = 15;

const wrapDeg = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Where a robot comes from (src/core/machines.ts MachineSource), in words. */
const SOURCE_WORDS: Record<string, WordKey> = { catalog: 'sourceCatalog', cache: 'sourceCache', local: 'sourceLocal' };

/** The drag's data type: the product a dragged row stands for. */
export const DRAG_TYPE = 'application/x-ps-product';

/** The rows of a `GET machines` answer that can be placed. */
export function machineRows(answer: unknown): MachineRow[] {
  const machines = (answer as Json)?.machines;
  if (!Array.isArray(machines)) return [];
  return machines
    .filter((m) => m && typeof m.ref === 'string' && m.ref)
    .map((m) => ({ ref: m.ref, label: typeof m.label === 'string' && m.label ? m.label : m.ref, source: String(m.source ?? ''), kind: String(m.kind ?? 'machine') }));
}

/** The placed devices of a scene, each with the reason it is not drawn when it is not. */
export function placedRows(scene: PaneScene | null, missing: { deviceId: string; product: string }[] = []): PlacedRow[] {
  if (!scene) return [];
  return scene.devices.map((d) => {
    const product = typeof d.product === 'string' ? d.product : '';
    const lost = missing.some((m) => m.deviceId === d.id);
    const xy: [number, number] = [num(d.pose?.xyz?.[0]), num(d.pose?.xyz?.[1])];
    const yawDeg = wrapDeg(Math.round((num(d.pose?.rpy?.[2]) * 180) / Math.PI));
    return { id: d.id, product, note: lost ? word('notDrawn', { product: product || d.id }) : null, xy, yawDeg };
  });
}

/** What `POST scene/place` is sent for a product dropped at a floor point (ROS x, y). */
export const placeRequest = (product: string, point: [number, number]) => ({ product, xyz: [point[0], point[1], 0], yaw: 0 });

/**
 * A placed robot put somewhere else (`xy`) or turned (`yawDeg`): `POST scene/place` under its own
 * id, which moves it (src/plugin/actions.ts). What is not given stays as the row has it.
 */
export function moveRequest(row: PlacedRow, to: { xy?: [number, number]; yawDeg?: number }) {
  const xy = to.xy ?? row.xy;
  return { id: row.id, product: row.product, xyz: [xy[0], xy[1], 0], yaw: ((to.yawDeg ?? row.yawDeg) * Math.PI) / 180 };
}

/** How near a click has to be to where a robot stands, on the page [px]. */
export const PICK_REACH_PX = 70;

/** The placed robot standing nearest a click on the page, within reach; null when none is. */
export function rowAt(rows: PlacedRow[], at: { x: number; y: number }, pageOf: (xy: [number, number]) => { x: number; y: number } | null): PlacedRow | null {
  let best: PlacedRow | null = null;
  let bestD = PICK_REACH_PX;
  for (const row of rows) {
    const p = pageOf(row.xy);
    if (!p) continue;
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= bestD) { best = row; bestD = d; }
  }
  return best;
}

/** The facing after a key: ← turns left (counter-clockwise from above), → right. Null for any other key. */
export function turnedBy(yawDeg: number, key: string): number | null {
  if (key === 'ArrowLeft') return wrapDeg(yawDeg + TURN_STEP_DEG);
  if (key === 'ArrowRight') return wrapDeg(yawDeg - TURN_STEP_DEG);
  return null;
}

export interface PlaceUi {
  setScene(scene: PaneScene, missing: { deviceId: string; product: string }[]): void;
  refresh(): Promise<void>;
}

export function mountPlaceUi(opts: {
  robotsRoot: HTMLElement;
  placedRoot: HTMLElement;
  api: Api;
  dropTarget: HTMLElement;
  floorPointAt: (clientX: number, clientY: number) => [number, number] | null;
  say: (text: string, title?: string) => void;
  /** Whether the floor's clicks belong to something else now (the corners being picked). */
  busy?: () => boolean;
  /** The stage's cursor: a robot is waiting for its place. */
  onArmed?: (armed: boolean) => void;
  /** Where a floor point (ROS [x, y]) is on the page: what a click on a robot is told by. */
  pagePointOf?: (xy: [number, number]) => { x: number; y: number } | null;
  /** What the picked robot's menu is laid in (the stage's box). */
  menuRoot?: HTMLElement;
}): PlaceUi {
  const { api } = opts;
  const hint = labelOf('robotsHint', 'p');
  hint.className = 'ps-hint';
  const offline = labelOf('robotsOffline', 'p');
  offline.className = 'ps-hint';
  offline.hidden = true;
  const list = document.createElement('ul');
  list.className = 'ps-list ps-machines';
  opts.robotsRoot.append(hint, offline, list);

  const placed = document.createElement('ul');
  placed.className = 'ps-list ps-placed';
  opts.placedRoot.append(placed);

  async function refresh(): Promise<void> {
    let answer: Json;
    try {
      answer = await api.get('machines');
    } catch (e) {
      opts.say(e instanceof PaneError ? e.message : word('failed'));
      return;
    }
    offline.hidden = answer.offline !== true;
    const rows = machineRows(answer);
    list.replaceChildren();
    if (!rows.length) {
      const none = labelOf('robotsNone', 'li');
      none.className = 'ps-empty';
      list.append(none);
    }
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'ps-machine';
      item.draggable = true;
      item.dataset.product = row.ref;
      item.title = row.ref;
      const name = document.createElement('span');
      name.textContent = row.label;
      const source = document.createElement('small');
      source.className = 'ps-source';
      if (row.ref !== row.label) source.append(`${row.ref} · `);
      source.append(Object.hasOwn(SOURCE_WORDS, row.source) ? labelOf(SOURCE_WORDS[row.source], 'span') : row.source);
      item.append(name, ' ', source);
      item.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(DRAG_TYPE, row.ref);
        event.dataTransfer?.setData('text/plain', row.ref);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      });
      list.append(item);
    }
  }

  opts.dropTarget.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes(DRAG_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  });
  opts.dropTarget.addEventListener('drop', async (event) => {
    const product = event.dataTransfer?.getData(DRAG_TYPE);
    if (!product) return;
    event.preventDefault();
    const point = opts.floorPointAt(event.clientX, event.clientY);
    if (!point) { opts.say(word('offFloor')); return; }
    try {
      await api.post('scene/place', placeRequest(product, point));
    } catch (e) {
      opts.say(e instanceof PaneError ? e.message : word('failed'));
    }
  });

  // ---- the picked robot, as PS.com's screen has it: a click on a robot picks it and puts 「置き直す」 and
  // 「削除」 beside it; 「置き直す」 arms it and the next click on the floor puts it there; ← → turn it; Esc
  // lets go. A row's own 「置き直す」 arms it straight away.
  let rows: PlacedRow[] = [];
  let picked: string | null = null;
  let armed = false;
  const pickedRow = (): PlacedRow | null => rows.find((r) => r.id === picked) ?? null;

  const menu = document.createElement('div');
  menu.className = 'ps-pick-menu';
  menu.hidden = true;
  const menuReplace = buttonOf('replace', 'ps-button');
  const menuRemove = buttonOf('removePlaced', 'ps-button ps-danger');
  menu.append(menuReplace, menuRemove);
  (opts.menuRoot ?? opts.dropTarget.parentElement)?.append(menu);

  function mark(): void {
    opts.onArmed?.(armed);
    for (const item of placed.querySelectorAll<HTMLElement>('.ps-device')) item.classList.toggle('ps-armed', item.dataset.device === picked);
  }

  function unpick(): void {
    picked = null;
    armed = false;
    menu.hidden = true;
    mark();
  }

  /** Pick a robot: the menu beside the click (when there was one), the keys on it. */
  function pick(id: string, at?: { x: number; y: number }): void {
    picked = id;
    armed = false;
    if (at) {
      menu.hidden = false;
      const box = (menu.parentElement ?? opts.dropTarget).getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(at.x - box.left + 14, box.width - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(at.y - box.top + 14, box.height - menu.offsetHeight - 8))}px`;
    } else {
      menu.hidden = true;
    }
    mark();
    opts.say(word('picked'));
  }

  /** 「置き直す」: the next click on the floor puts the picked robot there. */
  function arm(id: string): void {
    picked = id;
    armed = true;
    menu.hidden = true;
    mark();
    opts.say(word('replaceHint', { name: id }));
  }

  async function move(row: PlacedRow, to: { xy?: [number, number]; yawDeg?: number }): Promise<boolean> {
    try {
      await api.post('scene/place', moveRequest(row, to));
      return true;
    } catch (e) {
      opts.say(e instanceof PaneError ? e.message : word('failed'));
      return false;
    }
  }

  async function remove(id: string): Promise<void> {
    if (picked === id) unpick();
    try {
      await api.post('scene/remove', { id });
    } catch (e) {
      opts.say(e instanceof PaneError ? e.message : word('failed'));
    }
  }

  menuReplace.addEventListener('click', () => { if (picked) arm(picked); });
  menuRemove.addEventListener('click', () => { if (picked) void remove(picked); });

  // A drag that turned the camera ends in a click too: only a click that stayed put picks or places
  let pressedAt: { x: number; y: number } | null = null;
  opts.dropTarget.addEventListener('pointerdown', (event) => { pressedAt = { x: event.clientX, y: event.clientY }; });
  opts.dropTarget.addEventListener('click', async (event) => {
    if (opts.busy?.()) return;
    if (pressedAt && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > 4) return;
    const at = { x: event.clientX, y: event.clientY };
    const row = pickedRow();
    if (row && armed) {
      const point = opts.floorPointAt(at.x, at.y);
      if (!point) { opts.say(word('offFloor')); return; }
      unpick();
      if (await move(row, { xy: point })) opts.say(word('replaced', { name: row.id }));
      return;
    }
    const hit = opts.pagePointOf ? rowAt(rows, at, opts.pagePointOf) : null;
    if (hit) pick(hit.id, at);
    else if (picked) { unpick(); opts.say(''); }
  });
  opts.dropTarget.ownerDocument?.addEventListener('keydown', async (event) => {
    const row = pickedRow();
    if (!row) return;
    if ((event.target as HTMLElement | null)?.closest?.('input, select, textarea')) return;
    if (event.key === 'Escape') { unpick(); opts.say(''); return; }
    const yawDeg = turnedBy(row.yawDeg, event.key);
    if (yawDeg === null) return;
    event.preventDefault();
    // Counted here at once: a second press before the scene comes back turns on from this one
    row.yawDeg = yawDeg;
    await move(row, { yawDeg });
  });

  function setScene(scene: PaneScene, missing: { deviceId: string; product: string }[]): void {
    rows = placedRows(scene, missing);
    // What was being re-placed is gone (removed, or another record opened): nothing waits any more
    if (picked !== null && !pickedRow()) unpick();
    placed.replaceChildren();
    if (!rows.length) {
      const none = labelOf('placedNone', 'li');
      none.className = 'ps-empty';
      placed.append(none);
    }
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'ps-device';
      item.dataset.device = row.id;
      const name = document.createElement('span');
      name.textContent = row.id;
      const product = document.createElement('small');
      product.className = 'ps-source';
      product.textContent = row.product;
      if (row.id === picked) item.classList.add('ps-armed');
      const replace = buttonOf('replace', 'ps-button ps-small');
      replace.addEventListener('click', () => { if (picked === row.id && armed) { unpick(); opts.say(''); } else arm(row.id); });
      const facing = labelOf('facing', 'label');
      facing.className = 'ps-facing';
      const degrees = document.createElement('input');
      degrees.type = 'number';
      degrees.min = '-180';
      degrees.max = '180';
      degrees.step = String(TURN_STEP_DEG);
      degrees.value = String(row.yawDeg);
      degrees.addEventListener('change', () => {
        const yawDeg = Number(degrees.value);
        if (Number.isFinite(yawDeg)) void move(row, { yawDeg });
      });
      facing.append(' ', degrees);
      const removeButton = buttonOf('removePlaced', 'ps-button ps-small');
      removeButton.addEventListener('click', () => { void remove(row.id); });
      item.append(name, ' ', product, ' ', replace, ' ', facing, ' ', removeButton);
      if (row.note) {
        const note = document.createElement('div');
        note.className = 'ps-error';
        note.textContent = row.note;
        item.append(note);
      }
      placed.append(item);
    }
  }

  return { setScene, refresh };
}
