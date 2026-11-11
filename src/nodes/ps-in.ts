/**
 * The "ps in" node: takes MQTT messages into the pane.
 *
 * Each `ps/<site>/<id>/<kind>` message (its payload an object, JSON text or a Buffer, as `mqtt in`
 * gives it by its Output setting) goes to the plugin's hub as a live (`mqtt`) message, with the
 * broker's `retain` flag, and on to the node's output unchanged. Anything else is dropped, never
 * thrown: the first one turns the status yellow. With a site set, other sites' messages are dropped.
 */
import type { Node, NodeAPI, NodeDef } from 'node-red';
import { validMessage, type Hub } from '../plugin/hub.js';
import { isTopicName, parseTopic } from '../pscom/state.js';

interface PsInDef extends NodeDef { site?: string }

const WORDS = {
  notLoaded: 'プラグインが読み込まれていません',
  unreadable: '読み込めないメッセージ',
};

export default function psInNode(RED: NodeAPI): void {
  const hubOf = (): Hub | undefined => (RED as any).plugins?.get?.('physical-sandbox')?.hub;

  function PsIn(this: Node, config: PsInDef): void {
    RED.nodes.createNode(this, config);
    const node = this;
    const wanted = typeof config.site === 'string' ? config.site.trim() : '';
    const site = isTopicName(wanted) ? wanted : '';
    let saidUnreadable = false;

    node.on('input', (msg: any, send: (m: any) => void, done: (err?: Error) => void) => {
      const hub = hubOf();
      if (!hub) {
        node.status({ fill: 'red', shape: 'ring', text: WORDS.notLoaded });
        done();
        return;
      }
      const message = validMessage(msg);
      if (!message) {
        if (!saidUnreadable) {
          saidUnreadable = true;
          node.status({ fill: 'yellow', shape: 'ring', text: WORDS.unreadable });
        }
        done();
        return;
      }
      if (site && parseTopic(message.topic)?.site !== site) {
        done();
        return;
      }
      hub.push({ topic: msg.topic, payload: msg.payload }, 'mqtt', { retained: msg.retain === true });
      send(msg);
      done();
    });
  }
  RED.nodes.registerType('ps in', PsIn);
}
