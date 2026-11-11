/**
 * The pane's frames for an agent (ps_pane_frames): how many, how large, and how many bytes each
 * may take. Shared by the plugin (which checks the answer) and the pane (which encodes it).
 *
 * The bytes: all the frames of one answer together stay under FRAMES_TOTAL_BYTES (their base64,
 * a third larger, stays well under the answer route's 20 MB), and one frame under FRAME_MAX_BYTES
 * (what an agent can take as one image).
 */
export const FRAMES_MAX = 6;
export const FRAME_MAX_SIDE = 1280;
export const FRAME_MAX_BYTES = 3.75 * 1024 * 1024;
export const FRAMES_TOTAL_BYTES = 13 * 1024 * 1024;

/** How many bytes each of `count` frames may take. */
export function frameBudget(count: number): number {
  return Math.min(FRAME_MAX_BYTES, Math.floor(FRAMES_TOTAL_BYTES / Math.max(1, count)));
}

/** The encodings a pane tries in turn until a frame fits its budget. */
export const FRAME_ENCODINGS: readonly { type: 'image/png' | 'image/jpeg'; quality?: number }[] = [
  { type: 'image/png' },
  { type: 'image/jpeg', quality: 0.85 },
  { type: 'image/jpeg', quality: 0.6 },
];
