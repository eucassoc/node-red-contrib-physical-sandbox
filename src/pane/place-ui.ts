/**
 * Robots: the list from `GET machines` (the catalog, the psbx cache, local folders), each dragged
 * onto the floor to place it (`POST scene/place`), and the list of placed devices: 「移動」
 * (the next click on the floor moves it), its facing in degrees (← → while it is being re-placed),
 * both `POST scene/place` under its own id, and 「取り除く」 (`POST scene/remove`).
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

  // ---- re-placing: 「移動」 arms a row; the next click on the floor moves it there ----
  let rows: PlacedRow[] = [];
  let armed: string | null = null;
  const armedRow = (): PlacedRow | null => rows.find((r) => r.id === armed) ?? null;

  function arm(id: string | null): void {
    armed = id;
    opts.onArmed?.(armed !== null);
    for (const item of placed.querySelectorAll<HTMLElement>('.ps-device')) item.classList.toggle('ps-armed', item.dataset.device === armed);
    if (armed !== null) opts.say(word('replaceHint', { name: armed }));
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

  // A drag that turned the camera ends in a click too: only a click that stayed put places
  let pressedAt: { x: number; y: number } | null = null;
  opts.dropTarget.addEventListener('pointerdown', (event) => { pressedAt = { x: event.clientX, y: event.clientY }; });
  opts.dropTarget.addEventListener('click', async (event) => {
    const row = armedRow();
    if (!row || opts.busy?.()) return;
    if (pressedAt && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > 4) return;
    const point = opts.floorPointAt(event.clientX, event.clientY);
    if (!point) { opts.say(word('offFloor')); return; }
    arm(null);
    if (await move(row, { xy: point })) opts.say(word('replaced', { name: row.id }));
  });
  opts.dropTarget.ownerDocument?.addEventListener('keydown', async (event) => {
    const row = armedRow();
    if (!row) return;
    if ((event.target as HTMLElement | null)?.closest?.('input, select, textarea')) return;
    if (event.key === 'Escape') { arm(null); opts.say(''); return; }
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
    if (armed !== null && !armedRow()) arm(null);
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
      if (row.id === armed) item.classList.add('ps-armed');
      const replace = buttonOf('replace', 'ps-button ps-small');
      replace.addEventListener('click', () => arm(armed === row.id ? null : row.id));
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
      const remove = buttonOf('remove', 'ps-button ps-small');
      remove.addEventListener('click', async () => {
        try {
          await api.post('scene/remove', { id: row.id });
        } catch (e) {
          opts.say(e instanceof PaneError ? e.message : word('failed'));
        }
      });
      item.append(name, ' ', product, ' ', replace, ' ', facing, ' ', remove);
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
