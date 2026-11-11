// Runtime side of the Physical Sandbox plugin: the hub (scene, stream, PS.com), its routes on the
// admin app, the link to the open editors and panes, the MCP route for an agent on this machine,
// and the plugin record through which the nodes reach the hub (RED.plugins.get('physical-sandbox')?.hub).
import type { NodeAPI } from 'node-red';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHub, type Hub } from './hub.js';
import { registerRoutes } from './routes.js';
import { createActions, untranslated } from './actions.js';
import { createEditorLink } from './editor-link.js';
import { mountMcp } from './mcp.js';
import { readSettings, settingsOf } from './settings.js';

export const PLUGIN_ID = 'physical-sandbox';
export type { Hub };

export default function physicalSandboxPlugin(RED: NodeAPI): void {
  const red = RED as any;
  const userDir: string = red.settings?.userDir || join(homedir(), '.node-red');
  const settings = readSettings(settingsOf(red), { userDir });
  const hub = createHub(red, { userDir, settings });
  // A refusal whose sentence has no English is said in Japanese and noted in Node-RED's log
  untranslated.warn = (message) => red.log?.warn?.(message);
  // This file is bundled to dist/plugin/index.js; the pane is built into dist/pane
  // One set of actions for the pane's routes and the agent's tools (the catalog cache, the robots listed)
  const actions = createActions(hub);
  registerRoutes(red, hub, { paneDir: join(__dirname, '..', 'pane'), actions });
  const link = createEditorLink(red);
  // An MCP route that cannot be mounted (the key file cannot be made) turns MCP off, not the plugin
  try {
    mountMcp(red, hub, { userDir, link, actions });
  } catch (e) {
    red.log?.warn?.(`physical-sandbox: MCP is off: ${(e as Error)?.message ?? e}`);
  }
  const definition = {
    type: PLUGIN_ID,
    onadd(): void {},
    hub,
  };
  RED.plugins.registerPlugin(PLUGIN_ID, definition);
  // Copies kept while PS.com could not be reached go now, as psbx stage does at start
  hub.sendUnsent().catch((e) => red.log?.warn?.(`physical-sandbox: unsent: ${(e as Error)?.message ?? e}`));
}
