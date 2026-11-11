// What the records part of the pane shows (src/pane/records-ui.ts) and the robots lists (src/pane/place-ui.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { myRecordRows, NAME, openedLine, playAgainBody, playingLine, recordingLine, saveButtons, siteResetOffered, unsentLines } from '../../src/pane/records-ui.js';
import { machineRows, placedRows, placeRequest } from '../../src/pane/place-ui.js';
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
    { id: 'openarm-1', product: 'physical-sandbox/openarm:3', note: null },
    { id: 'ghost-1', product: 'gone/ghost:1', note: 'gone/ghost:1 を読み込めませんでした' },
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
