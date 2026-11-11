// The "ps play" node: plays a record out as messages. No behaviour yet.
import type { Node, NodeAPI, NodeDef } from 'node-red';

export default function psPlayNode(RED: NodeAPI): void {
  function PsPlay(this: Node, config: NodeDef): void {
    RED.nodes.createNode(this, config);
  }
  RED.nodes.registerType('ps play', PsPlay);
}
