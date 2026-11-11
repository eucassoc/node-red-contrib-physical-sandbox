/**
 * Looking at the pane (`ps_pane_frames`): the pane's picture (the background with the robots drawn
 * over it) as PNG images, now or at times of the current stream. Only while the person's switch
 * 「エージェントに映像を渡す」 in the pane is on (off at every start): the hub looks at it before it asks
 * and again when the pictures come back, and the pane looks at its own before it draws. The
 * pictures go to the MCP caller only, never to PS.com.
 *
 * At stream times the hub works out each time's latest state of every device (hub.statesAt) and
 * sends them with the request; the pane draws them on its own copy of the stage and puts its live
 * view back (src/pane/stage.ts frame). One pane answers (the first, editor-link.ts), with at most
 * FRAMES_MAX pictures of at most FRAME_MAX_SIDE pixels on their longest side, which is checked here
 * too: anything else is not given to the agent.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FRAME_MAX_SIDE, FRAMES_MAX } from '../../pane/comms-client.js';
import { EditorRefused, LINK_WORDS, NoEditor, type EditorLink } from '../editor-link.js';
import type { Hub } from '../hub.js';

// What the agent is told, to pass on to the person, who may read either language
export const FRAMES_WORDS = {
  switchOff: '右ペインで「エージェントに映像を渡す」を入れてください'
    + ' / Ask the person to turn on 「エージェントに映像を渡す」 (Share frames with the agent) in the Physical Sandbox pane: the picture is given only while it is on',
  noPane: `${LINK_WORDS.noEditor} / Open the Node-RED editor with the Physical Sandbox pane in a browser: the picture comes from an open pane`,
  tooMany: `一度に取得できる映像は ${FRAMES_MAX} 枚までです / At most ${FRAMES_MAX} frames can be had at once`,
  badTimes: 'times には流れの最初の状態からの秒数（0 以上の数）を指定してください / times are seconds from the stream\'s first state (numbers, 0 or more)',
  emptyStream: '流れにまだ状態がありません。times を指定せずに、今の右ペインの映像を取得してください'
    + ' / The stream holds no states yet: leave out times to get what the pane shows now',
  badAnswer: `右ペインから受け取った映像の形が正しくありません / The pane's answer was not PNG pictures of at most ${FRAME_MAX_SIDE} px`,
};

const failed = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Why `times` cannot be used, or null. */
function timesProblem(times: unknown): string | null {
  if (times === undefined) return null;
  if (!Array.isArray(times) || !times.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)) return FRAMES_WORDS.badTimes;
  if (times.length > FRAMES_MAX) return FRAMES_WORDS.tooMany;
  return null;
}

/** The pane's pictures as checked PNGs (base64 again from their bytes, with their size), or null. */
function picturesOf(result: any, count: number): { data: string; width: number; height: number }[] | null {
  const frames = result?.frames;
  if (!Array.isArray(frames) || frames.length !== count) return null;
  const out: { data: string; width: number; height: number }[] = [];
  for (const frame of frames) {
    if (typeof frame?.png !== 'string') return null;
    const bytes = Buffer.from(frame.png, 'base64');
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || Math.max(width, height) > FRAME_MAX_SIDE) return null;
    out.push({ data: bytes.toString('base64'), width, height });
  }
  return out;
}

// The schema the agent sees describes times fully; the check itself is timesProblem, so a wrong one
// is answered in the person's words rather than in the schema library's
const TIMES = z.any().optional().meta({
  type: 'array',
  maxItems: FRAMES_MAX,
  items: { type: 'number', minimum: 0 },
  description: `Seconds into the current stream (the opened record and what came in since), counted from its first state; at most ${FRAMES_MAX}. `
    + 'Each frame shows every device at its latest state at that time (a time past the end shows the last states). '
    + 'Leave out for one frame of what the pane shows now.',
});

export function registerFrameTools(server: McpServer, hub: Hub, link: EditorLink | undefined): void {
  server.registerTool('ps_pane_frames', {
    description: 'Look at the Physical Sandbox pane: its picture (the background photo or video with the robots drawn over it) as PNG images, '
      + `at most ${FRAMES_MAX} per call, at most ${FRAME_MAX_SIDE} px on the longest side, with a text part giving each frame's time and size and the stream's duration [s]. `
      + 'Only while the person has turned on 「エージェントに映像を渡す」 (Share frames with the agent) in the pane (off at every Node-RED start; see ps_status agentFrames); '
      + 'otherwise ask the person to turn it on. The pictures are given to this MCP client only and never sent to PS.com. '
      + 'Needs the pane open in a browser (see ps_status panes). A video background is drawn as it shows now, not at the stream time.',
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
        ...pictures.map((p) => ({ type: 'image' as const, data: p.data, mimeType: 'image/png' })),
      ],
    };
  });
}
