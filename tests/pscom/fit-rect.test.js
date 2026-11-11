import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRect } from '../../src/pscom/fit-rect.js';

test('a wide picture in a tall box fills the width and sits in the middle', () => {
  assert.deepEqual(fitRect(960, 1000, 1920, 1080), { x: 0, y: 230, w: 960, h: 540 });
});

test('a tall picture in a wide box fills the height', () => {
  assert.deepEqual(fitRect(1000, 500, 500, 1000), { x: 375, y: 0, w: 250, h: 500 });
});

test('a box or a picture with no size gives an empty place, not NaN', () => {
  assert.deepEqual(fitRect(0, 500, 1920, 1080), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(fitRect(800, 500, 0, 0), { x: 0, y: 0, w: 0, h: 0 });
});

