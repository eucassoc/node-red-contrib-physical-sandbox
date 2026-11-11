/**
 * Looking at the pane (`ps_pane_frames`): the pane's picture (the background with the robots drawn
 * over it) as PNG images, now or at times of the current stream. Only while the person's switch
 * 「エージェントに映像を渡す」 in the pane is on (off at every start): the hub looks at it before it asks
 * and again when the pictures come back, and the pane looks at its own before it draws. The
 * pictures go to the MCP caller only, never to PS.com.
 *
 * At stream times the hub works out what the stream, saved now as a record, replays at each time
 * (hub.statesAt: every device counts from its own first state, as a saved record keeps it) and
 * sends those states with the request; the pane draws them on its own copy of the stage and puts
 * its live view back (src/pane/stage.ts picture). The first pane that gives the frames is taken
 * (editor-link.ts), with at most FRAMES_MAX pictures, PNG or (when a PNG is over its share of the
 * bytes) JPEG, of at most FRAME_MAX_SIDE pixels on their longest side and frameBudget bytes each,
 * which is checked here too: anything else is not given to the agent.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FRAME_MAX_SIDE, FRAMES_MAX, frameBudget } from '../../core/frames.js';
import { EditorRefused, LINK_WORDS, NoEditor, type EditorLink } from '../editor-link.js';
import type { Hub } from '../hub.js';

// What the agent is told, to pass on to the person, who may read either language
export const FRAMES_WORDS = {
  switchOff: '右ペインで「エージェントに映像を渡す」を入れてください'
    + ' / Ask the person to turn on 「エージェントに映像を渡す」 (Share frames with the agent) in the Physical Sandbox pane: the picture is given only while it is on',
  noPane: `${LINK_WORDS.noEditor} / Open the Node-RED editor with the Physical Sandbox pane in a browser: the picture comes from an open pane`,
  tooMany: `一度に取得できる映像は ${FRAMES_MAX} 枚までです / At most ${FRAMES_MAX} frames can be had at once`,
  badTimes: 'times には、保存した記録として再生したときの秒数（0 以上の数）を指定してください / times are seconds into the stream as a saved record replays it (numbers, 0 or more)',
  emptyStream: '流れに、場に置いたロボットの状態がまだありません。times を指定せずに、今の右ペインの映像を取得してください'
    + ' / The stream holds no states of the devices on the scene yet: leave out times to get what the pane shows now',
  badAnswer: `右ペインから受け取った映像の形が正しくありません / The pane's answer was not PNG or JPEG pictures of at most ${FRAME_MAX_SIDE} px`,
};

const failed = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's size from its IHDR, or null when it is not a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * A JPEG's size from its first SOF segment (FFC0–FFCF but FFC4, FFC8, FFCC), `undefined` when no
 * SOF is found before the image data, or null when it is not a JPEG (no FFD8 at the start).
 */
function jpegSize(bytes: Buffer): { width: number; height: number } | null | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd9 || marker === 0xda) return undefined; // end, or the image data starts
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > bytes.length) return undefined;
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return undefined;
}

/** Why `times` cannot be used, or null. */
function timesProblem(times: unknown): string | null {
  if (times === undefined) return null;
  if (!Array.isArray(times) || !times.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)) return FRAMES_WORDS.badTimes;
  if (times.length > FRAMES_MAX) return FRAMES_WORDS.tooMany;
  return null;
}

type Picture = { data: string; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number };

/**
 * The pane's pictures, checked: PNG (its size from IHDR) or JPEG (its size from SOF, else the
 * size the pane gave), each within FRAME_MAX_SIDE and its share of the bytes, base64 again from
 * their bytes; or null.
 */
function picturesOf(result: any, count: number): Picture[] | null {
  const frames = result?.frames;
  if (!Array.isArray(frames) || frames.length !== count) return null;
  const budget = frameBudget(count);
  const out: Picture[] = [];
  for (const frame of frames) {
    if (typeof frame?.data !== 'string') return null;
    const bytes = Buffer.from(frame.data, 'base64');
    if (bytes.length > budget) return null;
    let size: { width: number; height: number } | null;
    let mimeType: Picture['mimeType'];
    if (frame.type === 'image/png') {
      mimeType = 'image/png';
      size = pngSize(bytes);
    } else if (frame.type === 'image/jpeg') {
      mimeType = 'image/jpeg';
      const read = jpegSize(bytes);
      size = read === undefined ? { width: frame.width, height: frame.height } : read;
    } else {
      return null;
    }
    if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height)) return null;
    if (size.width < 1 || size.height < 1 || Math.max(size.width, size.height) > FRAME_MAX_SIDE) return null;
    out.push({ data: bytes.toString('base64'), mimeType, width: size.width, height: size.height });
  }
  return out;
}

// The schema the agent sees describes times fully; the check itself is timesProblem, so a wrong one
// is answered in the person's words rather than in the schema library's
const TIMES = z.any().optional().meta({
  type: 'array',
  maxItems: FRAMES_MAX,
  items: { type: 'number', minimum: 0 },
  description: `Seconds into the current stream (the opened record and what came in since) as a saved record would replay it; at most ${FRAMES_MAX}. `
    + 'Each device counts from its own first state, as a saved record keeps it (ps_record_save). '
    + 'Each frame shows every device at its latest state at that time (a time past the end shows the last states). '
    + 'Leave out for one frame of what the pane shows now.',
});

export function registerFrameTools(server: McpServer, hub: Hub, link: EditorLink | undefined): void {
  server.registerTool('ps_pane_frames', {
    description: 'Look at the Physical Sandbox pane: its picture (the background photo or video with the robots drawn over it) as PNG images, '
      + `at most ${FRAMES_MAX} per call, at most ${FRAME_MAX_SIDE} px on the longest side (JPEG instead of PNG when a PNG would be too large), `
      + 'with a text part giving each frame\'s time and size and the stream\'s duration [s] (its longest device trace). '
      + 'Only while the person has turned on 「エージェントに映像を渡す」 (Share frames with the agent) in the pane (off at every Node-RED start; see ps_status agentFrames); '
      + 'otherwise ask the person to turn it on. The pictures are given to this MCP client only and never sent to PS.com. '
      + 'Needs the pane open in a browser (see ps_status panes). A video background is drawn as it shows now, not at the stream time. '
      + 'The robots are drawn at the pane\'s size on screen and scaled to the picture: a narrow pane gives a blurrier robot.',
    inputSchema: z.object({ times: TIMES }),
  }, async ({ times }) => {
    if (!hub.status().agentFrames) return failed(FRAMES_WORDS.switchOff);
    const problem = timesProblem(times);
    if (problem) return failed(problem);
    const at: number[] | null = Array.isArray(times) && times.length > 0 ? times : null;
    let frames: { t?: number; states?: unknown[] }[] = [{}];
    let duration: number | undefined;
    if (at) {
      const found = hub.statesAt(at);
      if (!found) return failed(FRAMES_WORDS.emptyStream);
      frames = at.map((t, i) => ({ t, states: found.states[i] }));
      duration = found.duration;
    }
    if (!link) return failed(FRAMES_WORDS.noPane);
    let result: unknown;
    try {
      result = await link.ask('frames', { frames });
    } catch (e) {
      if (e instanceof NoEditor) return failed(FRAMES_WORDS.noPane);
      if (e instanceof EditorRefused) return failed(e.message);
      throw e;
    }
    // Turned off while the pane drew: what came back is not given
    if (!hub.status().agentFrames) return failed(FRAMES_WORDS.switchOff);
    const pictures = picturesOf(result, frames.length);
    if (!pictures) return failed(FRAMES_WORDS.badAnswer);
    const info = {
      frames: pictures.map((p, i) => ({ t: at ? at[i] : null, width: p.width, height: p.height })),
      ...(duration === undefined ? {} : { duration }),
    };
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(info) },
        ...pictures.map((p) => ({ type: 'image' as const, data: p.data, mimeType: p.mimeType })),
      ],
    };
  });
}
