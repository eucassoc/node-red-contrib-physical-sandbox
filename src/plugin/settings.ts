/**
 * The plugin's settings, from `physicalSandbox` in Node-RED's settings.js:
 *
 * ```js
 * physicalSandbox: {
 *   catalogBase: 'https://physicalsandbox.com',   // PS.com (the catalog and records); $PS_CATALOG_URL wins
 *   localMachineDirs: ['~/robots'],                // folders of robots only this machine has (bundle.json)
 *   site: 'local',                                 // the site of a new scene: ps/<site>/<id>/<kind>
 * }
 * ```
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isTopicName } from '../pscom/state.js';

export interface PluginSettings {
  catalogBase: string;
  localMachineDirs: string[];
  site: string;
}

export const DEFAULT_CATALOG_BASE = 'https://physicalsandbox.com';
export const DEFAULT_SITE = 'local';

/** `~` and `~/…` are the home folder; other relative paths are taken from Node-RED's user directory. */
function folder(path: string, userDir: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(userDir, path);
}

/**
 * The settings from `raw` (settings.js's `physicalSandbox`, possibly missing or wrong): anything
 * that is not what it should be falls back to its default.
 */
export function readSettings(raw: unknown, { userDir, env = process.env }: { userDir: string; env?: NodeJS.ProcessEnv }): PluginSettings {
  const given = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const fromEnv = env.PS_CATALOG_URL?.trim();
  const catalogBase = (fromEnv || (typeof given.catalogBase === 'string' && given.catalogBase.trim()) || DEFAULT_CATALOG_BASE)
    .replace(/\/+$/, '');
  const localMachineDirs = Array.isArray(given.localMachineDirs)
    ? given.localMachineDirs.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map((d) => folder(d.trim(), userDir))
    : [];
  const site = isTopicName(given.site) ? given.site as string : DEFAULT_SITE;
  return { catalogBase, localMachineDirs, site };
}

/** `RED.settings.physicalSandbox`, read without throwing (the runtime's settings may refuse an unknown key). */
export function settingsOf(RED: any): unknown {
  try {
    if (RED?.settings?.physicalSandbox !== undefined) return RED.settings.physicalSandbox;
    return typeof RED?.settings?.get === 'function' ? RED.settings.get('physicalSandbox') : undefined;
  } catch {
    return undefined;
  }
}
