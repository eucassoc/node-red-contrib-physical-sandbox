// Copied from app/src/video-rules.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// excerpt: fitRect from app/src/video-rules.js

/**
 * Where a picture sits inside a box when it is shown whole, as large as it goes, in the middle.
 * The 3D drawn over it has to cover exactly this, or nothing lines up.
 *
 * @returns {{ x: number, y: number, w: number, h: number }} from the box's top left
 */
export function fitRect(boxW, boxH, mediaW, mediaH) {
  if (!(boxW > 0 && boxH > 0 && mediaW > 0 && mediaH > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const ratio = Math.min(boxW / mediaW, boxH / mediaH);
  const w = mediaW * ratio;
  const h = mediaH * ratio;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}
