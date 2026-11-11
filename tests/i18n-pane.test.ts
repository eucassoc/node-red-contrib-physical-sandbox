// One language in the pane and the plugin: the word tables, the language the pane picks, what a
// jsdom render of its panels shows in each language, a refused save, and the tools' unchanged text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { PLAIN, WORDS as ACTION_WORDS } from '../src/plugin/actions.js';
import { registerRoutes, WORDS as ROUTE_WORDS } from '../src/plugin/routes.js';
import { createHub } from '../src/plugin/hub.js';
import { readSettings } from '../src/plugin/settings.js';
import { createApi, listenToEditor, PaneError } from '../src/pane/comms-client.js';
import { mountFloorUi } from '../src/pane/floor-ui.js';
import { mountPlaceUi } from '../src/pane/place-ui.js';
import { mountRecordsUi } from '../src/pane/records-ui.js';
import { forgetLangListeners, lang, langOf, say, setLang, WORDS } from '../src/pane/words.js';
import { STREAM_WORDS } from '../src/plugin/tools/stream.js';
import { editorScript, fakeEditor } from './helpers/fake-editor.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Kana, kanji, and the Japanese punctuation and full-width forms (、。（）). */
const japanese = /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;

test('every pane word and every server word has a Japanese and an English, neither empty, and the English has no Japanese', () => {
  for (const [name, table] of [['pane', WORDS], ['server', PLAIN]] as const) {
    for (const [key, both] of Object.entries(table) as [string, { ja: string; en: string }][]) {
      assert.deepEqual(Object.keys(both).sort(), ['en', 'ja'], `${name} ${key}`);
      assert.ok(both.ja.trim() && both.en.trim(), `${name} ${key}: neither is empty`);
      assert.doesNotMatch(both.en, japanese, `${name} ${key}: no Japanese in the English`);
    }
  }
  // the routes' words and the tools' words are the Japanese of the same table
  for (const key of Object.keys(PLAIN) as (keyof typeof PLAIN)[]) assert.equal(ACTION_WORDS[key], PLAIN[key].ja);
  assert.equal(ROUTE_WORDS, ACTION_WORDS);
});

test('the editor\'s own words (editor.html) have both languages and follow RED.i18n.lang()', () => {
  for (const [language, expected] of [['ja', 'ja'], ['ja-JP', 'ja'], ['en-US', 'en'], ['fr', 'en'], ['de', 'en'], ['', 'en']] as const) {
    const context: Record<string, any> = { RED: { i18n: { lang: () => language } } };
    vm.runInNewContext(`${editorScript('words')}\nvar out = { lang: psEditorLang(), open: psEditorSay('openWindow'), tab: psEditorSay('tabLabel'), words: PS_EDITOR_WORDS };`, context);
    assert.equal(context.out.lang, expected, language);
    for (const [key, both] of Object.entries(context.out.words) as [string, { ja: string; en: string }][]) {
      assert.ok(both.ja && both.en, key);
      assert.doesNotMatch(both.en, japanese, `${key}: no Japanese in the English`);
    }
    assert.equal(japanese.test(context.out.open), expected === 'ja', `the link is in ${expected} only`);
  }
});

test('lang() follows the language the editor posted, then localStorage, then the browser, and is English for fr', () => {
  const navigatorWas = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const storageWas = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const setNavigator = (language: string | undefined) => Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true });
  const setStorage = (value: string | null) => Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => (k === 'editor-language' ? value : null) }, configurable: true });
  try {
    setLang(null);
    setNavigator(undefined); setStorage(null);
    assert.equal(lang(), 'en', 'nothing set: English');
    setNavigator('ja-JP');
    assert.equal(lang(), 'ja', 'the browser');
    setStorage('fr');
    assert.equal(lang(), 'en', 'localStorage before the browser, and fr is English');
    setStorage('ja');
    setNavigator('en-US');
    assert.equal(lang(), 'ja', 'localStorage');
    setLang('en');
    assert.equal(lang(), 'en', 'what the editor posted comes first');
    setLang('ja-JP');
    assert.equal(lang(), 'ja');
    setLang('fr');
    assert.equal(lang(), 'en');
    setLang(null);
    assert.equal(lang(), 'ja', 'forgetting what was posted falls back to localStorage');
    assert.equal(langOf('ja_JP'), 'ja');
    assert.equal(langOf(undefined), 'en');
  } finally {
    setLang(null);
    for (const [name, was] of [['navigator', navigatorWas], ['localStorage', storageWas]] as const) {
      if (was) Object.defineProperty(globalThis, name, was); else delete (globalThis as any)[name];
    }
  }
});

test('the editor posts its language with its token, and the pane takes it', () => {
  const sent: any[] = [];
  const listeners: ((event: any) => void)[] = [];
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  const win = { location: { origin: 'http://x' }, parent, addEventListener: (_: string, fn: any) => listeners.push(fn), removeEventListener() {} };
  const given: any[] = [];
  listenToEditor(win, { scene() {}, state() {}, snapshot() {}, status() {} }, (token, language) => given.push([token, language]));
  listeners[0]({ origin: 'http://x', source: parent, data: { type: 'ps-pane-token', token: 'T', lang: 'ja' } });
  listeners[0]({ origin: 'http://x', source: parent, data: { type: 'ps-pane-token', token: null } });
  assert.deepEqual(given, [['T', 'ja'], [null, null]]);
  // and the editor's side posts `lang` in that message (the plugin script, run against a fake RED)
  const html = readFileSync(join(import.meta.dirname, '..', 'src', 'plugin', 'editor.html'), 'utf8');
  assert.match(html, /type: EDITOR_TOKEN, token: editorToken\(\), lang: psEditorLang\(\)/);
});

const nothing = async () => ({});
const fakeApi = (get: (path: string) => Promise<any> = nothing) => ({ get, post: nothing, upload: nothing, url: (p: string) => p }) as any;

/** The pane's panels mounted in jsdom with every kind of line drawn; their text and tooltips. */
async function render(language: string): Promise<string> {
  const dom = new JSDOM('<!doctype html><body></body>');
  const keep = { document: (globalThis as any).document, window: (globalThis as any).window, confirm: undefined };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
  setLang(language);
  try {
    const doc = dom.window.document;
    const root = (name: string) => { const e = doc.createElement('section'); e.id = name; doc.body.append(e); return e; };
    const floorRoot = root('floor');
    const robots = root('robots');
    const placed = root('placed');
    const play = root('play');
    const save = root('save');
    const account = root('account');
    const overlay = doc.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as SVGSVGElement;
    const floor = mountFloorUi({ root: floorRoot, overlay, api: fakeApi(), pixelAt: (x, y) => ({ x, y }) as any, pictureSize: () => ({ width: 100, height: 100 }) });
    floor.click(0, 0);
    const place = mountPlaceUi({ robotsRoot: robots, placedRoot: placed, api: fakeApi(async () => ({ machines: [{ ref: 'physical-sandbox/so101:1', label: 'SO-101', source: 'catalog' }, { ref: 'ada/arm:2', label: 'ada/arm:2', source: 'cache' }], offline: true })), dropTarget: doc.createElement('div'), floorPointAt: () => null, say() {} });
    await place.refresh();
    place.setScene({ site: 'local', devices: [{ id: 'arm-1', product: 'ada/arm:1' }], names: {} } as any, [{ deviceId: 'arm-1', product: 'ada/arm:1' }]);
    const records = mountRecordsUi({ playRoot: play, saveRoot: save, accountRoot: account, api: fakeApi(async () => ({ signedIn: true, records: [] })), say() {} });
    records.setSite('yard');
    records.setStatus({
      recorded: 3, full: true, login: { signedIn: true, handle: 'ada' }, agentFrames: true, defaultSite: 'local',
      opened: { ref: 'ada/walk', version: '2', own: true, latest: '2' }, playing: { source: 'ada/walk:2', t: 1, duration: 4 },
      unsent: [{ name: 'walk', ref: 'ada/walk', mode: 'over' }],
    } as any);
    const texts = [...doc.querySelectorAll('*')].flatMap((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? ''));
    const attrs = [...doc.querySelectorAll('[title],[placeholder]')].flatMap((e) => [e.getAttribute('title') ?? '', e.getAttribute('placeholder') ?? '']);
    return [...texts, ...attrs].join('\n');
  } finally {
    setLang(null);
    forgetLangListeners();
    dom.window.close();
    for (const [name, was] of Object.entries(keep)) { if (was === undefined) delete (globalThis as any)[name]; else (globalThis as any)[name] = was; }
  }
}

test('in Japanese the pane\'s panels show no English, in English no Japanese', async () => {
  // what stays the same in both: the product's own names and the shape of a ref
  const names = /physical-sandbox\/so101|SO-101|PS\.com|Physical Sandbox|handle\/name|ada\/walk|ada\/arm|yard|local|walk|arm-1|arm|ada|Deploy|m\b/g;
  const ja = await render('ja');
  const en = await render('en');
  assert.ok(ja.length > 200 && en.length > 200, 'something was drawn');
  assert.match(ja, /床を決定/);
  assert.match(en, /Decide the floor/);
  assert.deepEqual(ja.replace(names, "").match(/[A-Za-z]{3,}/g), null, "English in the Japanese pane");
  assert.doesNotMatch(en, japanese, `Japanese in the English pane:\n${en}`);
  assert.equal(await render('fr'), en, 'fr is English');
});

test('a label shown before the editor\'s language arrives is written again in it', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  Object.assign(globalThis, { document: dom.window.document });
  try {
    setLang(null);
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true });
    const { labelOf } = await import('../src/pane/words.js');
    const label = labelOf('decide', 'button');
    assert.equal(label.textContent, 'Decide');
    setLang('ja');
    assert.equal(label.textContent, '決定');
    setLang('en');
    assert.equal(label.textContent, 'Decide');
  } finally {
    setLang(null);
    delete (globalThis as any).document;
    delete (globalThis as any).navigator;
  }
});

test('a refused save shows only the chosen language, from the route\'s own answer', async () => {
  const userDir = mkdtempSync(join(tmpdir(), 'ps-i18n-'));
  const red = fakeRed({ userDir });
  const hub = createHub(red.RED, { userDir, settings: readSettings({ catalogBase: 'http://127.0.0.1:9', localMachineDirs: [] }, { userDir, env: {} }), clock: fakeClock(), pollMs: 0 });
  registerRoutes(red.RED, hub, { paneDir: mkdtempSync(join(tmpdir(), 'ps-i18n-pane-')), cacheRoot: mkdtempSync(join(tmpdir(), 'ps-i18n-cache-')) });
  const base = await red.listen();
  try {
    const api = createApi({ base: `${base}/`, token: () => null });
    const refusal = async () => {
      try { await api.post('record/save', { mode: 'new', name: 'Bad Name' }); } catch (e) { return e as PaneError; }
      throw new Error('not refused');
    };
    setLang('ja');
    let e = await refusal();
    assert.equal(e.status, 400);
    assert.equal(e.reason, 'bad-name');
    assert.equal(e.message, PLAIN.badName.ja);
    assert.doesNotMatch(e.message, /\//, 'not joined');
    setLang('en');
    e = await refusal();
    assert.equal(e.message, PLAIN.badName.en);
    assert.doesNotMatch(e.message, japanese);
    // the answer carries both for the pane to pick, and `error` stays Japanese for older callers
    const res = await fetch(`${base}/physical-sandbox/record/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PS-Pane': '1' }, body: JSON.stringify({ mode: 'over' }) });
    const json: any = await res.json();
    assert.equal(res.status, 409);
    assert.deepEqual(json.message, PLAIN.notOwn);
    assert.equal(json.error, PLAIN.notOwn.ja);
    assert.equal(json.reason, 'not-own');
  } finally {
    setLang(null);
    hub.close();
    await red.close();
  }
});

test('a pane answer without both languages falls back to its error text', async () => {
  const api = createApi({ base: '/red/', token: () => null, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom', reason: 'failed' }) }) });
  await assert.rejects(api.get('x'), (e: unknown) => e instanceof PaneError && e.message === 'boom');
});

test('the tools keep their exact text: Japanese joined with English, as before', () => {
  assert.equal(STREAM_WORDS.nothingToPlay, '再生できるメッセージがありません / There is nothing to play');
  assert.equal(ACTION_WORDS.badName, '名前は英小文字・数字・- の 2〜39 文字で、先頭と末尾は英小文字か数字にしてください');
  // every Japanese line the tools use is kept in a fixture, so a changed word shows in a diff
  const kept = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'action-words.ja.json'), 'utf8'));
  assert.deepEqual(ACTION_WORDS, kept);
});

test('the editor\'s notice follows the editor language', async () => {
  const ja = fakeEditor({ language: 'ja', post: async (b) => (b.claim ? { granted: true, ticket: 'T' } : {}) });
  const en = fakeEditor({ language: 'en-GB', post: async (b) => (b.claim ? { granted: true, ticket: 'T' } : {}) });
  for (const editor of [ja, en]) {
    editor.deliver('ps-editor/request', { id: 'r', op: 'propose', args: { nodes: [{ id: 'a', type: 'inject' }] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(ja.notes[0].text, japanese);
  assert.doesNotMatch(en.notes[0].text, japanese);
  assert.match(en.notes[0].text, /Deploy/);
  assert.match(ja.notes[0].text, /デプロイ/);
  assert.doesNotMatch(ja.notes[0].text, /Deploy/);
});

test('the floor prompt and its note follow a language change; the page language follows too', () => {
  const dom = new JSDOM('<!doctype html><html lang="ja"><body></body></html>');
  const keep = { document: (globalThis as any).document, window: (globalThis as any).window };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
  try {
    setLang('ja');
    assert.equal(dom.window.document.documentElement.lang, 'ja');
    const root = dom.window.document.createElement('section');
    dom.window.document.body.append(root);
    const overlay = dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as SVGSVGElement;
    const floor = mountFloorUi({ root, overlay, api: fakeApi(), pixelAt: (x, y) => ({ u: x, v: y }), pictureSize: () => ({ width: 100, height: 100 }) });
    const prompt = () => root.querySelector('.ps-prompt')!.textContent;
    (root.querySelector('[data-word="decideFloor"]') as HTMLElement).click();
    assert.equal(prompt(), WORDS.cornerNext.ja.replace('{n}', '1'));
    setLang('en');
    assert.equal(prompt(), WORDS.cornerNext.en.replace('{n}', '1'));
    assert.equal(dom.window.document.documentElement.lang, 'en');
    // a note made from a word is said again too
    for (const at of [[1, 1], [9, 1], [9, 9], [1, 9]]) floor.click(at[0], at[1]);
    (root.querySelector('[data-word="decide"]') as HTMLElement).click();
    assert.equal(prompt(), WORDS.badLength.en);
    setLang('ja');
    assert.equal(prompt(), WORDS.badLength.ja);
    setLang(null);
  } finally {
    setLang(null);
    forgetLangListeners();
    dom.window.close();
    for (const [name, was] of Object.entries(keep)) { if (was === undefined) delete (globalThis as any)[name]; else (globalThis as any)[name] = was; }
  }
});
