/**
 * How the pane hears the hub and talks to it.
 *
 * Hearing: inside the editor's sidebar the editor forwards what it hears on `ps-pane/#`
 * (`RED.comms.subscribe` → `postMessage`); the iframe says `ready` once it listens and the
 * editor then sends its token (null without adminAuth) and the retained ones it holds. In a window of its own the pane opens Node-RED's
 * `/comms` itself, sends `{auth: token}` first when the editor has a token (Node-RED keeps it in
 * `localStorage['auth-tokens' + suffix]`), and subscribes to `ps-pane/#`, which brings the retained
 * scene, snapshot and status at once, and to `ps-editor/#`, where the plugin asks the open editors
 * and panes (the editor forwards those to the iframe too). A pane answers `ping` and `frames`.
 *
 * Talking: the routes under `physical-sandbox/`, every POST as JSON or with `X-PS-Pane: 1`, with
 * the editor's token when it has one, always as `Authorization: Bearer`, never in an address.
 */

type Json = Record<string, any>;

export const PANE_TOPIC = 'ps-pane/#';
export const EDITOR_TOPIC = 'ps-editor/#';
/** What the iframe and the editor say to each other through postMessage. */
export const FROM_EDITOR = 'ps-pane-message';
export const PANE_READY = 'ps-pane-ready';
export const EDITOR_TOKEN = 'ps-pane-token';

export interface PaneHandlers {
  scene(scene: Json): void;
  state(message: Json): void;
  snapshot(messages: Json[]): void;
  status(status: Json): void;
  /** A request of the plugin on the editor link (src/plugin/editor-link.ts). */
  request?(request: EditorRequest): void;
}

export interface EditorRequest { id: string; op: string; args?: unknown }

/** Send one comms message to its handler; anything else is let go. */
export function dispatch(topic: unknown, data: unknown, handlers: PaneHandlers): void {
  if (data === null || typeof data !== 'object') return;
  if (topic === 'ps-pane/scene' && !Array.isArray(data)) handlers.scene(data as Json);
  else if (topic === 'ps-pane/state' && !Array.isArray(data)) handlers.state(data as Json);
  else if (topic === 'ps-pane/snapshot' && Array.isArray(data)) handlers.snapshot(data);
  else if (topic === 'ps-pane/status' && !Array.isArray(data)) handlers.status(data as Json);
  else if (topic === 'ps-editor/request' && !Array.isArray(data) && typeof (data as Json).id === 'string' && typeof (data as Json).op === 'string') {
    handlers.request?.(data as EditorRequest);
  }
}

/** Node-RED's admin root from the pane's own path (`<root>physical-sandbox/pane`), ending in `/`. */
export function adminRootOf(pathname: string): string {
  const at = pathname.lastIndexOf('physical-sandbox/pane');
  return at >= 0 ? pathname.slice(0, at) : '/';
}

/** The editor's access token, read as Node-RED's editor keeps it, or null. */
export function tokenOf(storage: { getItem(key: string): string | null } | null | undefined, adminRoot: string): string | null {
  try {
    const suffix = adminRoot.slice(0, -1).replace(/\//g, '-');
    const kept = JSON.parse(storage?.getItem(`auth-tokens${suffix}`) ?? 'null');
    return typeof kept?.access_token === 'string' && kept.access_token ? kept.access_token : null;
  } catch {
    return null;
  }
}

/** The `/comms` WebSocket address under the admin root. */
export function commsUrlOf(location: { protocol: string; host: string }, adminRoot: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${adminRoot}comms`;
}

/**
 * Hear the hub over `/comms` (a window of its own). Opens again 1.5 s after it closes, until
 * `close()`.
 */
export function connectComms(opts: {
  url: string;
  token: string | null;
  handlers: PaneHandlers;
  WebSocketImpl?: any;
  retryMs?: number;
  onConnected?: (connected: boolean) => void;
}): { close(): void } {
  const Socket = opts.WebSocketImpl ?? WebSocket;
  let closed = false;
  let socket: any = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    socket = new Socket(opts.url);
    const subscribe = () => {
      socket.send(JSON.stringify({ subscribe: PANE_TOPIC }));
      socket.send(JSON.stringify({ subscribe: EDITOR_TOPIC }));
      opts.onConnected?.(true);
    };
    socket.onopen = () => {
      if (opts.token) socket.send(JSON.stringify({ auth: opts.token }));
      else subscribe();
    };
    socket.onmessage = (event: { data: string }) => {
      let message: any;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message && !Array.isArray(message) && message.auth) {
        if (message.auth === 'ok') subscribe();
        return;
      }
      for (const m of Array.isArray(message) ? message : [message]) if (m && typeof m.topic === 'string') dispatch(m.topic, m.data, opts.handlers);
    };
    socket.onclose = () => {
      opts.onConnected?.(false);
      if (!closed) retry = setTimeout(open, opts.retryMs ?? 1500);
    };
  };
  open();
  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close?.();
    },
  };
}

/** Hear the hub through the editor that holds this iframe; `onToken` is given the editor's token (or null). */
export function listenToEditor(win: any, handlers: PaneHandlers, onToken?: (token: string | null) => void): { close(): void } {
  // With onToken, what the editor forwards before its token is let go: it would start requests
  // without the token. The editor sends the retained ones again right after the token.
  let heard = !onToken;
  const onMessage = (event: { origin: string; source: unknown; data: any }) => {
    if (event.origin !== win.location.origin || event.source !== win.parent) return;
    if (event.data?.type === FROM_EDITOR) {
      if (heard) dispatch(event.data.topic, event.data.data, handlers);
    } else if (event.data?.type === EDITOR_TOKEN) {
      heard = true;
      onToken?.(typeof event.data.token === 'string' && event.data.token ? event.data.token : null);
    }
  };
  win.addEventListener('message', onMessage);
  win.parent.postMessage({ type: PANE_READY }, win.location.origin);
  return { close: () => win.removeEventListener('message', onMessage) };
}

/** A refusal of a route: the words for the person (`error`) and the code (`reason`). */
export class PaneError extends Error {
  constructor(message: string, readonly reason: string, readonly status: number) { super(message); }
}

export interface Api {
  get(path: string): Promise<Json>;
  /**
   * A POST. `asText` sends the JSON as text with the pane's header: Node-RED reads JSON bodies only
   * up to 5 MB before the routes, which read a text body up to 20 MB (a long record).
   */
  post(path: string, body?: Json, opts?: { asText?: boolean }): Promise<Json>;
  /** A file as its raw bytes (the background), with its name. */
  upload(path: string, file: Blob, name: string): Promise<Json>;
  /** The address of a route, for an <img> or a fetch of a file. */
  url(path: string): string;
}

/** The routes under `<base>physical-sandbox/`; `token()` is read at each request. */
export function createApi(opts: { base: string; token: () => string | null; fetchImpl?: (url: string, init?: any) => Promise<any> }): Api {
  const doFetch = opts.fetchImpl ?? ((url: string, init?: any) => fetch(url, init));
  const url = (path: string) => `${opts.base}physical-sandbox/${path}`;
  const auth = (): Record<string, string> => {
    const token = opts.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  async function answer(res: any): Promise<Json> {
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw new PaneError(typeof body?.error === 'string' ? body.error : `${res.status}`, typeof body?.reason === 'string' ? body.reason : 'failed', res.status);
    return body ?? {};
  }

  return {
    url,
    get: async (path) => answer(await doFetch(url(path), { headers: auth(), cache: 'no-store' })),
    post: async (path, body, o = {}) => {
      const headers: Record<string, string> = { ...auth() };
      if (body === undefined) headers['X-PS-Pane'] = '1';
      else if (o.asText) Object.assign(headers, { 'X-PS-Pane': '1', 'Content-Type': 'text/plain;charset=utf-8' });
      else headers['Content-Type'] = 'application/json';
      return answer(await doFetch(url(path), { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    },
    // The file's name goes in a header, not in the address (addresses end up in logs)
    upload: async (path, file, name) => answer(await doFetch(url(path), {
      method: 'POST',
      headers: { ...auth(), 'X-PS-Pane': '1', 'Content-Type': 'application/octet-stream', 'X-PS-Name': encodeURIComponent(name) },
      body: file,
    })),
  };
}

/** What a pane says to `frames` until it can hand over its picture (Task 7 of the agent tools). */
export const PANE_FRAMES_NOT_YET = 'この右ペインはまだ映像を渡せません / This pane cannot hand over its picture yet';

/**
 * A pane's answer on the editor link: `ping` (it is open: `{kind: 'pane', page}`) and `frames`;
 * the editor's ops are left to the editor (null). An answer that is refused (the request is over,
 * no permission) is let go.
 */
export function answerEditorRequest(api: Api, request: EditorRequest, page: string): Promise<void> | null {
  let body: Json;
  if (request.op === 'ping') body = { id: request.id, ok: true, result: { kind: 'pane', page } };
  else if (request.op === 'frames') body = { id: request.id, ok: false, error: PANE_FRAMES_NOT_YET };
  else return null;
  return api.post('editor/answer', body).then(() => undefined, () => undefined);
}
