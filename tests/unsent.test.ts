// Records PS.com did not get yet, kept and sent later: tests for src/core/unsent.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Moved, Offline, PsComClient, Refused, SignIn, Taken, tokenFileIn } from '../src/core/pscom-client.js';
import { keep, MOVED, OFFLINE, pending, refusalWords, removeCopy, save, sendAll, SERVER_DOWN, SIGN_IN, unsentDirIn, type Sender } from '../src/core/unsent.js';
import { FakePsCom } from './helpers/fake-pscom.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ps-unsent-'));
const record = (name = 'r', product = 'physical-sandbox/so101:1') => ({
  schemaVersion: 3, name,
  equipment: { site: { id: 'local' }, devices: [{ id: 'arm', product, owner: 'viewer', parent: 'site', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }] },
  traces: {},
});

async function signedIn(userDir: string, isLocalMachine?: (name: string) => boolean) {
  const fake = await new FakePsCom().start();
  const client = new PsComClient({ base: fake.base, tokenFile: tokenFileIn(userDir), pollMs: 0, isLocalMachine });
  await client.loginStart();
  assert.equal(await client.loginPoll(), 'approved');
  return { fake, client, sender: client.saveRecord.bind(client) as Sender };
}

test('the unsent folder sits in <userDir>/physical-sandbox/unsent', () => {
  assert.equal(unsentDirIn('/u'), join('/u', 'physical-sandbox', 'unsent'));
});

test('keep writes the record and where it goes; a second copy of a name gets -2', () => {
  const dir = join(tmp(), 'unsent');
  assert.equal(keep(dir, record('a'), { ref: 'walk', mode: 'new', base: null }), 'walk');
  assert.equal(keep(dir, record('b'), { ref: 'ada/walk', mode: 'new', base: null }), 'walk-2');
  assert.deepEqual(pending(dir), [
    { name: 'walk', ref: 'walk', mode: 'new', base: null },
    { name: 'walk-2', ref: 'ada/walk', mode: 'new', base: null },
  ]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'walk-2.record.json'), 'utf8')).name, 'b');
});

test('a second save over the same record replaces the waiting copy and keeps its first base', () => {
  const dir = tmp();
  assert.equal(keep(dir, record('first'), { ref: 'ada/walk', mode: 'over', base: '3' }), 'walk');
  assert.equal(keep(dir, record('second'), { ref: 'ada/walk', mode: 'over', base: '4' }), 'walk');
  assert.deepEqual(pending(dir), [{ name: 'walk', ref: 'ada/walk', mode: 'over', base: '3' }]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'walk.record.json'), 'utf8')).name, 'second');
});

test('pending leaves out a copy without its send file or with a bad one', () => {
  const dir = tmp();
  keep(dir, record(), { ref: 'walk', mode: 'new', base: null });
  keep(dir, record(), { ref: 'run', mode: 'new', base: null });
  rmSync(join(dir, 'run.send.json'));
  writeFileSync(join(dir, 'odd.record.json'), '{}');
  writeFileSync(join(dir, 'odd.send.json'), '{"ref": 1}');
  assert.deepEqual(pending(dir).map((p) => p.name), ['walk']);
  assert.deepEqual(pending(join(dir, 'none')), []);
});

test('sendAll sends every copy and removes what went', async () => {
  const userDir = tmp();
  const { fake, sender } = await signedIn(userDir);
  try {
    const dir = unsentDirIn(userDir);
    fake.seed('ada', 'walk', '1', record('one'));
    keep(dir, record('two'), { ref: 'ada/walk', mode: 'over', base: '1' });
    keep(dir, record('run'), { ref: 'run', mode: 'new', base: null }); // kept signed out: no handle
    const out = await sendAll(dir, sender);
    assert.deepEqual(out, {
      sent: [
        { name: 'run', ref: 'ada/run', version: '1', mode: 'new' },
        { name: 'walk', ref: 'ada/walk', version: '2', mode: 'over' },
      ],
      left: [], notes: [],
    });
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(fake.record('ada', 'walk', '2').name, 'two');
  } finally { await fake.stop(); }
});

test('a save over a record that moved goes as a new record under the first free -2, with basedOn and a note', async () => {
  const userDir = tmp();
  const { fake, sender } = await signedIn(userDir);
  try {
    const dir = unsentDirIn(userDir);
    fake.seed('ada', 'walk', '1', record('one'));
    fake.seed('ada', 'walk', '2', record('elsewhere'));
    fake.seed('ada', 'walk-2', '1', record('taken already'));
    keep(dir, record('mine'), { ref: 'ada/walk', mode: 'over', base: '1' });
    const out = await sendAll(dir, sender);
    assert.deepEqual(out.sent, [{ name: 'walk', ref: 'ada/walk-3', version: '1', mode: 'new' }]);
    assert.deepEqual(out.notes, ['ada/walk は別の場所で変わっていたため、ada/walk-3 として新しく保存しました']);
    assert.equal(MOVED, '{ref} は別の場所で変わっていたため、{new} として新しく保存しました');
    const saved = fake.record('ada', 'walk-3', '1');
    assert.equal(saved.name, 'mine');
    assert.equal(saved.basedOn, 'ada/walk:1');
    assert.equal(fake.record('ada', 'walk', '3'), undefined);
  } finally { await fake.stop(); }
});

test('a kept new record whose name was taken meanwhile goes under -2 with a note; the name stays within 39 characters', async () => {
  const userDir = tmp();
  const { fake, sender } = await signedIn(userDir);
  try {
    const dir = unsentDirIn(userDir);
    const long = 'a'.repeat(38) + 'b'; // 39 characters
    fake.seed('ada', 'walk', '1', record());
    fake.seed('ada', long, '1', record());
    keep(dir, record('w'), { ref: 'walk', mode: 'new', base: null });
    keep(dir, record('l'), { ref: `ada/${long}`, mode: 'new', base: null });
    const out = await sendAll(dir, sender);
    const shortened = 'a'.repeat(37) + '-2';
    assert.deepEqual(out.sent.map((s) => s.ref).sort(), [`ada/${shortened}`, 'ada/walk-2'].sort());
    assert.ok(out.notes.includes('ada/walk はもうあったため、ada/walk-2 として保存しました'));
    assert.ok(out.notes.includes(`ada/${long} はもうあったため、ada/${shortened} として保存しました`));
    assert.equal(shortened.length, 39);
  } finally { await fake.stop(); }
});

test('offline, a server error or signed out: every copy stays and the round stops', async () => {
  const dir = tmp();
  keep(dir, record('a'), { ref: 'a1', mode: 'new', base: null });
  keep(dir, record('b'), { ref: 'b1', mode: 'new', base: null });
  for (const [error, note] of [
    [new Offline('down'), OFFLINE],
    [new Refused('busy', 503), SERVER_DOWN],
    [new SignIn(), SIGN_IN],
  ] as const) {
    let calls = 0;
    const out = await sendAll(dir, async () => { calls += 1; throw error; });
    assert.equal(calls, 1);
    assert.deepEqual(out.sent, []);
    assert.deepEqual(out.left.map((p) => p.name), ['a1', 'b1']);
    assert.deepEqual(out.notes, [note]);
  }
  assert.equal(pending(dir).length, 2);
  assert.equal(OFFLINE, 'PS.com に接続できませんでした。接続できるようになったら「再送信する」を押してください');
  assert.equal(SERVER_DOWN, 'PS.com が応答できませんでした。しばらくしてから「再送信する」を押してください');
});

test('another refusal keeps that copy with a sentence and the round goes on', async () => {
  const dir = tmp();
  keep(dir, record('a'), { ref: 'a1', mode: 'new', base: null });
  keep(dir, record('b'), { ref: 'b1', mode: 'new', base: null });
  keep(dir, record('c', 'so101'), { ref: 'c1', mode: 'new', base: null });
  const sender: Sender = async (ref, rec) => {
    if (ref === 'a1') throw new Refused('limit', 429);
    if ((rec as any).equipment.devices[0].product === 'so101') {
      throw new Refused('local-machine', 0, '手元のロボット so101 は PS.com にありません。psbx push でロボットを上げてから保存してください');
    }
    return { ref: `ada/${ref}`, version: '1', unchanged: false };
  };
  const out = await sendAll(dir, sender);
  assert.deepEqual(out.sent, [{ name: 'b1', ref: 'ada/b1', version: '1', mode: 'new' }]);
  assert.deepEqual(out.left.map((p) => p.name), ['a1', 'c1']);
  assert.deepEqual(out.notes, [
    'a1 を送れませんでした（記録の数が上限に達しています）',
    'c1 を送れませんでした（手元のロボット so101 は PS.com にありません。psbx push でロボットを上げてから保存してください）',
  ]);
});

test('save offline keeps a copy that survives a restart and goes once PS.com answers again', async () => {
  const userDir = tmp();
  const { fake, client } = await signedIn(userDir);
  const port = fake.port;
  await fake.stop();
  const dir = unsentDirIn(userDir);
  const out = await save(dir, client.saveRecord.bind(client), record('offline'), { ref: 'walk', mode: 'new', base: null });
  assert.deepEqual(out, { saved: false, unsent: 'walk', reason: OFFLINE });
  // Node-RED restarts: a new client on the same user directory finds the copy
  await fake.start(port);
  try {
    const again = new PsComClient({ base: fake.base, tokenFile: tokenFileIn(userDir) });
    assert.deepEqual(pending(dir).map((p) => p.name), ['walk']);
    const sent = await sendAll(dir, again.saveRecord.bind(again));
    assert.deepEqual(sent.sent, [{ name: 'walk', ref: 'ada/walk', version: '1', mode: 'new' }]);
    assert.equal(fake.record('ada', 'walk', '1').name, 'offline');
    assert.deepEqual(pending(dir), []);
  } finally { await fake.stop(); }
});

test('save signed out keeps a copy under the bare name, sent under the handle after signing in', async () => {
  const userDir = tmp();
  const fake = await new FakePsCom().start();
  try {
    const client = new PsComClient({ base: fake.base, tokenFile: tokenFileIn(userDir), pollMs: 0 });
    const dir = unsentDirIn(userDir);
    const out = await save(dir, client.saveRecord.bind(client), record(), { ref: 'walk', mode: 'new', base: null });
    assert.deepEqual(out, { saved: false, unsent: 'walk', reason: SIGN_IN });
    assert.equal(SIGN_IN, 'PS.com にログインすると送れます');
    await client.loginStart();
    await client.loginPoll();
    const sent = await sendAll(dir, client.saveRecord.bind(client));
    assert.deepEqual(sent.sent.map((s) => s.ref), ['ada/walk']);
  } finally { await fake.stop(); }
});

test('save on a server error keeps a copy; another refusal is thrown and keeps nothing', async () => {
  const userDir = tmp();
  const { fake, client } = await signedIn(userDir);
  try {
    const dir = unsentDirIn(userDir);
    const sender = client.saveRecord.bind(client);
    fake.failRecord = [500, { error: 'oops' }];
    assert.deepEqual(await save(dir, sender, record(), { ref: 'walk', mode: 'new', base: null }),
      { saved: false, unsent: 'walk', reason: SERVER_DOWN });
    fake.failRecord = [429, { error: 'limit' }];
    const err = await save(dir, sender, record(), { ref: 'run', mode: 'new', base: null }).catch((e) => e);
    assert.ok(err instanceof Refused);
    assert.equal(err.code, 'limit');
    assert.equal(err.status, 429);
    assert.equal(err.message, 'PS.com に保存できませんでした（記録の数が上限に達しています）');
    assert.deepEqual(pending(dir).map((p) => p.name), ['walk']);
  } finally { await fake.stop(); }
});

test('refusals in words: known errors, a refusal with its own sentence, anything else', () => {
  assert.equal(refusalWords(new Refused('limit', 413)), '保存できる容量の上限に達しています');
  assert.equal(refusalWords(new Refused('not-mine', 0, 'bob/walk は ada の記録ではないため保存できません')), 'bob/walk は ada の記録ではないため保存できません');
  assert.equal(refusalWords(new Refused('weird', 400)), 'PS.com が保存を受け付けませんでした（weird）');
  assert.equal(refusalWords(new Refused('HTTP 413', 413)), 'PS.com が保存を受け付けませんでした（HTTP 413）');
});

test('a copy kept for another handle is not sent: it stays listed with a sentence', async () => {
  const userDir = tmp();
  const { fake, sender } = await signedIn(userDir);
  try {
    const dir = unsentDirIn(userDir);
    keep(dir, record('theirs'), { ref: 'bob/walk', mode: 'new', base: null });
    const before = fake.calls.length;
    for (let round = 0; round < 2; round += 1) {
      const out = await sendAll(dir, sender);
      assert.deepEqual(out.sent, []);
      assert.deepEqual(out.left.map((p) => p.ref), ['bob/walk']);
      assert.deepEqual(out.notes, ['walk を送れませんでした（bob/walk は ada の記録ではないため保存できません）']);
    }
    assert.equal(fake.calls.length, before);
    assert.deepEqual(pending(dir).map((p) => p.ref), ['bob/walk']);
  } finally { await fake.stop(); }
});

test('save with a bad name is thrown and keeps nothing, even for a record naming a local robot', async () => {
  const userDir = tmp();
  const { fake, client } = await signedIn(userDir, () => true);
  try {
    const dir = unsentDirIn(userDir);
    const err = await save(dir, client.saveRecord.bind(client), record('r', 'myarm'), { ref: 'Bad Name', mode: 'new', base: null }).catch((e) => e);
    assert.ok(err instanceof Refused);
    assert.equal(err.code, 'bad-name');
    assert.deepEqual(pending(dir), []);
  } finally { await fake.stop(); }
});

test('save of a record naming a robot only this machine has answers local-machine and keeps a copy', async () => {
  const userDir = tmp();
  const { fake, client } = await signedIn(userDir, (name) => name === 'myarm');
  try {
    const dir = unsentDirIn(userDir);
    const before = fake.calls.length;
    const out = await save(dir, client.saveRecord.bind(client), record('r', 'myarm'), { ref: 'walk', mode: 'new', base: null });
    assert.deepEqual(out, {
      saved: false, unsent: 'walk', code: 'local-machine',
      reason: '手元のロボット myarm は PS.com にありません。psbx push でロボットを上げてから保存してください',
    });
    assert.equal(fake.calls.length, before);
    assert.deepEqual(pending(dir).map((p) => p.name), ['walk']);
    // a bare id that is not a local robot (PS.com's own so101) is saved as it is
    const saved = await save(dir, client.saveRecord.bind(client), record('s', 'so101'), { ref: 'ada/run', mode: 'new', base: null });
    assert.equal(saved.saved, true);
    assert.equal(fake.record('ada', 'run', '1').equipment.devices[0].product, 'so101');
  } finally { await fake.stop(); }
});

test('save as new over a taken name is refused in words and keeps nothing', async () => {
  const userDir = tmp();
  const { fake, client } = await signedIn(userDir);
  try {
    fake.seed('ada', 'walk', '1', record());
    const dir = unsentDirIn(userDir);
    const err = await save(dir, client.saveRecord.bind(client), record('x'), { ref: 'ada/walk', mode: 'new', base: null }).catch((e) => e);
    assert.ok(err instanceof Taken);
    assert.equal(err.message, 'ada/walk はもうあります。別の名前を指定してください');
    assert.deepEqual(pending(dir), []);
  } finally { await fake.stop(); }
});

test('a save over that moved is saved as new with a note', async () => {
  const userDir = tmp();
  const { fake, client } = await signedIn(userDir);
  try {
    fake.seed('ada', 'walk', '1', record());
    fake.seed('ada', 'walk', '2', record('elsewhere'));
    const out = await save(unsentDirIn(userDir), client.saveRecord.bind(client), record('mine'), { ref: 'ada/walk', mode: 'over', base: '1' });
    assert.deepEqual(out, {
      saved: true, ref: 'ada/walk-2', version: '1', mode: 'new', unchanged: false,
      note: 'ada/walk は別の場所で変わっていたため、ada/walk-2 として新しく保存しました',
    });
  } finally { await fake.stop(); }
});

test('a save that reaches PS.com drops the waiting saves over the same record and sends the other copies', async () => {
  const userDir = tmp();
  const { fake, client } = await signedIn(userDir);
  try {
    const dir = unsentDirIn(userDir);
    const sender = client.saveRecord.bind(client);
    fake.seed('ada', 'walk', '1', record('one'));
    keep(dir, record('old over'), { ref: 'ada/walk', mode: 'over', base: '1' });
    keep(dir, record('other'), { ref: 'run', mode: 'new', base: null });
    const out = await save(dir, sender, record('newer'), { ref: 'ada/walk', mode: 'over', base: '1' });
    assert.deepEqual(out, {
      saved: true, ref: 'ada/walk', version: '2', mode: 'over', unchanged: false,
      unsentSend: { sent: [{ name: 'run', ref: 'ada/run', version: '1', mode: 'new' }], left: [], notes: [] },
    });
    assert.equal(fake.record('ada', 'walk', '2').name, 'newer');
    assert.equal(fake.record('ada', 'walk', '3'), undefined);
    assert.ok(!existsSync(join(dir, 'walk.record.json')));
  } finally { await fake.stop(); }
});

test('Moved carries the latest version', () => {
  assert.equal(new Moved('4').latest, '4');
});

test('removeCopy takes away that copy\'s two files only; a name that is not a copy is not touched', () => {
  const dir = join(tmp(), 'unsent');
  keep(dir, record('a'), { ref: 'walk', mode: 'new', base: null });
  keep(dir, record('b'), { ref: 'walk', mode: 'new', base: null });
  writeFileSync(join(dir, 'walk.notes.txt'), 'mine');
  assert.equal(removeCopy(dir, 'walk'), true);
  assert.deepEqual(readdirSync(dir).sort(), ['walk-2.record.json', 'walk-2.send.json', 'walk.notes.txt']);
  for (const name of ['walk', '../unsent/walk-2', 'walk-2.record.json', '', 'nothing']) assert.equal(removeCopy(dir, name), false, name);
  assert.deepEqual(pending(dir).map((p) => p.name), ['walk-2']);
  assert.equal(removeCopy(join(tmp(), 'none'), 'walk'), false);
});

test('saving the same content as new again does not stack copies; other content still gets -2', () => {
  const dir = join(tmp(), 'unsent');
  assert.equal(keep(dir, record('a'), { ref: 'walk', mode: 'new', base: null }), 'walk');
  assert.equal(keep(dir, record('a'), { ref: 'walk', mode: 'new', base: null }), 'walk');
  assert.equal(keep(dir, record('b'), { ref: 'walk', mode: 'new', base: null }), 'walk-2');
  assert.equal(keep(dir, record('b'), { ref: 'walk', mode: 'new', base: null }), 'walk-2');
  assert.deepEqual(pending(dir).map((p) => p.name), ['walk', 'walk-2']);
});

test('a record naming a robot only this machine has, saved again and again, stays one copy', async () => {
  const userDir = tmp();
  const { fake, client } = await signedIn(userDir, (name) => name === 'myarm');
  try {
    const dir = unsentDirIn(userDir);
    for (let i = 0; i < 3; i += 1) {
      const out = await save(dir, client.saveRecord.bind(client), record('r', 'myarm'), { ref: 'walk', mode: 'new', base: null });
      assert.deepEqual([out.saved, (out as any).unsent], [false, 'walk']);
    }
    assert.deepEqual(pending(dir).map((p) => p.name), ['walk']);
  } finally { await fake.stop(); }
});
