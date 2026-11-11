/**
 * How the pane hears the hub and talks to it.
 *
 * Hearing: inside the editor's sidebar the editor forwards what it hears on `ps-pane/#`
 * (`RED.comms.subscribe` → `postMessage`); the iframe says `ready` once it listens and the
 * editor then sends the retained ones it holds. In a window of its own the pane opens Node-RED's
 * `/comms` itself, sends `{auth: token}` first when the editor has a token (Node-RED keeps it in
 * `localStorage['auth-tokens' + suffix]`), and subscribes to `ps-pane/#`, which brings the retained
 * scene, snapshot and status at once.
 *
 * Talking: the routes under `physical-sandbox/`, every POST as JSON or with `X-PS-Pane: 1`, with
 * the editor's token when it has one.
 */

type Json = Record<string, any>;

export const PANE_TOPIC = 'ps-pane/#';
/** What the iframe and the editor say to each other through postMessage. */
export const FROM_EDITOR = 'ps-pane-message';
export const PANE_READY = 'ps-pane-ready';

export interface PaneHandlers {
  scene(scene: Json): void;
  state(message: Json): void;
  snapshot(messages: Json[]): void;
  status(status: Json): void;
}

/** Send one comms message to its handler; anything else is let go. */
export function dispatch(topic: unknown, data: unknown, handlers: PaneHandlers): void {
  if (data === null || typeof data !== 'object') return;
  if (topic === 'ps-pane/scene' && !Array.isArray(data)) handlers.scene(data as Json);
  else if (topic === 'ps-pane/state' && !Array.isArray(data)) handlers.state(data as Json);
  else if (topic === 'ps-pane/snapshot' && Array.isArray(data)) handlers.snapshot(data);
  else if (topic === 'ps-pane/status' && !Array.isArray(data)) handlers.status(data as Json);
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
    const subscribe = () => { socket.send(JSON.stringify({ subscribe: PANE_TOPIC })); opts.onConnected?.(true); };
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

/** Hear the hub through the editor that holds this iframe. */
export function listenToEditor(win: any, handlers: PaneHandlers): { close(): void } {
  const onMessage = (event: { origin: string; source: unknown; data: any }) => {
    if (event.origin !== win.location.origin || event.source !== win.parent) return;
    if (event.data?.type === FROM_EDITOR) dispatch(event.data.topic, event.data.data, handlers);
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

/** The routes under `<base>physical-sandbox/`. */
export function createApi(opts: { base: string; token: string | null; fetchImpl?: (url: string, init?: any) => Promise<any> }): Api {
  const doFetch = opts.fetchImpl ?? ((url: string, init?: any) => fetch(url, init));
  const url = (path: string) => `${opts.base}physical-sandbox/${path}`;
  const auth = (): Record<string, string> => (opts.token ? { Authorization: `Bearer ${opts.token}` } : {});

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
    upload: async (path, file, name) => answer(await doFetch(`${url(path)}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...auth(), 'X-PS-Pane': '1', 'Content-Type': 'application/octet-stream' },
      body: file,
    })),
  };
}
