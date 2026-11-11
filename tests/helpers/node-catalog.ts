/** The nodes' message catalogs as the runtime's RED._ would answer from them (the test helper's own RED._ returns the key). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './built-package.js';

export function readCatalog(node: 'ps-in' | 'ps-play', lang: 'en-US' | 'ja'): Record<string, any> {
  return JSON.parse(readFileSync(join(repoRoot, 'src', 'nodes', 'locales', lang, `${node}.json`), 'utf8'));
}

/** `RED._` over both catalogs: `ps-play.status.playing` with `{ n, m }` fills `__n__` and `__m__`, as Node-RED's i18n does. */
export function catalogUnderscore(lang: 'en-US' | 'ja'): (key: string, opts?: Record<string, unknown>) => string {
  const catalogs = [readCatalog('ps-in', lang), readCatalog('ps-play', lang)];
  return (key, opts = {}) => {
    let found: any;
    for (const c of catalogs) {
      let at: any = c;
      for (const part of key.split('.')) at = at?.[part];
      if (typeof at === 'string') found = at;
    }
    if (found === undefined) return key;
    return found.replace(/__(\w+)__/g, (_: string, name: string) => String(opts[name] ?? ''));
  };
}
