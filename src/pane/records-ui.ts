/**
 * Records and PS.com: opening a record and playing it (`POST stream/play`, from PS.com by
 * `handle/name` or from a file), stopping it, going back to its start; what the stream holds
 * (「流れている動きを記録中（n 件）」, 「記録を空にする」); the two saves, the export, the copies kept
 * while PS.com could not be reached (red, with 「再送信する」); signing in with a 6-digit code; and
 * the switch that lets the agent have the stage's frames.
 *
 * Everything the pane shows here comes from the hub's retained status, so every pane shows the same.
 */
import type { Api } from './comms-client.js';
import { PaneError } from './comms-client.js';
import { buttonOf, en, ja, labelOf } from './words.js';

type Json = Record<string, any>;

/** The hub's status (src/plugin/hub.ts Status), as the pane reads it. */
export interface PaneStatus {
  login?: { signedIn: boolean; handle: string | null };
  unsent?: { name: string; ref: string; mode: string }[];
  playing?: { source: string; t: number; duration: number } | null;
  agentFrames?: boolean;
  recorded?: number;
  opened?: { ref: string; version: string; own: boolean } | { file: string } | null;
}

/** A catalog name (src/core/pscom-client.ts NAME). */
export const NAME = /^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$/;

/** Which saves are offered: 上書き保存 only over the signed-in person's own opened PS.com record. */
export function saveButtons(status: PaneStatus | null): { over: boolean; asNew: boolean } {
  const opened = status?.opened;
  return { over: Boolean(opened && 'ref' in opened && opened.own === true && status?.login?.signedIn), asNew: true };
}

export const recordingLine = (status: PaneStatus | null): string => ja('recording', { n: Number(status?.recorded ?? 0) });

export function openedLine(status: PaneStatus | null): string {
  const opened = status?.opened;
  if (!opened) return ja('openedNone');
  return 'ref' in opened ? ja('openedRef', { ref: opened.ref, version: opened.version }) : ja('openedFile', { file: opened.file });
}

export function playingLine(status: PaneStatus | null): string | null {
  const playing = status?.playing;
  return playing ? ja('playing', { source: playing.source, d: Math.round(playing.duration * 10) / 10 }) : null;
}

export const unsentLines = (status: PaneStatus | null): { name: string; text: string }[] =>
  (status?.unsent ?? []).map((u) => ({ name: u.name, text: ja('unsent', { name: u.name }) }));

/** What 再生 and 頭へ send again: the record opened last from this pane, else the hub's opened PS.com record. */
export function playAgainBody(last: Json | null, status: PaneStatus | null): Json | null {
  if (last) return last;
  const opened = status?.opened;
  return opened && 'ref' in opened ? { ref: `${opened.ref}:${opened.version}` } : null;
}

export interface RecordsUi { setStatus(status: PaneStatus): void }

export function mountRecordsUi(opts: {
  playRoot: HTMLElement;
  saveRoot: HTMLElement;
  accountRoot: HTMLElement;
  api: Api;
  say: (text: string, title?: string) => void;
}): RecordsUi {
  const { api, say } = opts;
  let status: PaneStatus | null = null;
  /** What opened the record last from this pane (a file's record stays here to play again). */
  let lastOpened: Json | null = null;

  const fail = (e: unknown) => say(e instanceof PaneError ? e.message : ja('failed'));
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
    const made = document.createElement(tag);
    if (className) made.className = className;
    return made;
  };

  // ---- playback ----

  const openHeading = labelOf('openRecord', 'h3');
  const refRow = el('div', 'ps-row');
  const refInput = el('input');
  refInput.type = 'text';
  refInput.placeholder = ja('refPlaceholder');
  refInput.title = en('refPlaceholder');
  refInput.name = 'ref';
  const openRefButton = buttonOf('openRef');
  refRow.append(refInput, openRefButton);
  const fileRow = el('div', 'ps-row');
  const fileLabel = labelOf('openFile', 'label');
  fileLabel.className = 'ps-button ps-file';
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.name = 'record-file';
  fileLabel.append(fileInput);
  fileRow.append(fileLabel);
  const openedText = el('p', 'ps-line');
  const playingText = el('p', 'ps-line');
  const playRow = el('div', 'ps-row');
  const playButton = buttonOf('play');
  const stopButton = buttonOf('stop');
  const startButton = buttonOf('toStart');
  playRow.append(playButton, stopButton, startButton);
  opts.playRoot.append(openHeading, refRow, fileRow, openedText, playRow, playingText);

  async function play(body: Json, thenStop = false): Promise<void> {
    try {
      await api.post('stream/play', body, { asText: 'record' in body });
      // 頭へ: the first samples go out as the play starts; stopping there leaves each device at its start
      if (thenStop) await api.post('stream/stop');
    } catch (e) {
      fail(e);
    }
  }

  openRefButton.addEventListener('click', () => {
    const ref = refInput.value.trim();
    if (!ref) return;
    lastOpened = { ref };
    void play(lastOpened);
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    let record: unknown;
    try { record = JSON.parse(await file.text()); } catch { record = null; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) { say(ja('badFile'), en('badFile')); return; }
    lastOpened = { record, file: file.name };
    void play(lastOpened);
  });
  playButton.addEventListener('click', () => {
    const body = playAgainBody(lastOpened, status);
    if (body) void play(body);
  });
  stopButton.addEventListener('click', () => { api.post('stream/stop').catch(fail); });
  startButton.addEventListener('click', () => {
    const body = playAgainBody(lastOpened, status);
    if (body) void play(body, true);
  });

  // ---- the stream and saving ----

  const recordingRow = el('div', 'ps-row');
  const recordingText = el('span', 'ps-line');
  const clearButton = buttonOf('clearRecording');
  recordingRow.append(recordingText, clearButton);
  const saveRow = el('div', 'ps-row');
  const overButton = buttonOf('saveOver', 'ps-button ps-primary');
  const newButton = buttonOf('saveNew');
  const exportButton = buttonOf('exportRecord');
  saveRow.append(overButton, newButton, exportButton);

  const newForm = el('form', 'ps-form');
  newForm.hidden = true;
  const nameField = labelOf('nameLabel', 'label');
  nameField.className = 'ps-field';
  const nameInput = el('input');
  nameInput.name = 'name';
  nameInput.type = 'text';
  nameInput.autocomplete = 'off';
  nameField.append(nameInput);
  const titleField = labelOf('titleLabel', 'label');
  titleField.className = 'ps-field';
  const titleInput = el('input');
  titleInput.name = 'title';
  titleInput.type = 'text';
  titleField.append(titleInput);
  const formRow = el('div', 'ps-row');
  const saveNewButton = buttonOf('save', 'ps-button ps-primary');
  saveNewButton.type = 'submit';
  const cancelNewButton = buttonOf('cancel');
  formRow.append(saveNewButton, cancelNewButton);
  newForm.append(nameField, titleField, formRow);

  const unsentList = el('ul', 'ps-list ps-unsent');
  opts.saveRoot.append(recordingRow, saveRow, newForm, unsentList);

  clearButton.addEventListener('click', () => { api.post('stream/clear').catch(fail); });

  function tellSaved(answer: Json): void {
    if (answer.saved === false) { say(ja('savedKept', { reason: answer.reason ?? '' })); return; }
    say(ja(answer.unchanged ? 'savedUnchanged' : 'saved', { ref: answer.ref, version: answer.version }));
  }

  async function save(body: Json): Promise<boolean> {
    say(ja('saving'));
    try {
      tellSaved(await api.post('record/save', body));
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  overButton.addEventListener('click', () => { void save({ mode: 'over' }); });
  newButton.addEventListener('click', () => {
    newForm.hidden = false;
    nameInput.focus();
  });
  cancelNewButton.addEventListener('click', () => { newForm.hidden = true; });
  newForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!NAME.test(name)) { say(ja('badName'), en('badName')); return; }
    const title = titleInput.value.trim();
    if (await save({ mode: 'new', name, ...(title ? { title } : {}) })) {
      newForm.hidden = true;
      nameInput.value = '';
      titleInput.value = '';
    }
  });
  exportButton.addEventListener('click', async () => {
    try {
      const answer = await api.post('record/export', {});
      say(ja('exported', { file: answer.file ?? answer.name }));
    } catch (e) {
      fail(e);
    }
  });

  // ---- PS.com and the agent ----

  const loginButton = buttonOf('login');
  const loginText = el('p', 'ps-line');
  const agentLabel = labelOf('agentFrames', 'label');
  agentLabel.className = 'ps-switch';
  const agentBox = el('input');
  agentBox.type = 'checkbox';
  agentBox.name = 'agent-frames';
  agentLabel.prepend(agentBox, ' ');
  opts.accountRoot.append(loginButton, loginText, agentLabel);

  let polling = false;
  loginButton.addEventListener('click', async () => {
    let started: Json;
    try {
      started = await api.post('login/start');
    } catch (e) {
      fail(e);
      return;
    }
    loginText.textContent = ja('loginCode', { url: started.url, code: started.userCode });
    loginText.title = en('loginCode', { url: started.url, code: started.userCode });
    loginText.dataset.code = String(started.userCode);
    delete loginText.dataset.signedIn;
    if (polling) return;
    polling = true;
    try {
      for (;;) {
        await new Promise((done) => setTimeout(done, 3000));
        const answer = await api.get('login/poll');
        if (answer.status === 'approved') { loginText.textContent = ''; break; }
        if (answer.status === 'expired') { loginText.textContent = ja('loginExpired'); break; }
      }
    } catch (e) {
      fail(e);
    } finally {
      polling = false;
    }
  });
  agentBox.addEventListener('change', async () => {
    const on = agentBox.checked;
    agentBox.checked = status?.agentFrames === true; // the hub's answer decides what is shown
    try {
      const answer = await api.post('pane/agent-frames', { on });
      agentBox.checked = answer.agentFrames === true;
    } catch (e) {
      fail(e);
    }
  });

  function setStatus(next: PaneStatus): void {
    status = next;
    openedText.textContent = openedLine(status);
    const playing = playingLine(status);
    playingText.textContent = playing ?? '';
    playingText.hidden = !playing;
    const canPlay = playAgainBody(lastOpened, status) !== null;
    playButton.disabled = !canPlay;
    startButton.disabled = !canPlay;
    stopButton.disabled = !status.playing;
    recordingText.textContent = recordingLine(status);
    clearButton.disabled = !status.recorded;

    const offered = saveButtons(status);
    overButton.hidden = !offered.over;
    newButton.hidden = !offered.asNew;

    unsentList.replaceChildren();
    for (const line of unsentLines(status)) {
      const item = el('li', 'ps-error');
      item.dataset.unsent = line.name;
      item.append(line.text, ' ');
      const resend = buttonOf('resend', 'ps-button ps-small');
      resend.addEventListener('click', async () => {
        try {
          const answer = await api.post('unsent/send');
          say(ja('resent', { n: Array.isArray(answer.sent) ? answer.sent.length : 0 }));
        } catch (e) {
          fail(e);
        }
      });
      item.append(resend);
      unsentList.append(item);
    }

    const login = status.login;
    loginButton.hidden = Boolean(login?.signedIn);
    if (login?.signedIn) {
      loginText.textContent = ja('signedIn', { handle: login.handle ?? '' });
      loginText.title = en('signedIn', { handle: login.handle ?? '' });
      loginText.dataset.signedIn = '1';
      if (!refInput.value && login.handle) refInput.value = `${login.handle}/`;
    } else if (loginText.dataset.signedIn) {
      // Signed out meanwhile (a token PS.com refused); a code line under way stays
      loginText.textContent = '';
      loginText.title = '';
      delete loginText.dataset.signedIn;
    }
    agentBox.checked = status.agentFrames === true;
  }

  return { setStatus };
}
