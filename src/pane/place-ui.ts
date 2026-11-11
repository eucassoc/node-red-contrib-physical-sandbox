/**
 * Robots: the list from `GET machines` (the catalog, the psbx cache, local folders), each dragged
 * onto the floor to place it (`POST scene/place`), and the list of placed devices with 「取り除く」
 * (`POST scene/remove`).
 */
import type { Api } from './comms-client.js';
import { PaneError } from './comms-client.js';
import type { PaneScene } from './stage.js';
import { buttonOf, en, ja, labelOf } from './words.js';

type Json = Record<string, any>;

export interface MachineRow { ref: string; label: string; source: string; kind: string }
export interface PlacedRow { id: string; product: string; note: string | null }

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
    return { id: d.id, product, note: lost ? ja('notDrawn', { product: product || d.id }) : null };
  });
}

/** What `POST scene/place` is sent for a product dropped at a floor point (ROS x, y). */
export const placeRequest = (product: string, point: [number, number]) => ({ product, xyz: [point[0], point[1], 0], yaw: 0 });

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
      opts.say(e instanceof PaneError ? e.message : ja('failed'));
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
      source.textContent = row.ref === row.label ? row.source : `${row.ref} · ${row.source}`;
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
    if (!point) { opts.say(ja('offFloor'), en('offFloor')); return; }
    try {
      await api.post('scene/place', placeRequest(product, point));
    } catch (e) {
      opts.say(e instanceof PaneError ? e.message : ja('failed'));
    }
  });

  function setScene(scene: PaneScene, missing: { deviceId: string; product: string }[]): void {
    const rows = placedRows(scene, missing);
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
      const remove = buttonOf('remove', 'ps-button ps-small');
      remove.addEventListener('click', async () => {
        try {
          await api.post('scene/remove', { id: row.id });
        } catch (e) {
          opts.say(e instanceof PaneError ? e.message : ja('failed'));
        }
      });
      item.append(name, ' ', product, ' ', remove);
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
