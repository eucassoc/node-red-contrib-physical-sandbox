/**
 * A Node-RED editor for the editor side of the link: the `<script data-ps-part="editor-link">` of
 * src/plugin/editor.html, run as it is (node:vm) against a fake `RED` and `$`:
 *
 * - `RED.comms.subscribe` keeps the callbacks; `deliver(topic, data)` calls those whose topic
 *   matches, as the editor's comms does (`#` at the end matches the rest).
 * - `RED.nodes.createCompleteNodeSet`, `RED.view.importNodes`, `RED.notify` and
 *   `RED.workspaces.active` note how they were called (as plain JSON: the script's objects come
 *   from another realm). `importNodes` gives each node a new id, as `generateIds` does.
 * - `$.ajax` notes each body sent and answers with `post(body)` (by default `{}`); a test wires it
 *   to the plugin's route with `fetch`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const EDITOR_HTML = join(import.meta.dirname, '..', '..', 'src', 'plugin', 'editor.html');

/** The editor side of the link, as its own script. */
export function editorLinkScript(): string {
  const html = readFileSync(EDITOR_HTML, 'utf8');
  const m = /<script[^>]*data-ps-part="editor-link"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no <script data-ps-part="editor-link"> in editor.html');
  return m[1];
}

const plain = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export interface FakeEditor {
  deliver(topic: string, data: unknown): void;
  /** The bodies the editor posted to the answer route, in order. */
  posted: any[];
  /** The ajax settings of each post (without the body). */
  requests: { url: string; type: string; contentType: string }[];
  nodeSetCalls: any[];
  imports: { nodes: any[]; options: any }[];
  notes: { text: string; type: unknown }[];
}

export function fakeEditor(o: {
  post?: (body: any) => Promise<any>;
  nodeSet?: any[];
  workspace?: string;
  /** What importNodes gives back; by default `{nodeMap}` with a new id for each node. */
  importResult?: (nodes: any[]) => unknown;
} = {}): FakeEditor {
  const subscriptions: { topic: string; fn: (topic: string, data: unknown) => void }[] = [];
  const editor: FakeEditor = {
    posted: [],
    requests: [],
    nodeSetCalls: [],
    imports: [],
    notes: [],
    deliver(topic, data) {
      for (const s of subscriptions) {
        const matches = s.topic === topic || (s.topic.endsWith('/#') && topic.startsWith(s.topic.slice(0, -1)));
        if (matches) s.fn(topic, plain(data));
      }
    },
  };
  let nextId = 1;
  const RED = {
    comms: { subscribe: (topic: string, fn: (topic: string, data: unknown) => void) => { subscriptions.push({ topic, fn }); } },
    nodes: {
      createCompleteNodeSet(opts: unknown) {
        editor.nodeSetCalls.push(plain(opts));
        return plain(o.nodeSet ?? [{ id: 'tab1', type: 'tab', label: 'Flow 1' }]);
      },
    },
    view: {
      importNodes(nodes: any[], options: unknown) {
        editor.imports.push({ nodes: plain(nodes), options: plain(options) });
        if (o.importResult) return o.importResult(nodes);
        const nodeMap: Record<string, { id: string }> = {};
        for (const n of nodes) nodeMap[n.id] = { id: `new-${nextId++}` };
        return { nodeMap };
      },
    },
    notify(text: string, type: unknown) { editor.notes.push({ text, type: plain(type) }); },
    workspaces: { active: () => o.workspace ?? 'tab1' },
  };
  const $ = {
    ajax(settings: { url: string; type: string; contentType: string; data: string }) {
      const body = JSON.parse(settings.data);
      editor.posted.push(body);
      editor.requests.push({ url: settings.url, type: settings.type, contentType: settings.contentType });
      return (o.post ?? (async () => ({})))(body);
    },
  };
  vm.runInNewContext(editorLinkScript(), { RED, $, console, setTimeout, clearTimeout }, { filename: 'editor.html#editor-link' });
  return editor;
}

/** Wait until the promises started so far (and their HTTP round trips) have gone on. */
export const settle = (ms = 0) => new Promise((done) => setTimeout(done, ms));
