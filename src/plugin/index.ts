// Runtime side of the Physical Sandbox plugin. Nodes reach the hub through
// RED.plugins.get('physical-sandbox')?.hub; for now the hub is an empty placeholder.
import type { NodeAPI } from 'node-red';

export const PLUGIN_ID = 'physical-sandbox';

/** The shared state between the nodes and the panes; filled in by later work. */
export type Hub = Record<string, never>;

export default function physicalSandboxPlugin(RED: NodeAPI): void {
  const hub: Hub = {};
  const definition = {
    type: PLUGIN_ID,
    onadd(): void {},
    hub,
  };
  RED.plugins.registerPlugin(PLUGIN_ID, definition);
}
