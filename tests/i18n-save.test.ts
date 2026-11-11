// The save path and the robots list in one language: every sentence the plugin or its core makes
// for the person (a taken name, a save kept offline, another account's record, a robot only this
// machine has, an account with no handle, a PS.com item that is not a record) reaches the pane in
// the chosen language only, while the tools' Japanese `error`/`reason` stay as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { Answer, PLAIN } from '../src/plugin/actions.js';
import { registerRoutes } from '../src/plugin/routes.js';
import { createHub } from '../src/plugin/hub.js';
import { readSettings } from '../src/plugin/settings.js';
import { createApi, PaneError } from '../src/pane/comms-client.js';
import { mountPlaceUi } from '../src/pane/place-ui.js';
import { playingLine, savedText } from '../src/pane/records-ui.js';
import { forgetLangListeners, labelOf, setLang, trackedSize, WORDS } from '../src/pane/words.js';
import { OFFLINE, SIGN_IN, UNSENT_WORDS } from '../src/core/unsent.js';
import { CLIENT_WORDS, tokenFileIn } from '../src/core/pscom-client.js';
import { fakeClock, fakeRed } from './helpers/fake-red.js';
import { FakePsCom } from './helpers/fake-pscom.js';

/** Kana, kanji, and the Japanese punctuation and full-width forms (、。（）). */
const japanese = /[　-〿぀-ヿ一-鿿＀-￯]/;
const tmp = (): string => mkdtempSync(join(tmpdir(), 'ps-i18n-save-'));

const walkRecord = {
  schemaVersion: 3, frame: { frameId: 'site', up: '+Y', unit: 'm' }, markers: [],
  equipment: { site: { id: 'local' }, devices: [{ id: 'arm', product: 'physical-sandbox/so101:1', owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }] },
  names: { arm: 'arm' },
  traces: [{ deviceId: 'arm', samples: [{ t: 0, joints: { j: 0 } }, { t: 1, joints: { j: 1 } }] }],
  routes: [],
};

async function setup(fake: FakePsCom, localDirs: string[] = []) {
  const userDir = tmp();
  const red = fakeRed({ userDir });
  const hub = createHub(red.RED, { userDir, settings: readSettings({ catalogBase: fake.base, localMachineDirs: localDirs }, { userDir, env: {} }), clock: fakeClock(), pollMs: 0 });
  registerRoutes(red.RED, hub, { paneDir: tmp(), cacheRoot: tmp() });
  const base = await red.listen();
  const api = createApi({ base: `${base}/`, token: () => null });
  const signIn = async () => { await hub.client.loginStart(); await hub.client.loginPoll(); };
  return { hub, api, userDir, signIn, close: async () => { hub.close(); await red.close(); } };
}

/** What `run` gives in Japanese and in English. */
async function inBoth(run: () => Promise<string>): Promise<{ ja: string; en: string }> {
  try {
    setLang('ja');
    const ja = await run();
    setLang('en');
    const en = await run();
    return { ja, en };
  } finally { setLang(null); }
}

/** The refusal's words the pane shows. */
async function refusal(call: () => Promise<unknown>, reason?: string): Promise<string> {
  try { await call(); } catch (e) {
    assert.ok(e instanceof PaneError, String(e));
    if (reason) assert.equal(e.reason, reason);
    return e.message;
  }
  throw new Error('not refused');
}

function oneLanguageEach(both: { ja: string; en: string }, what: string): void {
  assert.match(both.ja, japanese, `${what}: the Japanese pane says it in Japanese: ${both.ja}`);
  assert.doesNotMatch(both.en, japanese, `${what}: no Japanese in the English pane: ${both.en}`);
}

test('a taken name is said in the chosen language only', async () => {
  const fake = await new FakePsCom().start();
  const s = await setup(fake);
  try {
    await s.signIn();
    await s.api.post('stream/play', { record: walkRecord });
    await s.api.post('record/save', { mode: 'new', name: 'walk' });
    const both = await inBoth(() => refusal(() => s.api.post('record/save', { mode: 'new', name: 'walk', title: 'again' }), 'taken'));
    oneLanguageEach(both, 'taken');
    assert.equal(both.ja, 'walk はもうあります。別の名前を指定してください');
    assert.equal(both.en, 'walk exists already. Give another name');
  } finally { await s.close(); await fake.stop(); }
});

test('a save kept on this computer (offline, signed out) is said fully in one language; the tools keep the Japanese reason', async () => {
  const fake = await new FakePsCom().start();
  const s = await setup(fake);
  try {
    await s.api.post('stream/play', { record: walkRecord });
    // signed out
    const signedOut = await s.api.post('record/save', { mode: 'new', name: 'walk' });
    assert.equal(signedOut.reason, SIGN_IN, 'the reason stays the Japanese sentence');
    assert.deepEqual(signedOut.reasonWords, UNSENT_WORDS.signIn);
    oneLanguageEach(await inBoth(async () => savedText(signedOut)), 'signed out');
    // signed in, then PS.com goes down
    await s.signIn();
    await fake.stop();
    const offline = await s.api.post('record/save', { mode: 'new', name: 'away', title: 'x' });
    assert.deepEqual([offline.saved, offline.reason], [false, OFFLINE]);
    const both = await inBoth(async () => savedText({ ...offline, skipped: ['ghost', 'shadow'] }));
    oneLanguageEach(both, 'offline');
    assert.equal(both.en, `Could not be saved to PS.com, kept on this computer (${UNSENT_WORDS.offline.en}) ghost, shadow name no placed robot and were left out of the record`);
    assert.equal(both.ja, `PS.com に保存できなかったため、このパソコンに残しました（${OFFLINE}） ghost、shadow はどのロボットの名前でもないため、記録に入れませんでした`);
  } finally { await s.close(); await fake.stop(); }
});

test('another account\'s record (the account changed since it was opened) is refused in the chosen language', async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'walk', '1', walkRecord);
  const s = await setup(fake);
  try {
    await s.signIn();
    await s.api.post('stream/play', { ref: 'ada/walk' });
    s.hub.stop();
    // signed in as another account meanwhile (psbx login shares the token file)
    const file = tokenFileIn(s.userDir);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), handle: 'eve' }));
    const both = await inBoth(() => refusal(() => s.api.post('record/save', { mode: 'over' }), 'not-mine'));
    oneLanguageEach(both, 'not-mine');
    assert.equal(both.ja, 'PS.com に保存できませんでした（ada/walk は eve の記録ではないため保存できません）');
    assert.equal(both.en, 'Could not save to PS.com (ada/walk is not a record of eve, so it cannot be saved)');
  } finally { await s.close(); await fake.stop(); }
});

test('a record naming a robot only this machine has is kept, and said in the chosen language', async () => {
  const fake = await new FakePsCom().start();
  const local = tmp();
  mkdirSync(join(local, 'myarm', 'assets'), { recursive: true });
  writeFileSync(join(local, 'myarm', 'bundle.json'), JSON.stringify({ id: 'myarm', rootLink: 'base', links: { base: { visuals: [] } }, joints: [] }));
  const s = await setup(fake, [local]);
  try {
    await s.signIn();
    await s.api.post('scene/place', { product: 'myarm', xyz: [0, 0] });
    const kept = await s.api.post('record/save', { mode: 'new', name: 'mine' });
    assert.deepEqual([kept.saved, kept.code], [false, 'local-machine']);
    assert.match(kept.reason, /手元のロボット myarm/, 'the tools keep the Japanese reason');
    const both = await inBoth(async () => savedText(kept));
    oneLanguageEach(both, 'local-machine');
    assert.match(both.en, /The robot myarm on this computer is not on PS\.com/);
  } finally { await s.close(); await fake.stop(); }
});

test('an account with no handle yet is refused in the chosen language', async () => {
  const fake = await new FakePsCom().start();
  fake.handle = '';
  const s = await setup(fake);
  try {
    await s.signIn();
    await s.api.post('stream/play', { record: walkRecord });
    const both = await inBoth(() => refusal(() => s.api.post('record/save', { mode: 'new', name: 'walk' }), 'no-handle'));
    oneLanguageEach(both, 'no-handle');
    assert.equal(both.en, `Could not save to PS.com (${CLIENT_WORDS.noHandle.en})`);
  } finally { await s.close(); await fake.stop(); }
});

test('opening a PS.com item that is not a record is refused in the chosen language', async () => {
  const fake = await new FakePsCom().start();
  fake.seed('ada', 'arm', '1', { id: 'arm' }, { kind: 'machine', visibility: 'public' });
  const s = await setup(fake);
  try {
    const both = await inBoth(() => refusal(() => s.api.post('stream/play', { ref: 'ada/arm' }), 'not-a-record'));
    oneLanguageEach(both, 'not-a-record');
    assert.deepEqual(both, { ja: 'ada/arm は記録ではありません', en: 'ada/arm is not a record' });
  } finally { await s.close(); await fake.stop(); }
});

test('an Answer takes words from PLAIN or given in both languages; a sentence with no English is refused', () => {
  assert.deepEqual(new Answer(409, PLAIN.busy.ja, 'busy').words, PLAIN.busy);
  const given = new Answer(400, { ja: 'ja 文', en: 'en text' }, 'x');
  assert.deepEqual([given.message, given.words.en], ['ja 文', 'en text']);
  // @ts-expect-error a sentence that is neither one of PLAIN's nor given with its English
  assert.throws(() => new Answer(400, 'どこにもない文', 'x'), /English/);
});

test('every sentence of the core has its Japanese and its English, with the same {names}', () => {
  const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [table, words] of [['unsent', UNSENT_WORDS], ['client', CLIENT_WORDS]] as const) {
    for (const [key, both] of Object.entries(words) as [string, { ja: string; en: string }][]) {
      assert.ok(both.ja && both.en, `${table}.${key}`);
      assert.match(both.ja, japanese, `${table}.${key}: the Japanese is Japanese`);
      assert.doesNotMatch(both.en, japanese, `${table}.${key}: no Japanese in the English`);
      assert.deepEqual(names(both.en), names(both.ja), `${table}.${key}: the same names`);
    }
  }
});

/** The robots list drawn in jsdom, with one row from each place. */
async function robotsText(language: string): Promise<string> {
  const dom = new JSDOM('<!doctype html><body></body>');
  const keep = { document: (globalThis as any).document, window: (globalThis as any).window };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
  setLang(language);
  try {
    const doc = dom.window.document;
    const robots = doc.createElement('section');
    const machines = [
      { ref: 'physical-sandbox/so101:1', label: 'SO-101', source: 'catalog', kind: 'machine' },
      { ref: 'ada/arm:2', label: 'ada/arm:2', source: 'cache', kind: 'machine' },
      { ref: 'myarm', label: 'myarm', source: 'local', kind: 'machine' },
    ];
    const api = { get: async () => ({ machines }), post: async () => ({}), upload: async () => ({}), url: (p: string) => p } as any;
    const place = mountPlaceUi({ robotsRoot: robots, placedRoot: doc.createElement('section'), api, dropTarget: doc.createElement('div'), floorPointAt: () => null, say() {} });
    await place.refresh();
    return [...robots.querySelectorAll('.ps-machine .ps-source')].map((e) => e.textContent).join('\n');
  } finally {
    setLang(null);
    forgetLangListeners();
    dom.window.close();
    for (const [name, was] of Object.entries(keep)) { if (was === undefined) delete (globalThis as any)[name]; else (globalThis as any)[name] = was; }
  }
}

test('each robot row says where it comes from in words of the chosen language, never a raw code', async () => {
  const ja = await robotsText('ja');
  const en = await robotsText('en');
  assert.equal(ja, [`physical-sandbox/so101:1 · ${WORDS.sourceCatalog.ja}`, WORDS.sourceCache.ja, WORDS.sourceLocal.ja].join('\n'));
  assert.equal(en, [`physical-sandbox/so101:1 · ${WORDS.sourceCatalog.en}`, WORDS.sourceCache.en, WORDS.sourceLocal.en].join('\n'));
  assert.doesNotMatch(ja, /catalog|cache|local/);
  assert.doesNotMatch(en, japanese);
});

test('what is playing names the agent, a record sent from a file or MQTT in words; a PS.com ref or a file as it is', () => {
  const line = (source: string) => playingLine({ playing: { source, t: 0, duration: 2 } })!;
  try {
    setLang('ja');
    assert.equal(line('agent'), `再生中: ${WORDS.sourceAgent.ja}（2 秒）`);
    assert.equal(line('record'), `再生中: ${WORDS.sourceRecord.ja}（2 秒）`);
    assert.equal(line('mqtt'), `再生中: ${WORDS.sourceMqtt.ja}（2 秒）`);
    assert.equal(line('ada/walk:2'), '再生中: ada/walk:2（2 秒）');
    setLang('en');
    for (const source of ['agent', 'record', 'mqtt']) assert.doesNotMatch(line(source), new RegExp(`Playing ${source} `));
    assert.equal(line('agent'), `Playing ${WORDS.sourceAgent.en} (2 s)`);
    assert.equal(line('walk.record.json'), 'Playing walk.record.json (2 s)');
  } finally { setLang(null); }
});

test('the labels kept for a language change let go of the ones no longer held', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const keep = { document: (globalThis as any).document, WeakRef: globalThis.WeakRef };
  // every reference is let go at once: what the garbage collector does to labels drawn over
  class Gone<T extends object> { constructor(_: T) {} deref(): T | undefined { return undefined; } }
  Object.assign(globalThis, { document: dom.window.document, WeakRef: Gone });
  try {
    for (let i = 0; i < 1000; i += 1) labelOf('decide');
    assert.ok(trackedSize() <= 200, `${trackedSize()} kept`);
  } finally {
    Object.assign(globalThis, { WeakRef: keep.WeakRef });
    if (keep.document === undefined) delete (globalThis as any).document; else (globalThis as any).document = keep.document;
    dom.window.close();
  }
});
