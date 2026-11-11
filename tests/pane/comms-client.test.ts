// How the pane hears the hub and talks to it (src/pane/comms-client.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminRootOf, commsUrlOf, connectComms, createApi, dispatch, listenToEditor, PaneError, tokenOf, type PaneHandlers } from '../../src/pane/comms-client.js';

function recorder() {
  const heard: [string, any][] = [];
  const handlers: PaneHandlers = {
    scene: (d) => heard.push(['scene', d]),
    state: (d) => heard.push(['state', d]),
    snapshot: (d) => heard.push(['snapshot', d]),
    status: (d) => heard.push(['status', d]),
  };
  return { heard, handlers };
}

test('each ps-pane topic goes to its handler; anything else is let go', () => {
  const { heard, handlers } = recorder();
  dispatch('ps-pane/scene', { site: 'local' }, handlers);
  dispatch('ps-pane/state', { topic: 'ps/local/a/state' }, handlers);
  dispatch('ps-pane/snapshot', [], handlers);
  dispatch('ps-pane/status', { recorded: 1 }, handlers);
  dispatch('ps-pane/snapshot', { not: 'a list' }, handlers);
  dispatch('ps-pane/other', {}, handlers);
  dispatch('ps-pane/scene', null, handlers);
  assert.deepEqual(heard.map(([k]) => k), ['scene', 'state', 'snapshot', 'status']);
});

test('the admin root, the editor\'s token and the comms address are found as Node-RED\'s editor keeps them', () => {
  assert.equal(adminRootOf('/physical-sandbox/pane'), '/');
  assert.equal(adminRootOf('/red/physical-sandbox/pane'), '/red/');
  const store = (items: Record<string, string>) => ({ getItem: (k: string) => items[k] ?? null });
  assert.equal(tokenOf(store({ 'auth-tokens': JSON.stringify({ access_token: 'T' }) }), '/'), 'T');
  assert.equal(tokenOf(store({ 'auth-tokens-red': JSON.stringify({ access_token: 'R' }) }), '/red/'), 'R');
  assert.equal(tokenOf(store({}), '/'), null);
  assert.equal(tokenOf(store({ 'auth-tokens': 'not json' }), '/'), null);
  assert.equal(tokenOf(null, '/'), null);
  assert.equal(commsUrlOf({ protocol: 'http:', host: '127.0.0.1:1881' }, '/'), 'ws://127.0.0.1:1881/comms');
  assert.equal(commsUrlOf({ protocol: 'https:', host: 'nr.example' }, '/red/'), 'wss://nr.example/red/comms');
});

class FakeSocket {
  static made: FakeSocket[] = [];
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeSocket.made.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
}

test('a window of its own sends the token first, subscribes once it is taken, and hears what comes', () => {
  FakeSocket.made = [];
  const { heard, handlers } = recorder();
  const link = connectComms({ url: 'ws://x/comms', token: 'T', handlers, WebSocketImpl: FakeSocket });
  const socket = FakeSocket.made[0];
  socket.onopen!();
  assert.deepEqual(socket.sent, [{ auth: 'T' }]);
  socket.onmessage!({ data: JSON.stringify({ auth: 'ok' }) });
  assert.deepEqual(socket.sent, [{ auth: 'T' }, { subscribe: 'ps-pane/#' }]);
  socket.onmessage!({ data: JSON.stringify([{ topic: 'ps-pane/scene', data: { site: 'local' } }, { topic: 'ps-pane/snapshot', data: [] }, { topic: 'debug', data: {} }]) });
  socket.onmessage!({ data: 'not json' });
  assert.deepEqual(heard.map(([k]) => k), ['scene', 'snapshot']);
  link.close();
  assert.equal(socket.closed, true);
});

test('with no token it subscribes as soon as it is open', () => {
  FakeSocket.made = [];
  const { handlers } = recorder();
  const link = connectComms({ url: 'ws://x/comms', token: null, handlers, WebSocketImpl: FakeSocket });
  FakeSocket.made[0].onopen!();
  assert.deepEqual(FakeSocket.made[0].sent, [{ subscribe: 'ps-pane/#' }]);
  link.close();
});

test('inside the editor it says ready to its parent and hears only the parent, of its own origin', () => {
  const listeners: any[] = [];
  const parent = { posted: [] as any[], postMessage(m: any, origin: string) { this.posted.push([m, origin]); } };
  const win = { location: { origin: 'http://127.0.0.1:1881' }, parent, addEventListener: (_: string, fn: any) => listeners.push(fn), removeEventListener() {} };
  const { heard, handlers } = recorder();
  listenToEditor(win, handlers);
  assert.deepEqual(parent.posted, [[{ type: 'ps-pane-ready' }, 'http://127.0.0.1:1881']]);
  const message = { type: 'ps-pane-message', topic: 'ps-pane/status', data: { recorded: 2 } };
  listeners[0]({ origin: 'http://127.0.0.1:1881', source: parent, data: message });
  listeners[0]({ origin: 'http://evil.example', source: parent, data: message });
  listeners[0]({ origin: 'http://127.0.0.1:1881', source: {}, data: message });
  assert.deepEqual(heard, [['status', { recorded: 2 }]]);
});

test('every POST says it comes from the pane: JSON, or the pane\'s header (no body, a long record as text, the picture)', async () => {
  const calls: [string, any][] = [];
  const fetchImpl = async (url: string, init: any) => { calls.push([url, init]); return { ok: true, json: async () => ({ ok: 1 }) }; };
  const api = createApi({ base: '/', token: 'T', fetchImpl });
  await api.post('scene/place', { product: 'p' });
  await api.post('stream/stop');
  await api.post('stream/play', { record: {} }, { asText: true });
  await api.upload('scene/background', new Blob(['x']), 'a b.png');
  await api.get('scene');
  assert.deepEqual(calls.map(([url, init]) => [url, init.method ?? 'GET', init.headers]), [
    ['/physical-sandbox/scene/place', 'POST', { Authorization: 'Bearer T', 'Content-Type': 'application/json' }],
    ['/physical-sandbox/stream/stop', 'POST', { Authorization: 'Bearer T', 'X-PS-Pane': '1' }],
    ['/physical-sandbox/stream/play', 'POST', { Authorization: 'Bearer T', 'X-PS-Pane': '1', 'Content-Type': 'text/plain;charset=utf-8' }],
    ['/physical-sandbox/scene/background?name=a%20b.png', 'POST', { Authorization: 'Bearer T', 'X-PS-Pane': '1', 'Content-Type': 'application/octet-stream' }],
    ['/physical-sandbox/scene', 'GET', { Authorization: 'Bearer T' }],
  ]);
  assert.equal(calls[0][1].body, JSON.stringify({ product: 'p' }));
});

test('a refusal comes back as a PaneError with the hub\'s words and reason', async () => {
  const api = createApi({ base: '/red/', token: null, fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: '保存中です', reason: 'busy' }) }) });
  await assert.rejects(api.post('record/save', { mode: 'over' }), (e: unknown) => e instanceof PaneError && e.message === '保存中です' && e.reason === 'busy' && e.status === 409);
  assert.equal(api.url('scene'), '/red/physical-sandbox/scene');
});
