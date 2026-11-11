// How the pane hears the hub and talks to it (src/pane/comms-client.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminRootOf, commsUrlOf, connectComms, createApi, createPaneAnswers, dispatch, listenToEditor, PaneError, PANE_FRAMES_BAD, PANE_FRAMES_FAILED, PANE_FRAMES_OFF, PANE_FRAMES_TOO_LARGE, tokenOf, type PaneHandlers } from '../../src/pane/comms-client.js';
import { FRAME_MAX_BYTES, FRAME_MAX_SIDE, FRAMES_MAX, FRAMES_TOTAL_BYTES, frameBudget } from '../../src/core/frames.js';

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

test('a request on the editor link goes to the request handler, a cancel to the cancel handler (when there is one); one of no shape is let go', () => {
  const { heard, handlers } = recorder();
  const requests: any[] = [];
  const cancels: string[] = [];
  dispatch('ps-editor/cancel', { id: 'c' }, { ...handlers, cancel: (id) => cancels.push(id) });
  dispatch('ps-editor/cancel', { id: 3 }, { ...handlers, cancel: (id) => cancels.push(String(id)) });
  dispatch('ps-editor/cancel', { id: 'c' }, handlers);
  assert.deepEqual(cancels, ['c']);
  dispatch('ps-editor/request', { id: 'r', op: 'ping', args: {} }, handlers);
  dispatch('ps-editor/request', { id: 'r', op: 'ping', args: {} }, { ...handlers, request: (r) => requests.push(r) });
  dispatch('ps-editor/request', { op: 'ping' }, { ...handlers, request: (r) => requests.push(r) });
  dispatch('ps-editor/request', [], { ...handlers, request: (r) => requests.push(r) });
  dispatch('ps-editor/cancel', { id: 'r' }, { ...handlers, request: (r) => requests.push(r) });
  assert.deepEqual(requests, [{ id: 'r', op: 'ping', args: {} }]);
  assert.deepEqual(heard, []);
});

/**
 * A stage for the pane's answer: its switch as `allowed` says; each frame is 640x360 and encodes
 * to `png` bytes as PNG and `jpeg` bytes as JPEG (any quality), noting each encoding asked for.
 */
function frameSource(o: { allowed?: () => boolean; png?: number; jpeg?: number[]; fail?: boolean } = {}) {
  const drawn: any[] = [];
  const encodings: [string, number | undefined][] = [];
  return {
    drawn,
    encodings,
    allowed: o.allowed ?? (() => true),
    picture(f: any) {
      drawn.push(f);
      if (o.fail) throw new Error('no WebGL');
      return {
        width: 640,
        height: 360,
        async encode(type: 'image/png' | 'image/jpeg', quality?: number) {
          encodings.push([type, quality]);
          const size = type === 'image/png' ? (o.png ?? 3) : (o.jpeg ?? [2, 2])[quality === 0.85 ? 0 : 1];
          return new Blob([new Uint8Array(size).fill(type === 'image/png' ? 1 : 2)], { type });
        },
      };
    },
  };
}

function answering(o: { failFirst?: boolean } = {}) {
  const calls: [string, any, any][] = [];
  let failed = false;
  const api = createApi({
    base: '/',
    token: () => 'T',
    fetchImpl: async (url: string, init: any) => {
      calls.push([url, JSON.parse(init.body), init.headers]);
      if (o.failFirst && !failed) { failed = true; return { ok: false, status: 413, json: async () => ({}) }; }
      return { ok: true, json: async () => ({ taken: true }) };
    },
  });
  return { calls, api };
}

const b64 = (n: number, byte: number) => Buffer.alloc(n, byte).toString('base64');

test('a pane answers ping (as a pane, with its page) and leaves the editor\'s requests alone', async () => {
  const { calls, api } = answering();
  const answers = createPaneAnswers(api, 'page-1', frameSource());
  await answers.request({ id: 'p', op: 'ping', args: {} });
  assert.equal(answers.request({ id: 'x', op: 'flows', args: {} }), null);
  assert.equal(answers.request({ id: 'y', op: 'propose', args: {} }), null);
  assert.deepEqual(calls.map(([url, body]) => [url, body]), [
    ['/physical-sandbox/editor/answer', { id: 'p', ok: true, result: { kind: 'pane', page: 'page-1' } }],
  ]);
  // a refused answer (no permission, the request is over) is let go
  const refusing = createApi({ base: '/', token: () => null, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await createPaneAnswers(refusing, 'page-1', frameSource()).request({ id: 'p', op: 'ping', args: {} });
});

test('a pane answers frames with each frame drawn on its own copy (the states given, longest side 1280) as base64 PNG with its size, posted as text', async () => {
  const { calls, api } = answering();
  const source = frameSource();
  const states = [{ topic: 'ps/yard/arm/state', payload: { at: 1, joints: { j1: 0.2 } }, at: 1 }];
  await createPaneAnswers(api, 'page-1', source).request({ id: 'f', op: 'frames', args: { frames: [{ t: 0, states }, {}] } });
  assert.deepEqual(source.drawn, [{ states, maxSide: FRAME_MAX_SIDE }, { maxSide: FRAME_MAX_SIDE }]);
  const png = { data: b64(3, 1), type: 'image/png', width: 640, height: 360 };
  assert.deepEqual(calls.map(([url, body]) => [url, body]), [
    ['/physical-sandbox/editor/answer', { id: 'f', ok: true, result: { frames: [png, png] } }],
  ]);
  // as text with the pane's header: Node-RED's JSON parser stops at 5 MB, the route reads text up to 20 MB
  assert.equal(calls[0][2]['X-PS-Pane'], '1');
  assert.match(calls[0][2]['Content-Type'], /^text\/plain/);
  assert.equal(calls[0][2].Authorization, 'Bearer T');
});

test('a frame over its share of the bytes goes as JPEG 0.85, then 0.6; still over, the pane says it was too large', async () => {
  const budget = frameBudget(2);
  assert.equal(frameBudget(1), FRAME_MAX_BYTES);
  assert.equal(budget, FRAME_MAX_BYTES, 'two frames: each at most 3.75 MB');
  assert.equal(frameBudget(4), Math.floor(FRAMES_TOTAL_BYTES / 4));
  assert.equal(frameBudget(6), Math.floor(FRAMES_TOTAL_BYTES / 6));
  const { calls, api } = answering();
  const two = { frames: [{}, {}] };
  const at85 = frameSource({ png: budget + 1, jpeg: [budget, 1] });
  await createPaneAnswers(api, 'page-1', at85).request({ id: 'a', op: 'frames', args: two });
  assert.deepEqual(at85.encodings.slice(0, 2), [['image/png', undefined], ['image/jpeg', 0.85]]);
  const at60 = frameSource({ png: budget + 1, jpeg: [budget + 1, 5] });
  await createPaneAnswers(api, 'page-1', at60).request({ id: 'b', op: 'frames', args: { frames: [{}] } });
  const never = frameSource({ png: FRAME_MAX_BYTES + 1, jpeg: [FRAME_MAX_BYTES + 1, FRAME_MAX_BYTES + 1] });
  await createPaneAnswers(api, 'page-1', never).request({ id: 'c', op: 'frames', args: { frames: [{}] } });
  assert.deepEqual(never.encodings, [['image/png', undefined], ['image/jpeg', 0.85], ['image/jpeg', 0.6]]);
  const bodies = calls.map(([, body]) => body);
  assert.deepEqual(bodies[0].result.frames.map((f: any) => [f.type, Buffer.from(f.data, 'base64').length]), [['image/jpeg', budget], ['image/jpeg', budget]]);
  assert.deepEqual(bodies[1].result.frames.map((f: any) => [f.type, Buffer.from(f.data, 'base64').length]), [['image/jpeg', 5]]);
  assert.deepEqual(bodies[2], { id: 'c', ok: false, error: PANE_FRAMES_TOO_LARGE });
});

test('when the frames cannot be posted (refused, too large for the route), the pane says so instead of staying silent', async () => {
  const { calls, api } = answering({ failFirst: true });
  await createPaneAnswers(api, 'page-1', frameSource()).request({ id: 'f', op: 'frames', args: { frames: [{}] } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].ok, true);
  assert.deepEqual(calls[1][1], { id: 'f', ok: false, error: PANE_FRAMES_TOO_LARGE });
});

test('a cancelled frames request stops drawing between frames and posts nothing', async () => {
  const { calls, api } = answering();
  let answers!: ReturnType<typeof createPaneAnswers>;
  const source = frameSource();
  const drawing = { ...source, picture(f: any) { const p = source.picture(f); answers.cancel('f'); return p; } };
  answers = createPaneAnswers(api, 'page-1', drawing);
  await answers.request({ id: 'f', op: 'frames', args: { frames: [{}, {}, {}] } });
  assert.equal(source.drawn.length, 1);
  assert.equal(calls.length, 0);
  // cancelled before it came: nothing drawn
  answers.cancel('g');
  await answers.request({ id: 'g', op: 'frames', args: { frames: [{}] } });
  assert.equal(source.drawn.length, 1);
  assert.equal(calls.length, 0);
});

test('a pane whose switch shows off refuses frames and draws nothing; so does one asked for none or too many, or that cannot draw', async () => {
  const { calls, api } = answering();
  const off = frameSource({ allowed: () => false });
  await createPaneAnswers(api, 'page-1', off).request({ id: 'a', op: 'frames', args: { frames: [{}] } });
  assert.equal(off.drawn.length, 0);
  const on = frameSource();
  const answers = createPaneAnswers(api, 'page-1', on);
  await answers.request({ id: 'b', op: 'frames', args: { frames: Array.from({ length: FRAMES_MAX + 1 }, () => ({})) } });
  await answers.request({ id: 'c', op: 'frames', args: { frames: [] } });
  await answers.request({ id: 'd', op: 'frames', args: {} });
  assert.equal(on.drawn.length, 0);
  await createPaneAnswers(api, 'page-1', frameSource({ fail: true })).request({ id: 'e', op: 'frames', args: { frames: [{}] } });
  // switched off between two frames: the rest is not drawn
  let left = 2;
  const turnedOff = frameSource({ allowed: () => (left -= 1) >= 0 });
  await createPaneAnswers(api, 'page-1', turnedOff).request({ id: 'g', op: 'frames', args: { frames: [{}, {}, {}] } });
  assert.equal(turnedOff.drawn.length, 1);
  assert.deepEqual(calls.map(([, body]) => body), [
    { id: 'a', ok: false, error: PANE_FRAMES_OFF },
    { id: 'b', ok: false, error: PANE_FRAMES_BAD },
    { id: 'c', ok: false, error: PANE_FRAMES_BAD },
    { id: 'd', ok: false, error: PANE_FRAMES_BAD },
    { id: 'e', ok: false, error: PANE_FRAMES_FAILED },
    { id: 'g', ok: false, error: PANE_FRAMES_OFF },
  ]);
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
  assert.deepEqual(socket.sent, [{ auth: 'T' }, { subscribe: 'ps-pane/#' }, { subscribe: 'ps-editor/#' }]);
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
  assert.deepEqual(FakeSocket.made[0].sent, [{ subscribe: 'ps-pane/#' }, { subscribe: 'ps-editor/#' }]);
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

test('inside the editor the token comes from the editor, before anything else, and from no one else', () => {
  const listeners: any[] = [];
  const parent = { postMessage() {} };
  const win = { location: { origin: 'http://127.0.0.1:1881' }, parent, addEventListener: (_: string, fn: any) => listeners.push(fn), removeEventListener() {} };
  const tokens: (string | null)[] = [];
  listenToEditor(win, recorder().handlers, (token) => tokens.push(token));
  listeners[0]({ origin: 'http://evil.example', source: parent, data: { type: 'ps-pane-token', token: 'X' } });
  listeners[0]({ origin: 'http://127.0.0.1:1881', source: parent, data: { type: 'ps-pane-token', token: 'T' } });
  listeners[0]({ origin: 'http://127.0.0.1:1881', source: parent, data: { type: 'ps-pane-token', token: null } });
  listeners[0]({ origin: 'http://127.0.0.1:1881', source: parent, data: { type: 'ps-pane-token', token: 42 } });
  assert.deepEqual(tokens, ['T', null, null]);
});

test('inside the editor nothing is heard before the token: it would start requests without it', () => {
  const listeners: any[] = [];
  const parent = { postMessage() {} };
  const win = { location: { origin: 'http://o' }, parent, addEventListener: (_: string, fn: any) => listeners.push(fn), removeEventListener() {} };
  const { heard, handlers } = recorder();
  listenToEditor(win, handlers, () => undefined);
  const status = { type: 'ps-pane-message', topic: 'ps-pane/status', data: { recorded: 1 } };
  listeners[0]({ origin: 'http://o', source: parent, data: status });
  listeners[0]({ origin: 'http://o', source: parent, data: { type: 'ps-pane-token', token: 'T' } });
  listeners[0]({ origin: 'http://o', source: parent, data: status });
  assert.deepEqual(heard, [['status', { recorded: 1 }]]);
});

test('the token is read at each request, so one that comes later goes with the requests after it', async () => {
  const calls: any[] = [];
  let token: string | null = null;
  const api = createApi({ base: '/', token: () => token, fetchImpl: async (_url: string, init: any) => { calls.push(init.headers); return { ok: true, json: async () => ({}) }; } });
  await api.get('scene');
  token = 'T';
  await api.get('scene');
  assert.deepEqual(calls, [{}, { Authorization: 'Bearer T' }]);
});

test('every POST says it comes from the pane: JSON, or the pane\'s header (no body, a long record as text, the picture)', async () => {
  const calls: [string, any][] = [];
  const fetchImpl = async (url: string, init: any) => { calls.push([url, init]); return { ok: true, json: async () => ({ ok: 1 }) }; };
  const api = createApi({ base: '/', token: () => 'T', fetchImpl });
  await api.post('scene/place', { product: 'p' });
  await api.post('stream/stop');
  await api.post('stream/play', { record: {} }, { asText: true });
  await api.upload('scene/background', new Blob(['x']), 'a b.png');
  await api.get('scene');
  assert.deepEqual(calls.map(([url, init]) => [url, init.method ?? 'GET', init.headers]), [
    ['/physical-sandbox/scene/place', 'POST', { Authorization: 'Bearer T', 'Content-Type': 'application/json' }],
    ['/physical-sandbox/stream/stop', 'POST', { Authorization: 'Bearer T', 'X-PS-Pane': '1' }],
    ['/physical-sandbox/stream/play', 'POST', { Authorization: 'Bearer T', 'X-PS-Pane': '1', 'Content-Type': 'text/plain;charset=utf-8' }],
    ['/physical-sandbox/scene/background', 'POST', { Authorization: 'Bearer T', 'X-PS-Pane': '1', 'Content-Type': 'application/octet-stream', 'X-PS-Name': 'a%20b.png' }],
    ['/physical-sandbox/scene', 'GET', { Authorization: 'Bearer T' }],
  ]);
  assert.equal(calls[0][1].body, JSON.stringify({ product: 'p' }));
});

test('a refusal comes back as a PaneError with the hub\'s words and reason', async () => {
  const api = createApi({ base: '/red/', token: () => null, fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: '保存中です', reason: 'busy' }) }) });
  await assert.rejects(api.post('record/save', { mode: 'over' }), (e: unknown) => e instanceof PaneError && e.message === '保存中です' && e.reason === 'busy' && e.status === 409);
  assert.equal(api.url('scene'), '/red/physical-sandbox/scene');
});
