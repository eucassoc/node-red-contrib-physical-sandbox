// The pane's words (src/pane/words.ts): Japanese with its English beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WORDS } from '../../src/pane/words.js';

/** A key's words in one language, filled in (as the pane's `say` does). */
const fill = (language: 'ja' | 'en') => (key: keyof typeof WORDS, params: Record<string, unknown> = {}): string =>
  WORDS[key][language].replace(/\{(\w+)\}/g, (all, name) => (Object.hasOwn(params, name) ? String(params[name]) : all));
const ja = fill('ja');
const en = fill('en');


test('every word has its Japanese and its English, with the same {names} to fill', () => {
  const japanese = /[぀-ヿ一-鿿]/;
  const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [key, { ja: jp, en: english }] of Object.entries(WORDS)) {
    assert.ok(jp && english, key);
    assert.doesNotMatch(english, japanese, `${key}: the English has no Japanese`);
    assert.deepEqual(names(english), names(jp), `${key}: the same names`);
  }
});

test('a word is filled by name, and a name not given is left as it is', () => {
  assert.equal(ja('recording', { n: 3 }), '流れている動きを記録中（3 件）');
  assert.equal(en('recording', { n: 3 }), 'Recording the stream (3)');
  assert.equal(ja('unsent'), 'PS.com 未保存: {name}');
});
