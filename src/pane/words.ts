/**
 * What the pane says, in Japanese (案内文調, as PS.com's screens) and in English. The pane shows one
 * of them, the language of Node-RED's editor (see lang below). Interpolation is named: {n}.
 */
export const WORDS = {
  // the background
  background: { ja: '背景', en: 'Background' },
  chooseBackground: { ja: '背景を選択', en: 'Choose a background' },
  backgroundHint: { ja: '映像（画像か動画）を選択してください。このパソコンの中だけに置かれ、PS.com には送られません', en: 'Choose a still or a video. It stays on this computer and is never sent to PS.com' },
  backgroundSent: { ja: '背景を {name} にしました', en: 'The background is now {name}' },
  backgroundLost: { ja: '背景の映像を取得できませんでした', en: 'The background could not be fetched' },

  // the floor
  decideFloor: { ja: '床を決定', en: 'Decide the floor' },
  cornerNext: { ja: '映像の上で床の角 {n} をクリックしてください（1→2→3→4 の順に時計回り）', en: 'Click floor corner {n} on the picture (1→2→3→4, clockwise)' },
  lengthsHint: { ja: '角 1→2 と角 2→3 の長さ（m）を入力して「決定」を押してください', en: 'Enter the lengths of edges 1→2 and 2→3 (m), then press Decide' },
  edge12: { ja: '角 1→2（m）', en: 'Edge 1→2 (m)' },
  edge23: { ja: '角 2→3（m）', en: 'Edge 2→3 (m)' },
  decide: { ja: '決定', en: 'Decide' },
  startOver: { ja: '最初から指定する', en: 'Start over' },
  cancel: { ja: 'やめる', en: 'Cancel' },
  deciding: { ja: '床を求めています…', en: 'Solving the floor…' },
  floorDecided: { ja: '床を決定しました（{a} × {b} m）', en: 'The floor is decided ({a} × {b} m)' },
  needPicture: { ja: '先に背景を選択してください', en: 'Choose a background first' },
  badLength: { ja: '長さは 0 より大きい数（m）で入力してください', en: 'Enter each length as a number above 0 (m)' },

  // robots
  robots: { ja: 'ロボット', en: 'Robots' },
  robotsHint: { ja: 'ロボットを映像の床へドラッグすると、そこに置きます', en: 'Drag a robot onto the floor to place it there' },
  robotsOffline: { ja: 'PS.com に接続できないため、このパソコンにあるロボットだけを表示しています', en: 'PS.com cannot be reached: only the robots on this computer are listed' },
  robotsNone: { ja: '置けるロボットがありません', en: 'No robots to place' },
  offFloor: { ja: '床の上に置いてください', en: 'Drop it on the floor' },
  placed: { ja: '置いたロボット', en: 'Placed' },
  placedNone: { ja: 'まだ何も置いていません', en: 'Nothing placed yet' },
  remove: { ja: '取り除く', en: 'Remove' },
  notDrawn: { ja: '{product} を読み込めませんでした', en: '{product} could not be loaded' },

  // playback
  playback: { ja: '再生', en: 'Playback' },
  openRecord: { ja: '記録を開く', en: 'Open a record' },
  refPlaceholder: { ja: 'handle/name（PS.com の記録）', en: 'handle/name (a PS.com record)' },
  openRef: { ja: 'PS.com から開く', en: 'Open from PS.com' },
  myRecords: { ja: 'PS.com の自分の記録', en: 'My records on PS.com' },
  myRecordsNone: { ja: 'PS.com に保存した記録はまだありません', en: 'No records on PS.com yet' },
  myRecordsSignedOut: { ja: 'ログインすると、PS.com の自分の記録が一覧に表示されます', en: 'Sign in to list your records on PS.com' },
  myRecordsOffline: { ja: 'PS.com に接続できないため、記録の一覧を取得できませんでした', en: 'PS.com cannot be reached: the list could not be fetched' },
  myRecordRow: { ja: '{ref}（バージョン {version}）', en: '{ref} (version {version})' },
  refreshList: { ja: '一覧を更新', en: 'Refresh' },
  openFile: { ja: 'ファイルから開く', en: 'Open a file' },
  badFile: { ja: '記録のファイル（JSON）を読み込めませんでした', en: 'The record file (JSON) could not be read' },
  play: { ja: '再生', en: 'Play' },
  stop: { ja: '停止', en: 'Stop' },
  toStart: { ja: '頭へ', en: 'To the start' },
  playing: { ja: '再生中: {source}（{d} 秒）', en: 'Playing {source} ({d} s)' },
  openedRef: { ja: '開いている記録: {ref}（バージョン {version}）', en: 'Open: {ref} (version {version})' },
  openedFile: { ja: '開いている記録: {file}', en: 'Open: {file}' },
  openedNone: { ja: '記録は開いていません', en: 'No record is open' },
  site: { ja: '現地: {site}', en: 'Site: {site}' },
  siteHint: { ja: 'この現地（ps/{site}/…）のメッセージだけを表示し、記録します', en: 'Only messages of this site (ps/{site}/…) are shown and recorded' },
  siteReset: { ja: '現地をもとに戻す', en: 'Back to the plugin\'s site' },
  siteResetTitle: { ja: 'プラグインの設定の現地（{site}）に戻します。流れている動きの記録は空になります', en: 'Back to the site of the plugin\'s settings ({site}). The recording is cleared' },
  siteChanged: { ja: '現地を {site} にしました', en: 'The site is now {site}' },

  // the stream and saving
  records: { ja: '記録', en: 'Record' },
  recording: { ja: '流れている動きを記録中（{n} 件）', en: 'Recording the stream ({n})' },
  clearRecording: { ja: '記録を空にする', en: 'Clear' },
  saveOver: { ja: '上書き保存', en: 'Save' },
  saveNew: { ja: '新しい記録として保存', en: 'Save as a new record' },
  nameLabel: { ja: '名前（英小文字・数字・-）', en: 'Name (a-z, 0-9, -)' },
  titleLabel: { ja: 'タイトル', en: 'Title' },
  badName: { ja: '名前は英小文字・数字・- の 2〜39 文字で、先頭と末尾は英小文字か数字にしてください', en: 'A name is 2–39 of a-z, 0-9 and -, starting and ending with a letter or digit' },
  save: { ja: '保存', en: 'Save' },
  saving: { ja: '保存しています…', en: 'Saving…' },
  saved: { ja: '保存しました: {ref}（バージョン {version}）', en: 'Saved: {ref} (version {version})' },
  savedUnchanged: { ja: '変更はありません: {ref}（バージョン {version}）', en: 'Nothing changed: {ref} (version {version})' },
  savedKept: { ja: 'PS.com に保存できなかったため、このパソコンに残しました（{reason}）', en: 'Could not be saved to PS.com, kept on this computer ({reason})' },
  skipped: { ja: '{names} はどのロボットの名前でもないため、記録に入れませんでした', en: '{names} name no placed robot and were left out of the record' },
  recordingFull: { ja: '記録できる上限（{n} 件）に達しました。これより後の動きは表示されますが、記録されません', en: 'The recording is full ({n}): later states are shown but not recorded' },
  exportRecord: { ja: 'エクスポート', en: 'Export' },
  exported: { ja: 'エクスポートしました: {file}', en: 'Exported: {file}' },
  unsent: { ja: 'PS.com 未保存: {name}', en: 'Not on PS.com: {name}' },
  resend: { ja: '再送信する', en: 'Send again' },
  resent: { ja: '{n} 件を送信しました', en: '{n} sent' },
  removeUnsentAsk: { ja: '{name} をこのパソコンから取り除きます。PS.com には保存されていません。よろしいですか', en: 'Remove {name} from this computer? It is not on PS.com' },
  removedUnsent: { ja: '{name} を取り除きました', en: '{name} was removed' },

  // signing in and the agent
  account: { ja: 'PS.com', en: 'PS.com' },
  login: { ja: 'PS.com にログイン', en: 'Sign in to PS.com' },
  loginCode: { ja: '{url} を開いて、コード {code} を入力してください', en: 'Open {url} and enter the code {code}' },
  loginExpired: { ja: 'コードの期限が切れました。もう一度ログインしてください', en: 'The code expired. Sign in again' },
  signedIn: { ja: '{handle} でログインしています', en: 'Signed in as {handle}' },
  agentFrames: { ja: 'エージェントに映像を渡す', en: 'Share frames with the agent' },

  // the window
  failed: { ja: '操作できませんでした', en: 'That did not work' },
} as const;

export type WordKey = keyof typeof WORDS;
export type Lang = 'ja' | 'en';

const fill = (text: string, params: Record<string, unknown>) =>
  text.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(params, key) ? String(params[key]) : all));

/** A language setting: `ja…` is Japanese, anything else English. */
export const langOf = (value: unknown): Lang => (typeof value === 'string' && /^ja/i.test(value) ? 'ja' : 'en');

let posted: Lang | null = null;

function stored(): string | null {
  try { return globalThis.localStorage?.getItem('editor-language') ?? null; } catch { return null; }
}

/**
 * The language of the pane: the one the editor posted (in the sidebar), else the editor's own
 * setting kept in localStorage (a window of its own, same origin), else the browser's, else English.
 */
export function lang(): Lang {
  if (posted) return posted;
  const kept = stored();
  if (kept) return langOf(kept);
  const browser = (globalThis as { navigator?: { language?: string } }).navigator?.language;
  return langOf(browser);
}

// Weakly held: a row the pane drew again is let go
const tracked = new Set<WeakRef<HTMLElement>>();
const written = new WeakMap<HTMLElement, { key: WordKey; params: Record<string, unknown> }>();
const listeners = new Set<() => void>();

/** Run `fn` when the language changes (for text set once, such as a placeholder). */
export function onLang(fn: () => void): void { listeners.add(fn); }

/** Forget every `onLang` (for tests that mount the pane's parts more than once). */
export function forgetLangListeners(): void { listeners.clear(); }

/** The language the editor posted (null forgets it); every label shown is written again. */
export function setLang(value: unknown): void {
  const next = value === null || value === undefined ? null : langOf(value);
  if (next === posted) return;
  posted = next;
  for (const ref of tracked) {
    const element = ref.deref();
    const word = element && written.get(element);
    if (!element || !word) { tracked.delete(ref); continue; }
    // Only the text node the label owns is written: a label may hold an input after it
    const node = element.firstChild;
    if (node && node.nodeType === 3) node.textContent = say(word.key, word.params);
  }
  for (const fn of listeners) fn();
}

/** The words of a key in the pane's language, filled in. */
export const say = (key: WordKey, params: Record<string, unknown> = {}): string => fill(WORDS[key][lang()], params);

/** The Japanese of a key, filled in. */
export const ja = (key: WordKey, params: Record<string, unknown> = {}): string => fill(WORDS[key].ja, params);

/** The English of a key, filled in. */
export const en = (key: WordKey, params: Record<string, unknown> = {}): string => fill(WORDS[key].en, params);

/** An element showing a key's words in the pane's language (written again when the language changes). */
export function labelOf(key: WordKey, tag: string = 'span', params: Record<string, unknown> = {}): HTMLElement {
  const element = document.createElement(tag);
  element.append(say(key, params));
  tracked.add(new WeakRef(element));
  written.set(element, { key, params });
  return element;
}

/** A button labelled with a key. */
export function buttonOf(key: WordKey, className = 'ps-button'): HTMLButtonElement {
  const button = labelOf(key, 'button') as HTMLButtonElement;
  button.type = 'button';
  button.className = className;
  button.dataset.word = key;
  return button;
}
