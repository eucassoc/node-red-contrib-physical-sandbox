// Runtime side of the Physical Sandbox plugin: the hub (scene, stream, PS.com), its routes on the
// admin app, and the plugin record through which the nodes reach the hub
// (RED.plugins.get('physical-sandbox')?.hub).
import type { NodeAPI } from 'node-red';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHub, type Hub } from './hub.js';
import { registerRoutes } from './routes.js';
import { readSettings, settingsOf } from './settings.js';

export const PLUGIN_ID = 'physical-sandbox';
export type { Hub };

export default function physicalSandboxPlugin(RED: NodeAPI): void {
  const red = RED as any;
  const userDir: string = red.settings?.userDir || join(homedir(), '.node-red');
  const settings = readSettings(settingsOf(red), { userDir });
  const hub = createHub(red, { userDir, settings });
  // This file is bundled to dist/plugin/index.js; the pane is built into dist/pane
  registerRoutes(red, hub, { paneDir: join(__dirname, '..', 'pane') });
  const definition = {
    type: PLUGIN_ID,
    onadd(): void {},
    hub,
  };
  RED.plugins.registerPlugin(PLUGIN_ID, definition);
  // Copies kept while PS.com could not be reached go now, as psbx stage does at start
  hub.sendUnsent().catch((e) => red.log?.warn?.(`physical-sandbox: unsent: ${(e as Error)?.message ?? e}`));
}
