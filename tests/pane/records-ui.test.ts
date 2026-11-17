// What the records part of the pane shows (src/pane/records-ui.ts) and the robots lists (src/pane/place-ui.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { myRecordRows, NAME, openedLine, playAgainBody, playingLine, recordingLine, saveButtons, siteResetOffered, unsentLines } from '../../src/pane/records-ui.js';
import { machineRows, moveRequest, placedRows, placeRequest, rowAt, turnedBy } from '../../src/pane/place-ui.js';
import { setLang, WORDS } from '../../src/pane/words.js';

/** A key's words in one language, filled in (as the pane's `say` does). */
const fill = (language: 'ja' | 'en') => (key: keyof typeof WORDS, params: Record<string, unknown> = {}): string =>
  WORDS[key][language].replace(/\{(\w+)\}/g, (all, name) => (Object.hasOwn(params, name) ? String(params[name]) : all));
const ja = fill('ja');


setLang('ja'); // these lines are checked in Japanese (the language tests are in words.test.ts)

const signedIn = { signedIn: true, handle: 'ada' };

test('上書き保存 is offered only over the signed-in person\'s own opened PS.com record; a new record always', () => {
  assert.deepEqual(saveButtons(null), { over: false, asNew: true });
  assert.deepEqual(saveButtons({ login: signedIn, opened: null }), { over: false, asNew: true });
  assert.deepEqual(saveButtons({ login: signedIn, opened: { file: 'walk.json' } }), { over: false, asNew: true });
  assert.deepEqual(saveButtons({ login: signedIn, opened: { ref: 'bob/walk', version: '2', own: false } }), { over: false, asNew: true });
  assert.deepEqual(saveButtons({ login: signedIn, opened: { ref: 'ada/walk', version: '2', own: true } }), { over: true, asNew: true });
  assert.deepEqual(saveButtons({ login: { signedIn: false, handle: null }, opened: { ref: 'ada/walk', version: '2', own: true } }), { over: false, asNew: true }, 'signed out since');
});

test('the lines: what the stream holds, the opened record, what is playing, the copies PS.com does not have', () => {
  assert.equal(recordingLine({ recorded: 12 }), '流れている動きを記録中（12 件）');
  assert.equal(recordingLine(null), '流れている動きを記録中（0 件）');
  assert.equal(openedLine({ opened: { ref: 'ada/walk', version: '3', own: true } }), '開いている記録: ada/walk（バージョン 3）');
  assert.equal(openedLine({ opened: { file: 'walk.record.json' } }), '開いている記録: walk.record.json');
  assert.equal(openedLine({ opened: null }), ja('openedNone'));
  assert.equal(playingLine({ playing: { source: 'ada/walk:3', t: 1, duration: 12.34 } }), '再生中: ada/walk:3（12.3 秒）');
  assert.equal(playingLine({ playing: null }), null);
  assert.deepEqual(unsentLines({ unsent: [{ name: 'walk', ref: 'ada/walk', mode: 'over' }] }), [{ name: 'walk', text: 'PS.com 未保存: walk' }]);
  assert.deepEqual(unsentLines({}), []);
});

test('再生 and 頭へ play what the hub has open, never opening it again; with nothing open they do nothing', () => {
  assert.deepEqual(playAgainBody({ opened: { ref: 'ada/walk', version: '3', own: true } }), { replay: true });
  assert.deepEqual(playAgainBody({ opened: { file: 'a.json' } }), { replay: true }, 'a file opened in another pane too');
  assert.equal(playAgainBody({ opened: null }), null);
  assert.equal(playAgainBody(null), null);
});

test('a new record\'s name follows the catalog rule', () => {
  for (const ok of ['ab', 'walk-2', 'a1b2']) assert.match(ok, NAME);
  for (const bad of ['a', '-ab', 'ab-', 'Walk', 'a_b', 'x'.repeat(40)]) assert.doesNotMatch(bad, NAME);
});

test('the robots list takes the rows of GET machines; the placed list says which could not be drawn', () => {
  assert.deepEqual(machineRows({ machines: [
    { ref: 'physical-sandbox/openarm:3', label: 'OpenArm', source: 'catalog', kind: 'machine', bundle: {} },
    { ref: 'mybot', label: '', source: 'local', kind: 'machine' },
    { label: 'no ref' },
  ] }), [
    { ref: 'physical-sandbox/openarm:3', label: 'OpenArm', source: 'catalog', kind: 'machine' },
    { ref: 'mybot', label: 'mybot', source: 'local', kind: 'machine' },
  ]);
  assert.deepEqual(machineRows(null), []);
  const scene = { site: 'local', names: {}, devices: [{ id: 'openarm-1', product: 'physical-sandbox/openarm:3' }, { id: 'ghost-1', product: 'gone/ghost:1' }] };
  assert.deepEqual(placedRows(scene, [{ deviceId: 'ghost-1', product: 'gone/ghost:1' }]), [
    { id: 'openarm-1', product: 'physical-sandbox/openarm:3', note: null, xy: [0, 0], yawDeg: 0 },
    { id: 'ghost-1', product: 'gone/ghost:1', note: 'gone/ghost:1 を読み込めませんでした', xy: [0, 0], yawDeg: 0 },
  ]);
  assert.deepEqual(placeRequest('physical-sandbox/openarm', [1.5, -0.25]), { product: 'physical-sandbox/openarm', xyz: [1.5, -0.25, 0], yaw: 0 });
});

test('the person\'s own PS.com records: each row opens its ref; signed out, offline or none, a line says why', () => {
  assert.deepEqual(myRecordRows({ signedIn: true, rows: [{ ref: 'ada/walk', title: '歩く', version: '2' }, { ref: 'ada/turn', title: null, version: '1' }, { title: 'no ref' }] }), {
    rows: [
      { ref: 'ada/walk', label: '歩く', detail: 'ada/walk（バージョン 2）' },
      { ref: 'ada/turn', label: 'ada/turn', detail: 'ada/turn（バージョン 1）' },
    ],
    note: null,
  });
  assert.deepEqual(myRecordRows({ signedIn: true, rows: [] }), { rows: [], note: ja('myRecordsNone') });
  assert.deepEqual(myRecordRows({ rows: [], signedIn: false }), { rows: [], note: ja('myRecordsSignedOut') });
  assert.deepEqual(myRecordRows({ rows: [], offline: true }), { rows: [], note: ja('myRecordsOffline') });
  assert.deepEqual(myRecordRows(null), { rows: [], note: ja('myRecordsOffline') });
});

test('「現地をもとに戻す」 is offered only when the scene\'s site is not the plugin\'s', () => {
  assert.equal(siteResetOffered('yard', { defaultSite: 'local' }), true);
  assert.equal(siteResetOffered('local', { defaultSite: 'local' }), false);
  assert.equal(siteResetOffered(null, { defaultSite: 'local' }), false);
  assert.equal(siteResetOffered('yard', null), false);
  assert.equal(ja('site', { site: 'yard' }), '現地: yard');
});

// 2026-11-17: a robot once placed could only be removed and dragged in again, always facing 0°
test('a placed robot is re-placed and turned under its own id, keeping what the other act left', () => {
  const scene = { site: 'local', names: {}, devices: [{ id: 'so101-1', product: 'physical-sandbox/so101:1', pose: { xyz: [0.08, 0.06, 0], rpy: [0, 0, Math.PI / 3] } }] };
  const [row] = placedRows(scene);
  assert.deepEqual(row.xy, [0.08, 0.06]);
  assert.equal(row.yawDeg, 60);
  // Re-placed: where the floor was clicked, facing as it did
  assert.deepEqual(moveRequest(row, { xy: [0.2, 0.1] }), { id: 'so101-1', product: 'physical-sandbox/so101:1', xyz: [0.2, 0.1, 0], yaw: Math.PI / 3 });
  // Turned: where it stands, facing the degrees typed
  assert.deepEqual(moveRequest(row, { yawDeg: -90 }), { id: 'so101-1', product: 'physical-sandbox/so101:1', xyz: [0.08, 0.06, 0], yaw: -Math.PI / 2 });
  // ← turns it left (counter-clockwise seen from above), → right, 15° a press, kept within -180..180
  assert.equal(turnedBy(60, 'ArrowLeft'), 75);
  assert.equal(turnedBy(60, 'ArrowRight'), 45);
  assert.equal(turnedBy(175, 'ArrowLeft'), -170);
  assert.equal(turnedBy(60, 'Enter'), null);
});

// 2026-11-17: the same hands as PS.com's screen: a click on a robot picks it
test('a click picks the placed robot standing nearest it on the page, within reach', () => {
  const scene = { site: 'local', names: {}, devices: [
    { id: 'a-1', product: 'x/a:1', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } },
    { id: 'b-1', product: 'x/b:1', pose: { xyz: [1, 0, 0], rpy: [0, 0, 0] } },
  ] };
  const rows = placedRows(scene);
  // the page shows a metre as 100 px, the site's origin at (200, 200)
  const pageOf = ([x, y]: [number, number]) => ({ x: 200 + x * 100, y: 200 - y * 100 });
  assert.equal(rowAt(rows, { x: 210, y: 195 }, pageOf)?.id, 'a-1');
  assert.equal(rowAt(rows, { x: 285, y: 205 }, pageOf)?.id, 'b-1');
  assert.equal(rowAt(rows, { x: 500, y: 200 }, pageOf), null, 'out of reach of both');
  // a robot behind the camera has no page point
  assert.equal(rowAt(rows, { x: 200, y: 200 }, () => null), null);
});
