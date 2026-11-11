// The editor side of the link (the editor-link script in src/plugin/editor.html), run against a
// fake RED: what it answers for flows, propose and ping, what it leaves alone, and two editors
// open at once against the plugin's real link and route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANSWER_ROUTE, createEditorLink } from '../src/plugin/editor-link.js';
import { fakeEditor, settle } from './helpers/fake-editor.js';
import { fakeRed } from './helpers/fake-red.js';

const PROPOSED = 'エージェントの提案を読み込みました。確かめてから Deploy してください';

test('flows: the complete node set without credentials, posted as JSON to the answer route', async () => {
  const editor = fakeEditor({ nodeSet: [{ id: 't', type: 'tab' }, { id: 'n', type: 'inject', z: 't' }] });
  editor.deliver('ps-editor/request', { id: 'r1', op: 'flows', args: {} });
  await settle();
  assert.deepEqual(editor.nodeSetCalls, [{ credentials: false }]);
  assert.deepEqual(editor.posted, [{ id: 'r1', ok: true, result: [{ id: 't', type: 'tab' }, { id: 'n', type: 'inject', z: 't' }] }]);
  assert.deepEqual(editor.requests, [{ url: 'physical-sandbox/editor/answer', type: 'POST', contentType: 'application/json' }],
    'a relative address: the editor\'s own ajax setup adds the admin root and its token');
});

test('propose: a claim first; once granted, importNodes with the exact options, the notice, and the answer with the ticket', async () => {
  const editor = fakeEditor({
    workspace: 'new-tab',
    post: async (body) => (body.claim ? { granted: true, ticket: 'T1' } : { taken: true }),
  });
  const nodes = [{ id: 'a', type: 'inject', wires: [['b']] }, { id: 'b', type: 'ps play' }];
  editor.deliver('ps-editor/request', { id: 'r2', op: 'propose', args: { nodes, newTab: true } });
  await settle();
  assert.deepEqual(editor.imports, [{ nodes, options: { addFlow: true, generateIds: true, touchImport: true, notify: true } }]);
  assert.deepEqual(editor.notes, [{ text: PROPOSED, type: 'compact' }]);
  assert.deepEqual(editor.posted, [
    { id: 'r2', claim: true },
    { id: 'r2', ok: true, result: { imported: 2, tab: 'new-tab' }, ticket: 'T1' },
  ]);
  // without newTab it goes into the open tab
  editor.deliver('ps-editor/request', { id: 'r3', op: 'propose', args: { nodes: [{ id: 'c', type: 'debug' }] } });
  await settle();
  assert.deepEqual(editor.imports[1].options, { addFlow: false, generateIds: true, touchImport: true, notify: true });
});

test('propose: not granted, nothing is imported; an import that fails is answered as a refusal', async () => {
  const refused = fakeEditor({ post: async () => ({ granted: false }) });
  refused.deliver('ps-editor/request', { id: 'r4', op: 'propose', args: { nodes: [{ id: 'a', type: 'inject' }] } });
  await settle();
  assert.deepEqual(refused.imports, []);
  assert.deepEqual(refused.notes, []);
  assert.deepEqual(refused.posted, [{ id: 'r4', claim: true }]);

  const failing = fakeEditor({ post: async (body) => (body.claim ? { granted: true, ticket: 'T' } : {}), importResult: () => undefined });
  failing.deliver('ps-editor/request', { id: 'r5', op: 'propose', args: { nodes: [{ id: 'a', type: 'inject' }] } });
  await settle();
  assert.deepEqual(failing.notes, []);
  const last = failing.posted.at(-1);
  assert.equal(last.ok, false);
  assert.equal(last.ticket, 'T');
  assert.match(last.error, /提案/);
});

test('after a cancel for that id the editor does nothing; requests for the pane, or of no shape, are left alone; a ping is answered', async () => {
  const editor = fakeEditor({ post: async (body) => (body.claim ? { granted: true, ticket: 'T' } : {}) });
  editor.deliver('ps-editor/cancel', { id: 'gone' });
  editor.deliver('ps-editor/request', { id: 'gone', op: 'flows', args: {} });
  editor.deliver('ps-editor/request', { id: 'gone', op: 'propose', args: { nodes: [{ id: 'a', type: 'inject' }] } });
  editor.deliver('ps-editor/request', { id: 'f', op: 'frames', args: {} });
  editor.deliver('ps-editor/request', { op: 'flows' });
  editor.deliver('ps-editor/request', null);
  await settle();
  assert.deepEqual(editor.posted, []);
  assert.deepEqual(editor.nodeSetCalls, []);
  assert.deepEqual(editor.imports, []);
  editor.deliver('ps-editor/request', { id: 'p', op: 'ping', args: {} });
  await settle();
  const answers: any[] = editor.posted;
  assert.equal(answers.length, 1);
  assert.deepEqual({ ...answers[0], result: { ...answers[0].result, page: 'some page' } }, { id: 'p', ok: true, result: { kind: 'editor', page: 'some page' } });
  assert.equal(typeof answers[0].result.page, 'string');
});

test('a cancel that comes between the claim and its grant does not stop the granted editor (the plugin sends it to the others)', async () => {
  let editorRef: ReturnType<typeof fakeEditor> | null = null;
  const editor = fakeEditor({
    post: async (body) => {
      if (!body.claim) return {};
      editorRef!.deliver('ps-editor/cancel', { id: body.id });
      return { granted: true, ticket: 'T' };
    },
  });
  editorRef = editor;
  editor.deliver('ps-editor/request', { id: 'mine', op: 'propose', args: { nodes: [{ id: 'a', type: 'inject' }] } });
  await settle();
  assert.equal(editor.imports.length, 1);
});

test('two editors open: a proposal lands in exactly one of them, and the agent is given that one\'s answer', async () => {
  const red = fakeRed({ userDir: mkdtempSync(join(tmpdir(), 'ps-editors-')) });
  const link = createEditorLink(red.RED, {});
  const base = await red.listen();
  try {
    const post = async (body: unknown) => (await fetch(base + ANSWER_ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const editors = [fakeEditor({ post, workspace: 'tab-a' }), fakeEditor({ post, workspace: 'tab-b' })];
    // the runtime's comms reaches both editors
    const publish = red.RED.comms.publish;
    red.RED.comms.publish = (topic: string, data: unknown, retain: boolean) => {
      publish(topic, data, retain);
      for (const e of editors) e.deliver(topic, data);
    };
    const answer = await link.ask('propose', { nodes: [{ id: 'a', type: 'inject' }, { id: 'b', type: 'debug' }], newTab: true });
    await settle(20);
    const imported = editors.filter((e) => e.imports.length > 0);
    assert.equal(imported.length, 1, 'exactly one editor imported');
    assert.equal(imported[0].imports.length, 1);
    assert.deepEqual(answer, { imported: 2, tab: imported[0] === editors[0] ? 'tab-a' : 'tab-b' });
    const other = editors.find((e) => e !== imported[0])!;
    assert.deepEqual(other.notes, []);
    // and flows: one answer is taken, the editors both may answer
    const flows = await link.ask('flows', {});
    assert.ok(Array.isArray(flows));
  } finally { await red.close(); }
});
