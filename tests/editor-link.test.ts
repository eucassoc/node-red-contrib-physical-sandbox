// The link through which the plugin asks an open editor or pane (src/plugin/editor-link.ts): its
// requests on comms, the answer route, the first answer winning, claims for a proposal, the time
// limit and the count of open editors and panes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANSWER_ROUTE, createEditorLink, EditorRefused, LINK_WORDS, NoEditor, ProposalUnanswered } from '../src/plugin/editor-link.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';

async function setup(o: { timeoutMs?: number } = {}) {
  const red = fakeRed({ userDir: mkdtempSync(join(tmpdir(), 'ps-link-')) });
  const clock = fakeClock();
  const link = createEditorLink(red.RED, { clock, timeoutMs: o.timeoutMs });
  const base = await red.listen();
  const of = (topic: string) => red.published.filter((p) => p.topic === topic);
  return {
    red, clock, link,
    requests: () => of('ps-editor/request'),
    cancels: () => of('ps-editor/cancel').map((p) => p.data),
    /** A POST to the answer route, as the editor sends it (JSON) unless other headers are given. */
    async answer(body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
      const res = await fetch(base + ANSWER_ROUTE, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    },
    close: () => red.close(),
  };
}

test('a request goes out on ps-editor/request, not retained; the first answer wins, a later one is ignored, and the others are told to stop', async () => {
  const s = await setup();
  try {
    const asked = s.link.ask('flows', {});
    const [request] = s.requests();
    assert.equal(request.retain, false);
    assert.equal(request.data.op, 'flows');
    assert.deepEqual(request.data.args, {});
    assert.match(request.data.id, /^[0-9a-f-]{36}$/);
    const id = request.data.id;
    const first = await s.answer({ id, ok: true, result: [{ id: 'a', type: 'tab' }] });
    assert.deepEqual(first, { status: 200, json: { taken: true } });
    const second = await s.answer({ id, ok: true, result: [{ id: 'b', type: 'tab' }] });
    assert.deepEqual(second, { status: 200, json: { taken: false } });
    assert.deepEqual(await asked, [{ id: 'a', type: 'tab' }]);
    assert.deepEqual(s.cancels(), [{ id }], 'one cancel, after the first answer');
    assert.equal(s.clock.pending(), 0, 'no timer left behind');
  } finally { await s.close(); }
});

test('no answer in time: NoEditor with 「Node-RED のエディタを開いてください」, the editors are told to stop, and a late answer is not taken', async () => {
  const s = await setup();
  try {
    const asked = s.link.ask('flows', {});
    const { id } = s.requests()[0].data;
    s.clock.advance(4999);
    s.clock.advance(1);
    await assert.rejects(asked, (e: unknown) => e instanceof NoEditor && e.message === LINK_WORDS.noEditor && e.message === 'Node-RED のエディタを開いてください');
    assert.deepEqual(s.cancels(), [{ id }]);
    assert.deepEqual((await s.answer({ id, ok: true, result: [] })).json, { taken: false });
    // a time of its own for one request
    const quick = s.link.ask('flows', {}, { timeoutMs: 100 });
    s.clock.advance(100);
    await assert.rejects(quick, NoEditor);
  } finally { await s.close(); }
});

test('an editor that refuses: EditorRefused with its words', async () => {
  const s = await setup();
  try {
    const asked = s.link.ask('flows', {});
    const { id } = s.requests()[0].data;
    const refused = assert.rejects(asked, (e: unknown) => e instanceof EditorRefused && e.message === 'エディタで提案を取り込めませんでした');
    await s.answer({ id, ok: false, error: 'エディタで提案を取り込めませんでした' });
    await refused;
    assert.deepEqual(s.cancels(), [{ id }]);
  } finally { await s.close(); }
});

test('a proposal is taken through a claim: the first editor to claim is granted, the others are not, and only the granted one\'s answer counts', async () => {
  const s = await setup();
  try {
    const asked = s.link.ask('propose', { nodes: [{ id: 'n1', type: 'inject' }], newTab: true });
    const { id } = s.requests()[0].data;
    // an answer before any claim is not taken: it could have imported beside another editor
    assert.deepEqual((await s.answer({ id, ok: true, result: { imported: 1, tab: 'x' } })).json, { taken: false });
    const a = await s.answer({ id, claim: true });
    assert.equal(a.json.granted, true);
    assert.equal(typeof a.json.ticket, 'string');
    assert.deepEqual(s.cancels(), [{ id }], 'the others are told to stop as soon as one is granted');
    assert.deepEqual((await s.answer({ id, claim: true })).json, { granted: false });
    assert.deepEqual((await s.answer({ id, ok: true, result: { imported: 9 }, ticket: 'not-the-ticket' })).json, { taken: false });
    // granted: the time starts again for the import
    s.clock.advance(4999);
    assert.deepEqual((await s.answer({ id, ok: true, result: { imported: 1, tab: 'new-tab' }, ticket: a.json.ticket })).json, { taken: true });
    assert.deepEqual(await asked, { imported: 1, tab: 'new-tab' });
    assert.equal(s.cancels().length, 1, 'no second cancel');
    // a claim after the request is over is not granted
    assert.deepEqual((await s.answer({ id, claim: true })).json, { granted: false });
  } finally { await s.close(); }
});

test('only a proposal can be claimed: a claim for flows (or frames) is not granted, and its answer is still taken without one', async () => {
  const s = await setup();
  try {
    const asked = s.link.ask('flows', {});
    const { id } = s.requests()[0].data;
    assert.deepEqual((await s.answer({ id, claim: true })).json, { granted: false });
    assert.deepEqual(s.cancels(), [], 'a refused claim sends no cancel');
    assert.deepEqual((await s.answer({ id, ok: true, result: [] })).json, { taken: true });
    assert.deepEqual(await asked, []);
    const frames = s.link.ask('frames', {});
    assert.deepEqual((await s.answer({ id: s.requests()[1].data.id, claim: true })).json, { granted: false });
    s.clock.advance(10_000); // frames wait 10 s
    await assert.rejects(frames, NoEditor);
  } finally { await s.close(); }
});

test('frames: a refusal does not end the request; the first answer with frames wins; with refusals only, the last refusal when the time is up (10 s)', async () => {
  const s = await setup();
  try {
    const won = s.link.ask('frames', { frames: [{}] });
    const first = s.requests()[0].data.id;
    assert.deepEqual((await s.answer({ id: first, ok: false, error: 'switch off here' })).json, { taken: true });
    assert.deepEqual(s.cancels(), [], 'no cancel on a refusal');
    assert.deepEqual((await s.answer({ id: first, ok: true, result: { frames: ['x'] } })).json, { taken: true });
    assert.deepEqual(await won, { frames: ['x'] });
    assert.equal(s.cancels().length, 1, 'the others are told to stop');
    assert.deepEqual((await s.answer({ id: first, ok: true, result: { frames: ['y'] } })).json, { taken: false });

    let settled = false;
    const refused = s.link.ask('frames', { frames: [{}] });
    void refused.catch(() => undefined).finally(() => { settled = true; });
    const second = s.requests()[1].data.id;
    await s.answer({ id: second, ok: false, error: 'first refusal' });
    await s.answer({ id: second, ok: false, error: 'last refusal' });
    s.clock.advance(9_999);
    await Promise.resolve();
    assert.equal(settled, false, 'still waiting for frames');
    s.clock.advance(1);
    await assert.rejects(refused, (e: Error) => e instanceof EditorRefused && e.message === 'last refusal');
    // flows keep first-answer-wins: a refusal ends it at once
    const flows = s.link.ask('flows', {});
    const flowsRefused = assert.rejects(flows, (e: Error) => e instanceof EditorRefused && e.message === 'no');
    await s.answer({ id: s.requests()[2].data.id, ok: false, error: 'no' });
    await flowsRefused;
  } finally { await s.close(); }
});

test('a granted proposal that is never answered is not "no editor": the agent is told the editor took it, to check before proposing again', async () => {
  const s = await setup();
  try {
    const asked = s.link.ask('propose', { nodes: [{ id: 'a', type: 'inject' }] });
    const { id } = s.requests()[0].data;
    assert.equal((await s.answer({ id, claim: true })).json.granted, true);
    s.clock.advance(5000);
    await assert.rejects(asked, (e: unknown) => e instanceof ProposalUnanswered && !(e instanceof NoEditor)
      && e.message === LINK_WORDS.proposalUnanswered && /確かめて/.test(e.message) && /check the editor before proposing again/.test(e.message));
    assert.deepEqual(s.cancels(), [{ id }], 'the cancel went out once, at the grant; none after the time ran out');
    assert.equal(s.clock.pending(), 0, 'no timer left behind');
    assert.deepEqual((await s.answer({ id, ok: true, result: { imported: 1 } })).json, { taken: false }, 'a late answer is not taken');
  } finally { await s.close(); }
});

test('an answer posted as text/plain with X-PS-Pane: 1 is read by the route itself, so a node set over Node-RED\'s 5 MB JSON limit gets through', async () => {
  const red = fakeRed({ userDir: mkdtempSync(join(tmpdir(), 'ps-link-')), adminJsonParser: true });
  const link = createEditorLink(red.RED, {});
  const base = await red.listen();
  try {
    const big = Array.from({ length: 30_000 }, (_, i) => ({ id: `n${i}`, type: 'function', z: 't', func: 'x'.repeat(200) }));
    const asked = link.ask('flows', {});
    const { id } = red.published.find((p) => p.topic === 'ps-editor/request')!.data;
    const text = JSON.stringify({ id, ok: true, result: big });
    assert.ok(text.length > 5 * 1024 * 1024, `${text.length} bytes`);
    const asJson = await fetch(base + ANSWER_ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
    assert.equal(asJson.status, 413, 'as JSON, Node-RED\'s own parser refuses it');
    const res = await fetch(base + ANSWER_ROUTE, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'X-PS-Pane': '1' }, body: text });
    assert.deepEqual([res.status, await res.json()], [200, { taken: true }]);
    assert.equal((await asked).length, 30_000);
  } finally { await red.close(); }
});

test('the answer route asks for flows.write and the pane\'s guard, and wants an id', async () => {
  const s = await setup();
  try {
    assert.equal((await s.answer({ id: 'nothing', ok: true })).status, 200);
    assert.equal(s.red.permissions.get(`POST ${ANSWER_ROUTE}`), 'flows.write');
    const plainText = await s.answer('{"id":"x","ok":true}', { 'Content-Type': 'text/plain' });
    assert.equal(plainText.status, 403, 'a page on another site cannot answer for the editor');
    assert.equal(plainText.json.reason, 'not-pane');
    const noId = await s.answer({ ok: true });
    assert.equal(noId.status, 400);
    assert.equal(noId.json.reason, 'bad-answer');
    assert.equal((await s.answer({ id: 'x', ok: 'yes' })).status, 400);
    assert.deepEqual((await s.answer({ id: 'unknown', ok: true, result: 1 })).json, { taken: false });
  } finally { await s.close(); }
});

test('the open editors and panes: a ping counts each page once by kind, and its count is kept for 10 s', async () => {
  const s = await setup();
  try {
    const counted = s.link.presence();
    const ping = s.requests()[0].data;
    assert.equal(ping.op, 'ping');
    for (const result of [{ kind: 'editor', page: 'e1' }, { kind: 'pane', page: 'p1' }, { kind: 'pane', page: 'p1' }, { kind: 'editor', page: 'e2' }, { kind: 'other', page: 'o' }]) {
      assert.deepEqual((await s.answer({ id: ping.id, ok: true, result })).json, { taken: true });
    }
    s.clock.advance(999);
    assert.equal(s.requests().length, 1);
    s.clock.advance(1);
    assert.deepEqual(await counted, { editors: 2, panes: 1 });
    assert.deepEqual(s.cancels(), [], 'a ping is not cancelled: every page answers it');
    assert.deepEqual((await s.answer({ id: ping.id, ok: true, result: { kind: 'editor', page: 'late' } })).json, { taken: false });
    // within 10 s the count is kept, without another ping
    s.clock.advance(9000);
    assert.deepEqual(await s.link.presence(), { editors: 2, panes: 1 });
    assert.equal(s.requests().length, 1);
    // after that a new ping; two callers at once share it
    s.clock.advance(1000);
    const again = [s.link.presence(), s.link.presence()];
    assert.equal(s.requests().length, 2);
    s.clock.advance(1000);
    assert.deepEqual(await Promise.all(again), [{ editors: 0, panes: 0 }, { editors: 0, panes: 0 }]);
  } finally { await s.close(); }
});

test('when a request cannot go out at all the count is "unknown"', async () => {
  const s = await setup();
  try {
    s.red.RED.comms.publish = () => { throw new Error('no comms'); };
    assert.equal(await s.link.presence(), 'unknown');
  } finally { await s.close(); }
});

test('frames: once every pane the last ping counted has refused, the last refusal comes at once; a pane giving frames still wins before that', async () => {
  const s = await setup();
  try {
    const counting = s.link.presence();
    const ping = s.requests()[0].data.id;
    await s.answer({ id: ping, ok: true, result: { kind: 'pane', page: 'p1' } });
    await s.answer({ id: ping, ok: true, result: { kind: 'pane', page: 'p2' } });
    s.clock.advance(1000);
    assert.deepEqual(await counting, { editors: 0, panes: 2 });

    // two panes counted: one refusal waits, the second ends it with its words
    let settled = false;
    const refused = s.link.ask('frames', { frames: [{}] });
    void refused.catch(() => undefined).finally(() => { settled = true; });
    const id = s.requests()[1].data.id;
    await s.answer({ id, ok: false, error: 'hidden' });
    await Promise.resolve();
    assert.equal(settled, false, 'the other pane may still give frames');
    await s.answer({ id, ok: false, error: 'switch off' });
    await assert.rejects(refused, (e: Error) => e instanceof EditorRefused && e.message === 'switch off');
    assert.deepEqual(s.cancels(), [{ id }]);
    assert.equal(s.clock.pending(), 0, 'no timer left behind');

    // one refusal, then frames from the other pane: the frames win
    const won = s.link.ask('frames', { frames: [{}] });
    const next = s.requests()[2].data.id;
    await s.answer({ id: next, ok: false, error: 'hidden' });
    await s.answer({ id: next, ok: true, result: { frames: ['x'] } });
    assert.deepEqual(await won, { frames: ['x'] });
  } finally { await s.close(); }
});
