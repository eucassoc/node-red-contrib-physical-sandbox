/**
 * A Node-RED editor for the editor side of the link: the `<script data-ps-part="editor-link">` of
 * src/plugin/editor.html, run as it is (node:vm) against a fake `RED` and `$`:
 *
 * - `RED.comms.subscribe` keeps the callbacks; `deliver(topic, data)` calls those whose topic
 *   matches, as the editor's comms does (`#` at the end matches the rest).
 * - The editor holds a workspace: `nodeSet` at the start, and what is imported into it.
 *   `RED.nodes.createCompleteNodeSet`, `RED.view.importNodes`, `RED.notify` and
 *   `RED.workspaces.active` note how they were called (as plain JSON: the script's objects come
 *   from another realm). `importNodes` works as Node-RED's does on the points that matter here:
 *   with `generateIds` each node gets a new id (its wires and tab follow), without it an id that is
 *   already there is refused (`import_conflict`); with `addFlow` the nodes without a tab go into a
 *   new tab, which becomes the active one (a tab the proposal brings itself is added but not shown,
 *   as in Node-RED); it answers `{nodeMap}` with each new node (not tabs) under its old id and under
 *   its new one, as Node-RED's does. As with Node-RED's touch import, it does not mark the workspace
 *   changed: `RED.nodes.dirty(value)` sets it (noted in `dirtyCalls`), `dirty()` tells it.
 * - `RED.workspaces.show(id)` makes that tab the active one (noted in `shown`); `workspace` is the
 *   tab open at the start.
 * - `RED.nodes.getType` knows every type, or only `knownTypes` when given.
 * - `$.ajax` notes each body sent and answers with `post(body, settings)` (by default `{}`); a test
 *   wires it to the plugin's route with `fetch`, sending `settings` as they are.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const EDITOR_HTML = join(import.meta.dirname, '..', '..', 'src', 'plugin', 'editor.html');

/** One script of editor.html by its `data-ps-part`. */
export function editorScript(part: string): string {
  const html = readFileSync(EDITOR_HTML, 'utf8');
  const m = new RegExp(`<script[^>]*data-ps-part="${part}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error(`no <script data-ps-part="${part}"> in editor.html`);
  return m[1];
}

/** The editor side of the link, as its own script, with the words it shares with the plugin's script. */
export function editorLinkScript(): string {
  return `${editorScript('words')}\n${editorScript('editor-link')}`;
}

const plain = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** What the editor passes to `$.ajax` for a post. */
export interface AjaxSettings { url: string; type: string; contentType: string; headers?: Record<string, string>; data: string }

export interface FakeEditor {
  deliver(topic: string, data: unknown): void;
  /** The bodies the editor posted to the answer route, in order. */
  posted: any[];
  /** The ajax settings of each post (without the body). */
  requests: { url: string; type: string; contentType: string; headers?: Record<string, string> }[];
  nodeSetCalls: any[];
  imports: { nodes: any[]; options: any }[];
  notes: { text: string; type: unknown }[];
  dirtyCalls: unknown[];
  shown: string[];
  /** The fake RED the script runs against. */
  red: any;
  /** The workspace now: the starting node set and what was imported. */
  nodes(): any[];
}

export function fakeEditor(o: {
  post?: (body: any, settings: AjaxSettings) => Promise<any>;
  nodeSet?: any[];
  workspace?: string;
  /** What importNodes gives back instead of importing. */
  importResult?: (nodes: any[]) => unknown;
  /** The types installed in this editor; every type when not given. */
  knownTypes?: string[];
  /** What RED.i18n.lang() says (default ja). */
  language?: string;
} = {}): FakeEditor {
  const subscriptions: { topic: string; fn: (topic: string, data: unknown) => void }[] = [];
  const workspace: any[] = plain(o.nodeSet ?? [{ id: 'tab1', type: 'tab', label: 'Flow 1' }]);
  let active = o.workspace ?? workspace.find((n) => n.type === 'tab')?.id ?? 'tab1';
  const editor: FakeEditor = {
    posted: [],
    requests: [],
    nodeSetCalls: [],
    imports: [],
    notes: [],
    dirtyCalls: [],
    shown: [],
    red: null,
    nodes: () => plain(workspace),
    deliver(topic, data) {
      for (const s of subscriptions) {
        const matches = s.topic === topic || (s.topic.endsWith('/#') && topic.startsWith(s.topic.slice(0, -1)));
        if (matches) s.fn(topic, plain(data));
      }
    },
  };
  let nextId = 1;
  let dirty = false;
  function importInto(given: any[], options: { generateIds?: boolean; addFlow?: boolean }) {
    const nodes: any[] = plain(given);
    if (!options.generateIds && nodes.some((n) => workspace.some((w) => w.id === n.id))) {
      throw Object.assign(new Error('import_conflict'), { code: 'import_conflict' });
    }
    const ids = new Map<string, string>(nodes.map((n) => [n.id, options.generateIds ? `new-${nextId++}` : n.id]));
    const renamed = (id: string) => ids.get(id) ?? id;
    let tab: string | null = null;
    if (options.addFlow && nodes.some((n) => n.type !== 'tab' && !n.z)) {
      tab = `new-tab-${nextId++}`;
      workspace.push({ id: tab, type: 'tab', label: `Flow ${nextId}` });
    }
    const nodeMap: Record<string, { id: string; z?: string }> = {};
    for (const n of nodes) {
      const node = { ...n, id: renamed(n.id) };
      if (n.type !== 'tab') node.z = n.z ? renamed(n.z) : (tab ?? active);
      if (Array.isArray(n.wires)) node.wires = n.wires.map((port: unknown) => (Array.isArray(port) ? port.map((w) => renamed(String(w))) : port));
      workspace.push(node);
      if (n.type !== 'tab') nodeMap[n.id] = nodeMap[node.id] = { ...node };
    }
    if (tab) active = tab;
    return { nodeMap };
  }
  const RED = {
    i18n: { lang: () => o.language ?? 'ja' },
    comms: { subscribe: (topic: string, fn: (topic: string, data: unknown) => void) => { subscriptions.push({ topic, fn }); } },
    nodes: {
      createCompleteNodeSet(opts: unknown) {
        editor.nodeSetCalls.push(plain(opts));
        return plain(workspace);
      },
      dirty(value?: unknown) {
        if (value === undefined) return dirty;
        editor.dirtyCalls.push(plain(value));
        dirty = Boolean(value);
        return undefined;
      },
      getType: (type: string) => (o.knownTypes === undefined || o.knownTypes.includes(type) ? { category: 'common' } : undefined),
    },
    view: {
      importNodes(nodes: any[], options: any) {
        editor.imports.push({ nodes: plain(nodes), options: plain(options) });
        if (o.importResult) return o.importResult(nodes);
        return importInto(nodes, options ?? {});
      },
    },
    notify(text: string, type: unknown) { editor.notes.push({ text, type: plain(type) }); },
    workspaces: {
      active: () => active,
      show(id: string) { editor.shown.push(id); active = id; },
    },
  };
  editor.red = RED;
  const $ = {
    ajax(settings: AjaxSettings) {
      const body = JSON.parse(settings.data);
      editor.posted.push(body);
      editor.requests.push({ url: settings.url, type: settings.type, contentType: settings.contentType, ...(settings.headers ? { headers: plain(settings.headers) } : {}) });
      return (o.post ?? (async () => ({})))(body, plain(settings));
    },
  };
  vm.runInNewContext(editorLinkScript(), { RED, $, console, setTimeout, clearTimeout }, { filename: 'editor.html#editor-link' });
  return editor;
}

/** Wait until the promises started so far (and their HTTP round trips) have gone on. */
export const settle = (ms = 0) => new Promise((done) => setTimeout(done, ms));
