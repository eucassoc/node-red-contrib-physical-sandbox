// The "ps in" node: takes MQTT messages into the pane. No behaviour yet.
import type { Node, NodeAPI, NodeDef } from 'node-red';

export default function psInNode(RED: NodeAPI): void {
  function PsIn(this: Node, config: NodeDef): void {
    RED.nodes.createNode(this, config);
  }
  RED.nodes.registerType('ps in', PsIn);
}
