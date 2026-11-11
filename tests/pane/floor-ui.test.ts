// 「床を決定」's steps (src/pane/floor-ui.ts floorStep, floorRequest, floorPrompt).
import test from 'node:test';
import assert from 'node:assert/strict';
import { floorPrompt, floorRequest, floorStep, idleFloor, lengthOf, type FloorAction, type FloorState } from '../../src/pane/floor-ui.js';
import { ja } from '../../src/pane/words.js';

const run = (state: FloorState, ...actions: FloorAction[]) => actions.reduce(floorStep, state);
const click = (u: number, v: number): FloorAction => ({ type: 'click', at: { u, v } });
const SIZE = { width: 1280, height: 720 };

test('corners are clicked 1 to 4, then the two lengths are asked for; a fifth click does nothing', () => {
  let s = run(idleFloor(), { type: 'start' });
  assert.equal(s.step, 'corners');
  assert.equal(floorPrompt(s), ja('cornerNext', { n: 1 }));
  s = run(s, click(100, 600), click(1100, 600), click(900, 300));
  assert.equal(s.step, 'corners');
  assert.equal(floorPrompt(s), ja('cornerNext', { n: 4 }));
  s = run(s, click(300, 300));
  assert.equal(s.step, 'lengths');
  assert.equal(floorPrompt(s), ja('lengthsHint'));
  const after = run(s, click(5, 5));
  assert.deepEqual(after, s);
  assert.deepEqual((s as { corners: unknown }).corners, [{ u: 100, v: 600 }, { u: 1100, v: 600 }, { u: 900, v: 300 }, { u: 300, v: 300 }]);
});

test('決定 needs both lengths as numbers above zero; then the request carries the corners, the lengths and the picture\'s size', () => {
  let s = run(idleFloor(), { type: 'start' }, click(1, 2), click(3, 4), click(5, 6), click(7, 8));
  s = run(s, { type: 'decide' });
  assert.equal(s.step, 'lengths');
  assert.equal(s.note, ja('badLength'));
  assert.equal(floorRequest(s, SIZE), null, 'nothing to send yet');
  s = run(s, { type: 'edge', index: 0, text: '4' }, { type: 'edge', index: 1, text: '-1' }, { type: 'decide' });
  assert.equal(s.step, 'lengths');
  s = run(s, { type: 'edge', index: 1, text: '2,5' }, { type: 'decide' });
  assert.equal(s.step, 'deciding');
  assert.equal(floorPrompt(s), ja('deciding'));
  assert.deepEqual(floorRequest(s, SIZE), {
    pixels: [{ u: 1, v: 2 }, { u: 3, v: 4 }, { u: 5, v: 6 }, { u: 7, v: 8 }],
    edgesM: [4, 2.5],
    width: 1280,
    height: 720,
  });
  assert.equal(run(s, click(9, 9)), s, 'no clicks while deciding');
});

test('the hub\'s answer ends it with the lengths it took; a refusal asks for the corners again and keeps the lengths', () => {
  const deciding = run(idleFloor(), { type: 'start' }, click(1, 2), click(3, 4), click(5, 6), click(7, 8),
    { type: 'edge', index: 0, text: '4' }, { type: 'edge', index: 1, text: '3' }, { type: 'decide' });
  const done = run(deciding, { type: 'answered', edgesM: [4, 3.125] });
  assert.equal(done.step, 'idle');
  assert.equal(done.note, ja('floorDecided', { a: '4', b: '3.125' }));

  const refused = run(deciding, { type: 'refused', note: '角の順番が逆です' });
  assert.equal(refused.step, 'corners');
  assert.deepEqual(refused.step === 'corners' && [refused.corners, refused.edges], [[], ['4', '3']]);
  assert.equal(refused.note, '角の順番が逆です');
  assert.equal(floorPrompt(run(refused, click(1, 1))), ja('cornerNext', { n: 2 }), 'the note goes with the next click');
});

test('最初から指定する clears the corners, やめる leaves, and a known floor\'s lengths are offered', () => {
  const s = run(idleFloor(), { type: 'start', edges: [4, 2.5] }, click(1, 2), click(3, 4));
  assert.deepEqual(s.step === 'corners' && s.edges, ['4', '2.5']);
  const over = run(s, { type: 'startOver' });
  assert.deepEqual(over.step === 'corners' && [over.corners, over.edges], [[], ['4', '2.5']]);
  assert.deepEqual(run(s, { type: 'cancel' }), idleFloor());
  assert.deepEqual(run(idleFloor(), { type: 'startOver' }), idleFloor());
});

test('a length is read with a comma or a point, and only above zero', () => {
  assert.equal(lengthOf('2.5'), 2.5);
  assert.equal(lengthOf(' 2,5 '), 2.5);
  assert.equal(lengthOf('0'), null);
  assert.equal(lengthOf('abc'), null);
  assert.equal(lengthOf(''), null);
});
