/**
 * 「床を決定」: four corners clicked on the picture in order (1→2→3→4), the lengths of edges 1→2
 * and 2→3, then 決定, which asks the hub to solve the camera (`POST scene/floor`).
 *
 * `floorStep` is the whole of what happens, as plain data (the tests drive it); `mountFloorUi`
 * draws it and sends the request.
 */
import type { Api } from './comms-client.js';
import { PaneError } from './comms-client.js';
import { buttonOf, en, ja, labelOf } from './words.js';

export interface Pixel { u: number; v: number }

export type FloorState =
  | { step: 'idle'; note: string | null }
  | { step: 'corners'; corners: Pixel[]; edges: [string, string]; note: string | null }
  | { step: 'lengths'; corners: Pixel[]; edges: [string, string]; note: string | null }
  | { step: 'deciding'; corners: Pixel[]; edges: [string, string]; note: string | null };

export type FloorAction =
  | { type: 'start'; edges?: [number, number] | null }
  | { type: 'click'; at: Pixel }
  | { type: 'edge'; index: 0 | 1; text: string }
  | { type: 'decide' }
  | { type: 'answered'; edgesM: [number, number] }
  | { type: 'refused'; note: string }
  | { type: 'startOver' }
  | { type: 'cancel' };

export const idleFloor = (): FloorState => ({ step: 'idle', note: null });

/** A length as typed: a number above zero, else null. */
export function lengthOf(text: string): number | null {
  const n = Number(String(text).trim().replace(/,/g, '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const shown = (n: number) => String(Math.round(n * 1000) / 1000);

/** The next state. A click counts only while corners are asked for; 決定 only with both lengths. */
export function floorStep(state: FloorState, action: FloorAction): FloorState {
  switch (action.type) {
    case 'start': {
      const edges: [string, string] = action.edges ? [shown(action.edges[0]), shown(action.edges[1])] : ['', ''];
      return { step: 'corners', corners: [], edges, note: null };
    }
    case 'cancel':
      return idleFloor();
    case 'startOver':
      return state.step === 'idle' ? state : { step: 'corners', corners: [], edges: state.edges, note: null };
    case 'click': {
      if (state.step !== 'corners') return state;
      const corners = [...state.corners, { u: action.at.u, v: action.at.v }];
      return { step: corners.length === 4 ? 'lengths' : 'corners', corners, edges: state.edges, note: null };
    }
    case 'edge': {
      if (state.step !== 'lengths' && state.step !== 'corners') return state;
      const edges: [string, string] = [...state.edges];
      edges[action.index] = action.text;
      return { ...state, edges };
    }
    case 'decide': {
      if (state.step !== 'lengths') return state;
      if (lengthOf(state.edges[0]) === null || lengthOf(state.edges[1]) === null) return { ...state, note: ja('badLength') };
      return { ...state, step: 'deciding', note: null };
    }
    case 'answered':
      return { step: 'idle', note: ja('floorDecided', { a: shown(action.edgesM[0]), b: shown(action.edgesM[1]) }) };
    case 'refused':
      // Clicked the wrong way round, or too flat: the corners again, keeping the lengths
      return state.step === 'idle' ? state : { step: 'corners', corners: [], edges: state.edges, note: action.note };
    default:
      return state;
  }
}

/** What `POST scene/floor` is sent for a state that is deciding; null otherwise. */
export function floorRequest(state: FloorState, size: { width: number; height: number }): { pixels: Pixel[]; edgesM: [number, number]; width: number; height: number } | null {
  if (state.step !== 'deciding' || state.corners.length !== 4) return null;
  const a = lengthOf(state.edges[0]);
  const b = lengthOf(state.edges[1]);
  if (a === null || b === null) return null;
  return { pixels: state.corners.map(({ u, v }) => ({ u, v })), edgesM: [a, b], width: size.width, height: size.height };
}

/** The line that says what to do now. */
export function floorPrompt(state: FloorState): string | null {
  if (state.step === 'corners') return ja('cornerNext', { n: state.corners.length + 1 });
  if (state.step === 'lengths') return ja('lengthsHint');
  if (state.step === 'deciding') return ja('deciding');
  return null;
}

const SVG = 'http://www.w3.org/2000/svg';

export interface FloorUi {
  /** A click on the stage: true when the floor took it (corners are being asked for). */
  click(clientX: number, clientY: number): boolean;
  /** Whether corners are being clicked (the orbit camera stays still meanwhile). */
  picking(): boolean;
  /** The scene changed: its floor's lengths are offered next time. */
  setKnownEdges(edges: [number, number] | null): void;
}

/**
 * The floor's part of the pane: the 「床を決定」 button, the prompt, the two lengths, 決定・最初から・やめる,
 * and the clicked corners drawn as numbered marks on `overlay` (an <svg> laid over the picture).
 */
export function mountFloorUi(opts: {
  root: HTMLElement;
  overlay: SVGSVGElement;
  api: Api;
  pixelAt: (clientX: number, clientY: number) => Pixel | null;
  pictureSize: () => { width: number; height: number } | null;
}): FloorUi {
  const { root, overlay, api } = opts;
  let state = idleFloor();
  let known: [number, number] | null = null;

  const startButton = buttonOf('decideFloor');
  const prompt = document.createElement('p');
  prompt.className = 'ps-prompt';
  const lengths = document.createElement('div');
  lengths.className = 'ps-row';
  const inputs = [0, 1].map((i) => {
    const wrap = document.createElement('label');
    wrap.className = 'ps-field';
    wrap.append(labelOf(i === 0 ? 'edge12' : 'edge23'));
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.size = 6;
    input.dataset.edge = String(i + 1);
    input.addEventListener('input', () => go({ type: 'edge', index: i as 0 | 1, text: input.value }));
    wrap.append(input);
    lengths.append(wrap);
    return input;
  });
  const decideButton = buttonOf('decide', 'ps-button ps-primary');
  const overButton = buttonOf('startOver');
  const cancelButton = buttonOf('cancel');
  const actions = document.createElement('div');
  actions.className = 'ps-row';
  actions.append(decideButton, overButton, cancelButton);
  root.append(startButton, prompt, lengths, actions);

  startButton.addEventListener('click', () => {
    if (!opts.pictureSize()) { show(ja('needPicture'), en('needPicture')); return; }
    go({ type: 'start', edges: known });
  });
  decideButton.addEventListener('click', () => { go({ type: 'decide' }); void send(); });
  overButton.addEventListener('click', () => go({ type: 'startOver' }));
  cancelButton.addEventListener('click', () => go({ type: 'cancel' }));

  function show(text: string | null, title = ''): void {
    prompt.textContent = text ?? '';
    prompt.title = title;
    prompt.hidden = !text;
  }

  function go(action: FloorAction): void {
    state = floorStep(state, action);
    draw();
  }

  async function send(): Promise<void> {
    const size = opts.pictureSize();
    const body = size ? floorRequest(state, size) : null;
    if (!body) return;
    try {
      const answer = await api.post('scene/floor', body);
      go({ type: 'answered', edgesM: answer.edgesM ?? body.edgesM });
    } catch (e) {
      go({ type: 'refused', note: e instanceof PaneError ? e.message : ja('failed') });
    }
  }

  function draw(): void {
    const active = state.step !== 'idle';
    startButton.hidden = active;
    lengths.hidden = !active;
    actions.hidden = !active;
    decideButton.disabled = state.step !== 'lengths';
    overButton.disabled = state.step === 'deciding';
    if (state.step !== 'idle') {
      const { edges } = state;
      inputs.forEach((input, i) => { if (input.value !== edges[i]) input.value = edges[i]; });
    }
    show(state.note ?? floorPrompt(state));
    drawMarks();
  }

  function drawMarks(): void {
    overlay.replaceChildren();
    const size = opts.pictureSize();
    const corners = state.step === 'idle' ? [] : state.corners;
    if (!size || !corners.length) return;
    overlay.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
    const r = Math.max(size.width, size.height) / 90;
    if (corners.length > 1) {
      const path = document.createElementNS(SVG, 'polyline');
      path.setAttribute('points', [...corners, ...(corners.length === 4 ? [corners[0]] : [])].map((c) => `${c.u},${c.v}`).join(' '));
      path.setAttribute('class', 'ps-floor-edge');
      path.setAttribute('stroke-width', String(r / 3));
      overlay.append(path);
    }
    corners.forEach((c, i) => {
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', String(c.u));
      dot.setAttribute('cy', String(c.v));
      dot.setAttribute('r', String(r));
      dot.setAttribute('class', 'ps-floor-corner');
      const text = document.createElementNS(SVG, 'text');
      text.setAttribute('x', String(c.u));
      text.setAttribute('y', String(c.v));
      text.setAttribute('font-size', String(r * 1.4));
      text.setAttribute('class', 'ps-floor-number');
      text.textContent = String(i + 1);
      overlay.append(dot, text);
    });
  }

  draw();

  return {
    click(clientX, clientY) {
      if (state.step !== 'corners') return false;
      const at = opts.pixelAt(clientX, clientY);
      if (at) go({ type: 'click', at });
      return true;
    },
    picking: () => state.step === 'corners',
    setKnownEdges(edges) {
      known = edges;
    },
  };
}
