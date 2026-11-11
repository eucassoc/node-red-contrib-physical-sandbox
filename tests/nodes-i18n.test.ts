// The nodes' catalogs and help in Japanese and English: the same keys in both, help for both,
// statuses resolved from the runtime's language, and no key left in a template that has no entry.
import { test, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import psInNode from '../src/nodes/ps-in.js';
import psPlayNode from '../src/nodes/ps-play.js';
import { catalogUnderscore, readCatalog } from './helpers/node-catalog.js';
import { repoRoot } from './helpers/built-package.js';

const require = createRequire(import.meta.url);
const helper = require('node-red-node-test-helper');
before(() => helper.init(require.resolve('node-red')));
afterEach(async () => { await helper.unload(); });

const NODES = ['ps-in', 'ps-play'] as const;
const japanese = /[぀-ヿ一-鿿]/;

function flatten(o: Record<string, any>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') out[prefix + k] = v;
    else Object.assign(out, flatten(v, `${prefix}${k}.`));
  }
  return out;
}

test('the en-US and ja catalogs of each node have the same keys, none empty, and the English has no Japanese', () => {
  for (const node of NODES) {
    const en = flatten(readCatalog(node, 'en-US'));
    const ja = flatten(readCatalog(node, 'ja'));
    assert.deepEqual(Object.keys(ja).sort(), Object.keys(en).sort(), node);
    for (const [key, text] of Object.entries(en)) {
      assert.ok(text.trim() && ja[key].trim(), `${node} ${key}: neither is empty`);
      assert.doesNotMatch(text, japanese, `${node} ${key}: English text`);
      if (!key.endsWith('.palette')) assert.match(ja[key], japanese, `${node} ${key}: Japanese text`); // the node's own name stays ps in / ps play
      // the same placeholders in both
      assert.deepEqual(text.match(/__\w+__/g)?.sort(), ja[key].match(/__\w+__/g)?.sort(), `${node} ${key}: placeholders`);
    }
  }
});

test('each node has help in both languages, with the node\'s own help block, and the English help has no Japanese', () => {
  for (const node of NODES) {
    for (const lang of ['en-US', 'ja']) {
      const file = join(repoRoot, 'src', 'nodes', 'locales', lang, `${node}.html`);
      assert.ok(existsSync(file), file);
      const html = readFileSync(file, 'utf8');
      assert.match(html, new RegExp(`data-help-name="${node.replace('-', ' ')}"`));
      if (lang === 'en-US') assert.doesNotMatch(html, japanese, `${node} English help`);
      else assert.match(html, japanese);
    }
  }
});

test('every catalog key a template or a node asks for exists in the catalog', () => {
  for (const node of NODES) {
    const keys = flatten(readCatalog(node, 'en-US'));
    const sources = ['html', 'ts'].map((ext) => readFileSync(join(repoRoot, 'src', 'nodes', `${node}.${ext}`), 'utf8')).join('\n');
    const asked = [...sources.matchAll(new RegExp(`${node}\\.(?:palette|[a-zA-Z]+\\.[a-zA-Z]+)`, 'g'))].map((m) => m[0]);
    for (const key of new Set(asked)) assert.ok(key in keys, `${key} is in the ${node} catalog`);
    // the status keys the runtime asks for through T('...') in ps-play
    if (node === 'ps-play') {
      for (const m of sources.matchAll(/\b(?:T|count)\('(\w+)'/g)) assert.ok(`ps-play.status.${m[1]}` in keys, `status ${m[1]}`);
    }
    // and no key is left unused
    for (const key of Object.keys(keys)) {
      const last = key.split('.').slice(1).join('.');
      assert.ok(sources.includes(key) || (key.includes('.status.') && sources.includes(`'${key.split('.').at(-1)}'`)), `${key} is used (${last})`);
    }
  }
});

function inFlow(type: string, config: Record<string, unknown> = {}) {
  return [{ id: 'n', type, wires: [[]], ...config }];
}

for (const [lang, expected] of [['ja', 'プラグインが読み込まれていません'], ['en-US', 'The plugin is not loaded']] as const) {
  test(`a node's status text is the ${lang} catalog's, resolved, never a key`, async () => {
    const withLang = [psInNode, psPlayNode].map((fn) => (red: any) => {
      red._ = catalogUnderscore(lang);
      red.plugins.get = () => undefined;
      return fn(red);
    });
    await helper.load(withLang, [...inFlow('ps in'), { id: 'p', type: 'ps play', source: 'inline', record: '{}', wires: [[]] }]);
    const seen: any[] = [];
    for (const id of ['n', 'p']) {
      const node = helper.getNode(id);
      const original = node.status.bind(node);
      node.status = (s: any) => { seen.push(s); return original(s); };
      node.receive(id === 'n' ? { topic: 'ps/a/b/state', payload: { at: 1 } } : { payload: 'start' });
    }
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.equal(s.text, expected);
      assert.doesNotMatch(s.text, /^ps-(in|play)\./);
    }
  });
}

for (const lang of ['ja', 'en-US'] as const) {
  test(`ps play says a PS.com refusal in the ${lang} catalog's words, never the plugin's Japanese or a raw code`, async () => {
    const catalog = flatten(readCatalog('ps-play', lang));
    const fill = (key: string, ref = 'ada/walk') => catalog[`ps-play.status.${key}`].replace('__ref__', ref);
    // from the plugin's own bundle: matched by name, with the plugin's Japanese as the message
    const foreign = (code: string, status: number, message = code) => Object.assign(new Error(message), { name: 'Refused', code, status });
    const cases: [Error, string][] = [
      [foreign('not-a-record', 200, 'ada/walk は記録ではありません'), fill('notARecord')],
      [foreign('weird-code', 400), fill('refused')],
      [foreign('bad-answer', 200), fill('refused')],
      [foreign('not-found', 404), fill('notFound')],
      [Object.assign(new Error('x'), { name: 'Offline' }), fill('offline')],
    ];
    for (const [error, text] of cases) {
      const hub = { client: { openRecord: async () => { throw error; }, status: () => ({ signedIn: true, handle: 'ada' }) }, refreshStatus() {}, scene: () => ({ site: 'local' }), push() {} };
      const withLang = (red: any) => {
        red._ = catalogUnderscore(lang);
        red.plugins.get = () => ({ hub });
        return psPlayNode(red);
      };
      await helper.load([withLang], [{ id: 'p', type: 'ps play', source: 'record', ref: 'ada/walk', wires: [[]] }]);
      const node = helper.getNode('p');
      const seen: any[] = [];
      node.status = (s: any) => { seen.push(s); };
      node.on('call:error', () => {});
      node.receive({ payload: 'start' });
      for (let i = 0; i < 50 && seen.at(-1)?.fill !== 'red'; i += 1) await new Promise((done) => setTimeout(done, 5));
      assert.equal(seen.at(-1)?.text, text, `${(error as any).code ?? error.name}`);
      assert.doesNotMatch(text, /weird-code|bad-answer/);
      if (lang === 'en-US') assert.doesNotMatch(text, japanese);
      await helper.unload();
    }
  });
}

test('the English statuses say it as the pane does', () => {
  const en = flatten(readCatalog('ps-play', 'en-US'));
  assert.equal(en['ps-play.status.offline'], 'PS.com could not be reached');
  assert.match(en['ps-play.status.notFound'], /^The record was not found \(__ref__\)$/);
  assert.match(en['ps-play.status.notFoundSignedOut'], /^The record was not found \(__ref__\)\. /);
});
