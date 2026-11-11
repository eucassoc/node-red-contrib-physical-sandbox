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

test('flows: the complete node set without credentials, posted as text with X-PS-Pane: 1 to the answer route (Node-RED\'s 5 MB JSON parser is not in the way)', async () => {
  const editor = fakeEditor({ nodeSet: [{ id: 't', type: 'tab' }, { id: 'n', type: 'inject', z: 't' }] });
  editor.deliver('ps-editor/request', { id: 'r1', op: 'flows', args: {} });
  await settle();
  assert.deepEqual(editor.nodeSetCalls, [{ credentials: false }]);
  assert.deepEqual(editor.posted, [{ id: 'r1', ok: true, result: [{ id: 't', type: 'tab' }, { id: 'n', type: 'inject', z: 't' }] }]);
  assert.deepEqual(editor.requests, [{ url: 'physical-sandbox/editor/answer', type: 'POST', contentType: 'text/plain', headers: { 'X-PS-Pane': '1' } }],
    'a relative address: the editor\'s own ajax setup adds the admin root and its token');
});

test('propose: a claim first; once granted, importNodes with the exact options, the notice, and the answer with the ticket', async () => {
  const editor = fakeEditor({
    workspace: 'tab1',
    post: async (body) => (body.claim ? { granted: true, ticket: 'T1' } : { taken: true }),
  });
  const nodes = [{ id: 'a', type: 'inject', wires: [['b']] }, { id: 'b', type: 'ps play' }];
  assert.equal(editor.red.nodes.dirty(), false);
  editor.deliver('ps-editor/request', { id: 'r2', op: 'propose', args: { nodes, newTab: true } });
  await settle();
  assert.equal(editor.red.nodes.dirty(), true, 'changed: Deploy turns active');
  assert.deepEqual(editor.imports, [{ nodes, options: { addFlow: true, generateIds: true, touchImport: true, notify: true } }]);
  assert.deepEqual(editor.notes, [{ text: PROPOSED, type: 'compact' }]);
  assert.deepEqual(editor.dirtyCalls, [true], 'the workspace is marked changed, so Deploy turns active');
  const newTab = editor.nodes().find((n) => n.name === undefined && n.type === 'inject')?.z;
  assert.ok(newTab && newTab !== 'tab1', 'a new tab');
  assert.deepEqual(editor.shown, [newTab]);
  assert.deepEqual(editor.posted, [
    { id: 'r2', claim: true },
    { id: 'r2', ok: true, result: { imported: 2, tab: newTab, notInstalled: [] }, ticket: 'T1' },
  ]);
  // without newTab it goes into the open tab
  editor.deliver('ps-editor/request', { id: 'r3', op: 'propose', args: { nodes: [{ id: 'c', type: 'debug' }] } });
  await settle();
  assert.deepEqual(editor.imports[1].options, { addFlow: false, generateIds: true, touchImport: true, notify: true });
});

test('propose: the types this editor does not have are listed in the answer (tabs, groups, junctions and subflow instances are not node types)', async () => {
  const editor = fakeEditor({ knownTypes: ['inject', 'debug'], post: async (body) => (body.claim ? { granted: true, ticket: 'T' } : {}) });
  const nodes = [
    { id: 't', type: 'tab' }, { id: 'g', type: 'group', z: 't' }, { id: 'j', type: 'junction', z: 't' }, { id: 's', type: 'subflow:abc', z: 't' },
    { id: 'a', type: 'inject', z: 't' }, { id: 'b', type: 'ps play', z: 't' }, { id: 'c', type: 'ps play', z: 't' }, { id: 'd', type: 'mqtt out', z: 't' },
  ];
  editor.deliver('ps-editor/request', { id: 'r6', op: 'propose', args: { nodes, newTab: true } });
  await settle();
  assert.equal(editor.imports.length, 1, 'imported all the same');
  assert.deepEqual(editor.posted.at(-1).result.notInstalled, ['ps play', 'mqtt out']);
});

test('propose: a proposal that brings its own tab is shown in that tab, and the answer names it', async () => {
  const editor = fakeEditor({ workspace: 'tab1', post: async (body) => (body.claim ? { granted: true, ticket: 'T' } : {}) });
  const nodes = [{ id: 'mytab', type: 'tab', label: 'Dance' }, { id: 'a', type: 'inject', z: 'mytab', wires: [['b']] }, { id: 'b', type: 'debug', z: 'mytab' }];
  editor.deliver('ps-editor/request', { id: 'r7', op: 'propose', args: { nodes, newTab: true } });
  await settle();
  const tab = editor.nodes().find((n) => n.type === 'tab' && n.label === 'Dance');
  assert.ok(tab && tab.id !== 'mytab', 'the tab got a new id');
  assert.deepEqual(editor.shown, [tab.id]);
  assert.deepEqual(editor.posted.at(-1).result, { imported: 2, tab: tab.id, notInstalled: [] });
});

test('propose: not granted, nothing is imported; an import that fails is answered as a refusal', async () => {
  const refused = fakeEditor({ post: async () => ({ granted: false }) });
  refused.deliver('ps-editor/request', { id: 'r4', op: 'propose', args: { nodes: [{ id: 'a', type: 'inject' }] } });
  await settle();
  assert.deepEqual(refused.imports, []);
  assert.deepEqual(refused.notes, []);
  assert.deepEqual(refused.posted, [{ id: 'r4', claim: true }]);

  assert.deepEqual(refused.dirtyCalls, []);

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
    assert.deepEqual(answer, { imported: 2, tab: imported[0].nodes().find((n) => n.type === 'inject').z, notInstalled: [] });
    assert.ok(!['tab-a', 'tab-b'].includes(answer.tab), 'a new tab');
    const other = editors.find((e) => e !== imported[0])!;
    assert.deepEqual(other.notes, []);
    // and flows: one answer is taken, the editors both may answer
    const flows = await link.ask('flows', {});
    assert.ok(Array.isArray(flows));
  } finally { await red.close(); }
});
