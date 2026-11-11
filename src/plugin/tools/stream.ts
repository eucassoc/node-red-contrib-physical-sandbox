/**
 * The scene, stream and record tools: the agent places robots on the scene (`ps_scene_*`), plays a
 * stream of state messages in the pane (`ps_stream_play`, `ps_stream_stop`), turns messages into a
 * record for a `ps play` node's inline source (`ps_record_inline`), opens a PS.com record
 * (`ps_record_open`) and saves the stream (`ps_record_save`).
 *
 * Everything that the pane can do too goes through the same actions (actions.ts), so the agent's
 * place, open and save follow the pane's rules (one save at a time, kept unsent when PS.com cannot
 * be reached, a save over a record that moved meanwhile made new); the agent's stream is played by
 * the hub (`playMessages`), by time, on the hub's clock.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { messagesToRecord } from '../../core/stream.js';
import { Answer, type Actions } from '../actions.js';
import type { Hub } from '../hub.js';

// What the agent is told, to pass on to the person, who may read either language
export const STREAM_WORDS = {
  nothingToPlay: '再生できるメッセージがありません / There is nothing to play',
  leftOut: 'Some messages were left out or move nothing: invalid ones (fix them by the reason), otherSite (the scene takes its own site only) '
    + 'and unknownNames (no placed device answers to these names: place it with ps_scene_place, or use a device id)',
  unsent: 'Kept on this machine as unsent: it goes to PS.com when the person signs in or PS.com can be reached again (the pane shows it in red)',
};

/** The English beside the pane's words for each reason a pane action is refused. */
const ENGLISH: Record<string, string> = {
  'bad-place': 'give a product and where to place it (xyz: [x, y] in metres)',
  'id-taken': 'that id is in use already: choose another',
  'no-product': 'no such robot: see ps_machines_list',
  'no-device': 'the scene has no device of that id',
  'no-record': 'give a PS.com record (handle/name or handle/name:version)',
  'bad-ref': 'give a PS.com record (handle/name or handle/name:version)',
  offline: 'PS.com could not be reached',
  'sign-in': 'sign in to PS.com (in the pane)',
  'not-found': 'the record was not found',
  'bad-name': 'name: 2 to 39 lowercase letters, digits or -, starting and ending with a letter or digit',
  'bad-mode': 'mode is new or over',
  'not-own': 'only a PS.com record of the signed-in account, open in the pane, can be saved over (mode over)',
  taken: 'a record of that name exists already: choose another name',
  busy: 'a save is under way: try again when it has finished',
};

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failed = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** A pane action's refusal in the person's words and in English. */
function tell(e: unknown) {
  if (e instanceof Answer) return failed(`${e.message} / ${ENGLISH[e.reason] ?? `refused (${e.reason})`}`);
  throw e;
}

const MESSAGES = z.array(z.unknown()).describe(
  'MQTT messages as {topic, payload}: topic ps/<site>/<id>/state (or /command, /event), the site the scene\'s and the id a device\'s outside name '
  + '(a placed device answers to its own id); payload {at: milliseconds, joints: {name: radians}} for a robot\'s joints, '
  + '{at, position: [x, y, z], yaw} for where it is (site frame, metres and radians), {at, type: "item", parent, xyz} for a box.',
);

export function registerStreamTools(server: McpServer, hub: Hub, actions: Actions): void {
  server.registerTool('ps_scene_get', {
    description: 'The scene the pane shows: its site (the <site> of every topic), siteFrameId, floor, camera, background, the placed devices '
      + '(id, product, parent, pose: xyz in metres and rpy in radians, site frame, z up) and names (outside name in a topic -> device id).',
  }, async () => text(hub.scene()));

  server.registerTool('ps_scene_place', {
    description: 'Place a robot (or a catalog object, as a box) on the scene, as the pane does: product is a ref from ps_machines_list. '
      + 'A new device gets id <name>-<n> unless id is given; giving the id of a placed device moves and turns it instead (keeping its height, roll and pitch). '
      + 'xyz is where it stands in the site frame [x, y] (metres; a robot stands on the floor), yaw its turn about z (radians). '
      + 'Answers the device; its id is the outside name its state messages use (ps/<site>/<id>/state).',
    inputSchema: z.object({
      product: z.string().min(1).describe('A ref from ps_machines_list (handle/name:version, or a bare local name).'),
      xyz: z.array(z.number()).min(2).max(3).describe('[x, y] in metres (a third value is not used).'),
      yaw: z.number().optional().describe('Turn about z [rad] (0 when left out).'),
      id: z.string().optional().describe('The device id: a new one, or a placed device to move.'),
    }),
  }, async (args) => {
    try { return text(await actions.place(args)); } catch (e) { return tell(e); }
  });

  server.registerTool('ps_scene_remove', {
    description: 'Take a placed device off the scene (and its outside names).',
    inputSchema: z.object({ id: z.string().min(1).describe('The device id.') }),
  }, async (args) => {
    try { return text(actions.remove(args)); } catch (e) { return tell(e); }
  });

  server.registerTool('ps_stream_play', {
    description: 'Play state messages in the Physical Sandbox pane, from now, as the agent: each message ps/<site>/<id>/state with a payload whose at is '
      + 'in milliseconds; at counts from the first (smallest) one, so write at = 0, 33, 66, ... (30 a second is what a record keeps). '
      + 'Give every device a state at the same first at: a record starts each device\'s trace at its own first state. '
      + 'The pane shows each when it falls due (speed 2 plays in half the time; loop goes round until ps_stream_stop or another play). '
      + 'A play under way stops first. Each message is checked as the pane checks one: invalid ones are answered by index with the reason and '
      + 'left out, otherSite lists those for another site than the scene\'s (left out), unknownNames the outside names no placed device answers '
      + 'to (they move nothing a record keeps), and the rest play. The states are kept in the stream once (a loop does not keep them again), '
      + 'at the times written (whatever the speed), so ps_record_save saves them. Each play takes the place of the states the last ps_stream_play '
      + 'kept (a new attempt replaces the last one; live states from MQTT and the opened record stay); append: true keeps both. Over a record '
      + 'opened in the pane they take the place of the traces of the devices they move. Answers count, duration [s], invalid, otherSite, '
      + 'unknownNames and the status.',
    inputSchema: z.object({
      messages: MESSAGES,
      loop: z.boolean().optional().describe('Go round again at the end (default false).'),
      speed: z.number().optional().describe('Playing speed, 0.1 to 10 (default 1); the times kept are the ones written.'),
      append: z.boolean().optional().describe('Keep the states of the last ps_stream_play too, instead of replacing them (default false).'),
    }),
  }, async ({ messages, loop, speed, append }) => {
    const played = hub.playMessages(messages, { loop, speed, append });
    if (played.count === 0) {
      const why = played.invalid.slice(0, 5).map((p) => `messages[${p.index}]: ${p.reason}`)
        .concat(played.otherSite.slice(0, 5).map((p) => `messages[${p.index}]: another site (${p.site}; the scene's is ${hub.scene().site})`));
      return failed(`${STREAM_WORDS.nothingToPlay}${why.length ? ` (${why.join('; ')})` : ''}`);
    }
    const leftOut = played.invalid.length + played.otherSite.length + played.unknownNames.length > 0;
    return text({ ...played, ...(leftOut ? { next: STREAM_WORDS.leftOut } : {}), status: hub.status() });
  });

  server.registerTool('ps_stream_stop', {
    description: 'Stop what the pane is playing (a stream of the agent or a record); what was kept stays.',
  }, async () => {
    hub.stop();
    return text({ status: hub.status() });
  });

  server.registerTool('ps_stream_clear', {
    description: 'Empty the stream, as the pane\'s 「記録を空にする」 does: every state kept (the agent\'s, the live ones and the opened record\'s '
      + 'traces) and the latest states are let go, and a play of the agent under way stops. A save afterwards writes only what plays after the clear: '
      + 'the record stays open, so mode over still saves its next version (same name), with only those traces. The scene stays.',
  }, async () => text(actions.clear()));

  server.registerTool('ps_record_inline', {
    description: 'State messages (as ps_stream_play takes them) turned into a record on the current scene (its devices, names and floor), '
      + 'ready to be put as the inline record of a ps play node (its record property, as JSON text or the object) in a proposed flow. '
      + 'Nothing is played or kept. unknownNames lists the outside names no device of the scene answers to (their messages are left out); '
      + 'otherSite the sites other than the scene\'s and how many messages were for them (left out); invalid the messages that are not ones, '
      + 'by index with the reason. A record keeps at most 30 states a second per device, to the millimetre, each device\'s trace from its own '
      + 'first state: give every device a state at the same first at.',
    inputSchema: z.object({ messages: MESSAGES }),
  }, async ({ messages }) => {
    const sorted = hub.sortMessages(messages);
    const { record, skipped } = messagesToRecord(hub.scene(), sorted.messages);
    const otherSite = sorted.otherSite.length
      ? { otherSite: { sites: [...new Set(sorted.otherSite.map((m) => m.site))], count: sorted.otherSite.length } } : {};
    return text({ record, unknownNames: skipped, invalid: sorted.invalid, ...otherSite });
  });

  server.registerTool('ps_record_open', {
    description: 'Open a PS.com record in the pane, as the pane\'s 「PS.com から開く」 does, and play it: its scene (devices, names, floor) becomes the scene and its '
      + 'states the stream. A save over (ps_record_save mode over) then goes over it when it is the signed-in account\'s.',
    inputSchema: z.object({ ref: z.string().min(1).describe('handle/name, or handle/name:version.') }),
  }, async ({ ref }) => {
    try { return text(await actions.play({ ref })); } catch (e) { return tell(e); }
  });

  server.registerTool('ps_record_save', {
    description: 'Save the stream as a record on PS.com, as the pane\'s 「新しい記録として保存」 and 「上書き保存」 do: mode new saves it under name (title is what people see), '
      + 'based on the record open in the pane if any; mode over saves it over the record open in the pane as its next version. '
      + 'The stream holds the states of the last ps_stream_play (with append, the ones before it too) and the live ones; ps_stream_clear empties it. '
      + 'Over an opened record only the devices the stream moved since get new traces. Once saved, the saved record is the open one: the next '
      + 'ps_stream_play adjusts it (mode over writes the next version). Signed out or offline, it is kept on this machine '
      + '(saved false, unsent) and goes later; one save at a time. note says when it was saved under another name.',
    inputSchema: z.object({
      mode: z.enum(['new', 'over']),
      name: z.string().optional().describe('For new: 2 to 39 lowercase letters, digits or -.'),
      title: z.string().optional().describe('The title people see.'),
    }),
  }, async (args) => {
    try {
      const saved = await actions.save(args);
      return text({ ...saved, ...(saved.saved ? {} : { next: STREAM_WORDS.unsent }) });
    } catch (e) { return tell(e); }
  });
}
