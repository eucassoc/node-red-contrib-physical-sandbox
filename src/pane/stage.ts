/**
 * The pane's stage: the scene's robots and items drawn over the background picture, moved by the
 * stream's state messages.
 *
 * Built from PS.com's record page stage (lp/assets/catalog/stage-replay.js): the whole site hangs
 * from one group turned ROS to three by robot-build.js's `rosToThree` (and the quarter turn of
 * PS.com's video stage, devices/view.js standOn, so ROS lands on the site frame), each device on a holder
 * placed in ROS (`rotation.order = 'ZYX'`), a robot lifted onto the floor along ROS +Z. Items are
 * boxes (`shape.sizeM`, `render.colorHex`), centred on their place as PS.com's devices/view.js draws them.
 *
 * Over a background the renderer is transparent and draws only into the picture's rectangle
 * (`fitRect`, `renderer.setViewport`); with a solved camera it looks through the real camera,
 * exactly as PS.com's video-view.js `applyCamera` does. Three's world is the site frame (y up), the
 * world the camera was solved in. Without a camera the orbit camera of orbit.js is used.
 *
 * The renderer, the robot builder and the clock are passed in for the tests.
 */
import * as THREE from 'three';
import * as defaultRobotBuild from '../pscom/robot-build.js';
import { floorHit, frustumOf, rayThroughPixel } from '../pscom/camera-model.js';
import { fitRect } from '../pscom/fit-rect.js';
import { DISTANCE_LIMITS, defaultOrbit, dragOrbit, orbitEye, wheelFactor, zoomOrbit } from '../pscom/orbit.js';
import { applyState as storeState, newStore, parseTopic } from '../pscom/state.js';

type Json = Record<string, any>;
type FetchLike = (url: string, init?: any) => Promise<any>;
type Xyz = [number, number, number];

/** What the pane knows of a scene (src/core/stream.ts Scene, as the hub sends it). */
export interface PaneScene {
  site: string;
  siteFrameId?: string | null;
  background?: { kind: 'still' | 'video'; name: string } | null;
  camera?: SolvedCamera | null;
  floor?: { corners: { x: number; y: number; z: number }[]; edgesM: [number, number] } | null;
  devices: Json[];
  names: Record<string, string>;
  streamNames?: Record<string, string>;
}

export interface SolvedCamera {
  intr: { fx: number; fy: number; cx: number; cy: number; width: number; height: number; dist: number[] };
  extr: { R: number[]; t: number[] };
}

export interface ResolvedBundle { bundleUrl: string; meshUrl: (relative: string) => string }

export interface StageOptions {
  resolveBundle: (product: string) => Promise<ResolvedBundle>;
  robotBuild?: { buildRobot: (...args: any[]) => Promise<any>; rosToThree: () => any };
  renderer?: (canvas: any) => any;
  now?: () => number;
  fetchImpl?: FetchLike;
  /** A new 2D canvas for `frame()` (tests give a fake one). */
  makeCanvas?: () => any;
  /** An element laid exactly over the picture with it (the floor corners' marks). */
  overlay?: any;
  /** Whether a drag on the stage may turn the orbit camera now (not while corners are clicked). */
  canOrbit?: () => boolean;
}

export interface PaneStage {
  setScene(scene: PaneScene): Promise<void>;
  applyState(message: { topic: string; payload: Json }): boolean;
  /** Forget every state: each device back at its pose, its joints at zero. */
  clearStates(): void;
  setCamera(camera: SolvedCamera | null): void;
  /** The picture under the 3D (an <img> or <video>) and its own size in pixels, or none. */
  setBackground(media: any, size: { width: number; height: number } | null): void;
  fit(): void;
  /** Size and place everything again (the canvas changed size). */
  layout(): void;
  /**
   * The background and the 3D in one PNG, at the picture's own size, or smaller so that its
   * longest side is `maxSide`. With `states` (the latest of each device at a stream time) those
   * are drawn instead of what the stage shows: on the stage's own copy, put back right after the
   * drawing (in the same task, so nothing live comes in between and nothing else sees it). A video
   * background is drawn as it shows now.
   */
  frame(o?: { states?: { topic: string; payload: Json }[]; maxSide?: number }): Promise<Blob>;
  /** A point of the page as a pixel of the picture ({u, v} in its own pixels), or null off it. */
  pixelAt(clientX: number, clientY: number): { u: number; v: number } | null;
  /** A point of the page as a point on the floor, ROS [x, y] metres, or null when it misses it. */
  floorPointAt(clientX: number, clientY: number): [number, number] | null;
  /** The devices that could not be drawn: { deviceId, product, error }. */
  missing(): { deviceId: string; product: string; error: string }[];
  /** For tests and the agent: where a device's holder is (ROS) and a joint's value. */
  placeOf(id: string): { position: Xyz; rpy: Xyz } | null;
  jointOf(id: string, name: string): number | undefined;
  readonly scene: any;
  readonly camera: any;
  dispose(): void;
}

/** The sky behind an empty stage and the grid's lines (PS.com catalog.css). */
const COLOURS = { sky: 0xe7eef7, gridMajor: 0x9aa8bb, grid: 0xc3cedc, floor: 0xff9a3c };
const ABOVE_GRID = 0.004;
const DEFAULT_BOX: Xyz = [0.2, 0.2, 0.2];
const DEFAULT_BOX_COLOUR = '#8a8a8a';

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isXyz = (v: unknown): v is Xyz => Array.isArray(v) && v.length === 3 && v.every(isNumber);
const own = (table: Record<string, string> | undefined, key: string) => (table && Object.hasOwn(table, key) ? table[key] : undefined);
/** The site frame (y up) as ROS (record-upgrade.js siteToRos). */
const siteToRos = ({ x, y, z }: { x: number; y: number; z: number }): Xyz => [x, 0 - z, y];

const defaultRenderer = (canvas: any) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  return renderer;
};
const defaultNow = () => globalThis.performance?.now?.() ?? Date.now();

interface Held {
  device: Json;
  /** What the drawing depends on: a change rebuilds it. */
  look: string;
  /** The pose last set from the scene, to see whether the scene moved it. */
  pose: string;
  holder: any;
  robot: any | null;
  isItem: boolean;
}

export function createPaneStage(canvas: any, opts: StageOptions): PaneStage {
  const build = opts.robotBuild ?? (defaultRobotBuild as unknown as NonNullable<StageOptions['robotBuild']>);
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? defaultNow;
  const canOrbit = opts.canOrbit ?? (() => true);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb7c2d0, 2.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const grid = new THREE.GridHelper(20, 20, COLOURS.gridMajor, COLOURS.grid);
  scene.add(grid);

  // The site in ROS, hung in three's world, which is the site frame the camera was solved in:
  // rosToThree, then the quarter turn about +y that PS.com's devices/view.js standOn adds so ROS
  // +X runs along the site's +x (corner 1→2). Together a ROS point (x, y, z) lands on the site's
  // (x, z, −y), record-upgrade.js rosToSite
  const site = new THREE.Group();
  site.name = 'site';
  site.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2).multiply(build.rosToThree());
  scene.add(site);
  let floorLine: any = null;

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 600);
  const renderer = (opts.renderer ?? defaultRenderer)(canvas);
  renderer.setPixelRatio?.(Math.min(globalThis.devicePixelRatio ?? 1, 2));

  let current: PaneScene = { site: 'local', devices: [], names: {} };
  const held = new Map<string, Held>();
  const store = newStore();
  const missingList: { deviceId: string; product: string; error: string }[] = [];
  /** A build finished after its device was removed or changed is thrown away. */
  let generation = 0;
  const builds = new Map<string, number>();

  let solved: SolvedCamera | null = null;
  let media: any = null;
  let mediaSize: { width: number; height: number } | null = null;
  let rect = { x: 0, y: 0, w: 1, h: 1 };
  let orbit = defaultOrbit();

  // ---- the scene ----

  function lookOf(device: Json): string {
    return JSON.stringify([device.product ?? null, device.type ?? null, device.shape ?? null, device.render ?? null]);
  }

  function setPose(h: Held): void {
    const xyz = isXyz(h.device.pose?.xyz) ? h.device.pose.xyz : [0, 0, 0];
    const rpy = isXyz(h.device.pose?.rpy) ? h.device.pose.rpy : [0, 0, 0];
    h.holder.position.set(xyz[0], xyz[1], xyz[2]);
    h.holder.rotation.set(rpy[0], rpy[1], rpy[2], 'ZYX');
  }

  function zeroJoints(h: Held): void {
    h.robot?.resetJoints();
  }

  /** The latest state held for a device, applied to its holder and robot. */
  function showState(h: Held): void {
    const state = store.get(h.device.id);
    if (!state) return;
    if (h.isItem) {
      if (isXyz(state.xyz)) h.holder.position.set(state.xyz[0], state.xyz[1], state.xyz[2]);
      mount(h, state.parent);
      return;
    }
    if (isXyz(state.position)) h.holder.position.set(state.position[0], state.position[1], state.position[2]);
    if (isNumber(state.yaw)) h.holder.rotation.set(h.holder.rotation.x, h.holder.rotation.y, state.yaw, 'ZYX');
    if (h.robot) {
      for (const [name, value] of Object.entries(state.joints ?? {})) {
        if (isNumber(value) && h.robot.jointNodes.has(name)) h.robot.setJoint(name, value);
      }
    }
  }

  /** Hang a holder on its parent device when that one is drawn, else on the site. */
  function mount(h: Held, parentId: unknown): void {
    const parent = typeof parentId === 'string' && parentId !== 'site' && parentId !== h.device.id ? held.get(deviceIdOf(parentId) ?? parentId) : undefined;
    let to = parent ? parent.holder : site;
    // Never under itself (two devices naming each other as parent)
    for (let up = to; up; up = up.parent) if (up === h.holder) { to = site; break; }
    if (h.holder.parent !== to) to.add(h.holder);
  }

  function disposeObject(object: any): void {
    object.traverse?.((node: any) => {
      node.geometry?.dispose?.();
      for (const material of [node.material].flat()) {
        material?.map?.dispose?.();
        material?.dispose?.();
      }
    });
  }

  function drop(id: string): void {
    const h = held.get(id);
    if (!h) return;
    h.holder.parent?.remove(h.holder);
    disposeObject(h.holder);
    held.delete(id);
    builds.delete(id);
    store.delete(id);
  }

  function boxOf(device: Json): any {
    const size = isXyz(device.shape?.sizeM) && device.shape.sizeM.every((n: number) => n > 0) ? device.shape.sizeM : DEFAULT_BOX;
    const colour = typeof device.render?.colorHex === 'string' && /^#[0-9a-f]{6}$/i.test(device.render.colorHex) ? device.render.colorHex : DEFAULT_BOX_COLOUR;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({ color: Number.parseInt(colour.slice(1), 16) }),
    );
    mesh.name = 'box';
    return mesh;
  }

  async function buildInto(h: Held, product: string): Promise<void> {
    const mine = ++generation;
    builds.set(h.device.id, mine);
    try {
      const { bundleUrl, meshUrl } = await opts.resolveBundle(product);
      const response = await fetchImpl(bundleUrl);
      if (!response.ok) throw new Error(`${bundleUrl}: ${response.status}`);
      const robot = await build.buildRobot(await response.json(), { meshUrlOf: meshUrl, fetchImpl, label: product });
      if (builds.get(h.device.id) !== mine) { disposeObject(robot.object); return; }
      // The builder lifts its object onto the floor in three's y; here the lift is ROS +Z
      const lift = new THREE.Group();
      lift.name = 'lift';
      lift.position.z = robot.object.position.y;
      lift.add(robot.rosRoot);
      h.holder.add(lift);
      h.robot = robot;
      showState(h);
    } catch (error) {
      if (builds.get(h.device.id) !== mine) return;
      missingList.push({ deviceId: h.device.id, product, error: String((error as Error)?.message ?? error) });
    }
  }

  function drawFloor(floor: PaneScene['floor']): void {
    if (floorLine) { site.remove(floorLine); disposeObject(floorLine); floorLine = null; }
    if (!floor || !Array.isArray(floor.corners) || floor.corners.length !== 4) return;
    const points = floor.corners.map(siteToRos).map(([x, y, z]) => new THREE.Vector3(x, y, z + ABOVE_GRID));
    floorLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: COLOURS.floor }));
    floorLine.name = 'floor';
    site.add(floorLine);
  }

  function deviceIdOf(outside: string): string | undefined {
    return own(current.names, outside) ?? own(current.streamNames, outside);
  }

  async function setScene(next: PaneScene): Promise<void> {
    current = {
      site: next?.site || 'local',
      siteFrameId: next?.siteFrameId ?? null,
      background: next?.background ?? null,
      camera: next?.camera ?? null,
      floor: next?.floor ?? null,
      devices: Array.isArray(next?.devices) ? next.devices.filter((d) => d && typeof d.id === 'string') : [],
      names: next?.names ?? {},
      ...(next?.streamNames ? { streamNames: next.streamNames } : {}),
    };
    const ids = new Set(current.devices.map((d) => d.id));
    for (const id of [...held.keys()]) {
      const h = held.get(id)!;
      const device = current.devices.find((d) => d.id === id);
      if (!ids.has(id) || !device || lookOf(device) !== h.look) drop(id);
    }
    for (let i = missingList.length - 1; i >= 0; i -= 1) if (!held.has(missingList[i].deviceId)) missingList.splice(i, 1);

    const waits: Promise<void>[] = [];
    for (const device of current.devices) {
      let h = held.get(device.id);
      if (!h) {
        const holder = new THREE.Group();
        holder.name = `device:${device.id}`;
        holder.rotation.order = 'ZYX';
        const isItem = device.type === 'item';
        h = { device, look: lookOf(device), pose: '', holder, robot: null, isItem };
        held.set(device.id, h);
        if (isItem) holder.add(boxOf(device));
        else if (typeof device.product === 'string' && device.product) waits.push(buildInto(h, device.product));
      }
      h.device = device;
      const pose = JSON.stringify(device.pose ?? null);
      if (pose !== h.pose) {
        h.pose = pose;
        setPose(h);
      }
    }
    // Mounted on another device that is drawn, else on the site; then the latest states again
    for (const h of held.values()) {
      mount(h, h.isItem ? store.get(h.device.id)?.parent ?? h.device.parent : h.device.parent);
      showState(h);
    }
    drawFloor(current.floor);
    setCamera(current.camera ?? null);
    await Promise.all(waits);
  }

  function applyState(message: { topic: string; payload: Json }): boolean {
    const topic = parseTopic(message?.topic);
    if (!topic || topic.kind !== 'state' || topic.site !== current.site) return false;
    const id = deviceIdOf(topic.id);
    const h = id === undefined ? undefined : held.get(id);
    if (!h || !message.payload || typeof message.payload !== 'object') return false;
    if (!storeState(store, { id: h.device.id, type: h.isItem ? 'item' : 'mover' }, message.payload)) return false;
    showState(h);
    return true;
  }

  function clearStates(): void {
    store.clear();
    showHeld();
  }

  // ---- the picture and the camera ----

  /** The picture's own size: the background's, else the solved camera's. */
  function pictureSize(): { width: number; height: number } | null {
    if (mediaSize) return mediaSize;
    if (solved && solved.intr.width > 0 && solved.intr.height > 0) return { width: solved.intr.width, height: solved.intr.height };
    return null;
  }

  function layout(): void {
    const width = Math.max(1, canvas.clientWidth || 1);
    const height = Math.max(1, canvas.clientHeight || 1);
    renderer.setSize(width, height, false);
    const size = pictureSize();
    rect = size ? fitRect(width, height, size.width, size.height) : { x: 0, y: 0, w: width, h: height };
    const place = { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` };
    if (media?.style) Object.assign(media.style, place);
    if (opts.overlay?.style) Object.assign(opts.overlay.style, place);
    // WebGL counts a viewport's y from the bottom
    renderer.setViewport(rect.x, height - rect.y - rect.h, rect.w, rect.h);
    applyCamera();
  }

  /** PS.com video-view.js applyCamera: through the solved camera, else the orbit camera. */
  function applyCamera(): void {
    camera.near = 0.05;
    camera.far = 600;
    if (solved) {
      const { intr, extr } = solved;
      const r = extr.R;
      const f = frustumOf(intr);
      camera.fov = f.fovDeg;
      // setViewOffset sets the aspect to the full frame's: the stretched one goes in after it
      camera.setViewOffset(f.view.fullWidth, f.view.fullHeight, f.view.offsetX, f.view.offsetY, f.view.width, f.view.height);
      camera.aspect = f.aspect;
      camera.position.set(
        -(r[0] * extr.t[0] + r[3] * extr.t[1] + r[6] * extr.t[2]),
        -(r[1] * extr.t[0] + r[4] * extr.t[1] + r[7] * extr.t[2]),
        -(r[2] * extr.t[0] + r[5] * extr.t[1] + r[8] * extr.t[2]),
      );
      const basis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(r[0], r[1], r[2]),
        new THREE.Vector3(-r[3], -r[4], -r[5]),
        new THREE.Vector3(-r[6], -r[7], -r[8]),
      );
      camera.quaternion.setFromRotationMatrix(basis);
    } else {
      camera.clearViewOffset();
      camera.aspect = rect.w / rect.h;
      camera.fov = 50;
      const eye = orbitEye(orbit);
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(orbit.target.x, orbit.target.y, orbit.target.z);
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  function setCamera(next: SolvedCamera | null): void {
    const usable = next && next.intr && next.extr && Array.isArray(next.extr.R) && next.extr.R.length === 9 && Array.isArray(next.extr.t) ? next : null;
    solved = usable;
    layout();
  }

  function setBackground(next: any, size: { width: number; height: number } | null): void {
    media = next;
    mediaSize = next && size && size.width > 0 && size.height > 0 ? size : null;
    // Over a picture: nothing but the 3D is drawn (no sky, no grid)
    scene.background = media ? null : new THREE.Color(COLOURS.sky);
    grid.visible = !media;
    layout();
  }

  function fit(): void {
    if (solved) return;
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(site);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(50);
    const across = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * (rect.w / rect.h)));
    const distance = Math.max(1, (Math.max(sphere.radius, 0.4) / Math.sin(across / 2)) * 1.1);
    const { min, max } = DISTANCE_LIMITS;
    orbit = { ...orbit, target: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z }, distance: Math.min(max, Math.max(min, distance)) };
    applyCamera();
  }

  // ---- points of the page ----

  function canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const box = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return { x: clientX - box.left - rect.x, y: clientY - box.top - rect.y };
  }

  function pixelAt(clientX: number, clientY: number): { u: number; v: number } | null {
    const size = pictureSize();
    if (!size) return null;
    const p = canvasPoint(clientX, clientY);
    if (p.x < 0 || p.y < 0 || p.x > rect.w || p.y > rect.h) return null;
    return { u: (p.x / rect.w) * size.width, v: (p.y / rect.h) * size.height };
  }

  function floorPointAt(clientX: number, clientY: number): [number, number] | null {
    let hit: { x: number; z: number } | null = null;
    if (solved) {
      const pixel = pixelAt(clientX, clientY);
      if (!pixel) return null;
      hit = floorHit(rayThroughPixel(solved.intr, solved.extr, pixel.u, pixel.v), 0);
    } else {
      const p = canvasPoint(clientX, clientY);
      if (p.x < 0 || p.y < 0 || p.x > rect.w || p.y > rect.h) return null;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((p.x / rect.w) * 2 - 1, -(p.y / rect.h) * 2 + 1), camera);
      const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      hit = point ? { x: point.x, z: point.z } : null;
    }
    if (!hit) return null;
    // three (the site frame, y up) to ROS
    return [hit.x + 0, 0 - hit.z];
  }

  // ---- one picture of it all ----

  /** Every device back at its pose and its joints at zero, then the states held now shown. */
  function showHeld(): void {
    for (const h of held.values()) {
      setPose(h);
      zeroJoints(h);
      mount(h, h.device.parent);
      showState(h);
    }
  }

  function frame(o: { states?: { topic: string; payload: Json }[]; maxSide?: number } = {}): Promise<Blob> {
    const size = pictureSize() ?? { width: Math.round(rect.w), height: Math.round(rect.h) };
    const scale = isNumber(o.maxSide) && o.maxSide > 0 ? Math.min(1, o.maxSide / Math.max(size.width, size.height)) : 1;
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const out = opts.makeCanvas ? opts.makeCanvas() : document.createElement('canvas');
    out.width = width;
    out.height = height;
    const context = out.getContext('2d');
    if (media) context.drawImage(media, 0, 0, width, height);
    const live = o.states ? new Map(store) : null;
    try {
      if (o.states) {
        clearStates();
        for (const message of o.states) applyState(message);
      }
      // The 3D is drawn now and copied before anything else runs: the drawing buffer is still whole
      renderer.render(scene, camera);
      const ratio = renderer.getPixelRatio?.() ?? 1;
      context.drawImage(canvas, rect.x * ratio, rect.y * ratio, rect.w * ratio, rect.h * ratio, 0, 0, width, height);
    } finally {
      if (live) {
        store.clear();
        for (const [id, held] of live) store.set(id, held);
        showHeld();
      }
    }
    return new Promise((resolve, reject) => {
      out.toBlob((blob: Blob | null) => (blob ? resolve(blob) : reject(new Error('the frame could not be made'))), 'image/png');
    });
  }

  // ---- the orbit camera: dragged to turn, wheeled to zoom ----

  let drag: { x: number; y: number } | null = null;
  const onDown = (event: any) => {
    if (solved || !canOrbit() || event.button > 0) return;
    drag = { x: event.clientX, y: event.clientY };
  };
  const onMove = (event: any) => {
    if (!drag) return;
    orbit = dragOrbit(orbit, event.clientX - drag.x, event.clientY - drag.y);
    drag = { x: event.clientX, y: event.clientY };
    applyCamera();
  };
  const onUp = () => { drag = null; };
  const onWheel = (event: any) => {
    if (solved) return;
    event.preventDefault?.();
    orbit = zoomOrbit(orbit, wheelFactor(event.deltaY));
    applyCamera();
  };
  const handlers: [string, (event: any) => void][] = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['wheel', onWheel]];
  for (const [type, fn] of handlers) canvas.addEventListener?.(type, fn, type === 'wheel' ? { passive: false } : undefined);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  observer?.observe(canvas);

  setBackground(null, null);
  renderer.setAnimationLoop((): void => { renderer.render(scene, camera); });
  void now; // not used yet (the option stays for the stages the tests make)

  return {
    setScene,
    applyState,
    clearStates,
    setCamera,
    setBackground,
    fit,
    layout,
    frame,
    pixelAt,
    floorPointAt,
    missing: () => missingList.map((m) => ({ ...m })),
    placeOf(id) {
      const h = held.get(id);
      if (!h) return null;
      return { position: h.holder.position.toArray() as Xyz, rpy: [h.holder.rotation.x, h.holder.rotation.y, h.holder.rotation.z] };
    },
    jointOf: (id, name) => held.get(id)?.robot?.jointNodes.get(name)?.value,
    scene,
    camera,
    dispose() {
      renderer.setAnimationLoop(null);
      for (const [type, fn] of handlers) canvas.removeEventListener?.(type, fn);
      observer?.disconnect();
      disposeObject(scene);
      renderer.dispose();
    },
  };
}
