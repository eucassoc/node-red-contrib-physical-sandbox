/**
 * Small PNG files for the tests, made here (no picture of anything real): `pngOf(width, height)`
 * is one colour; with `noise` every byte is random and stored without compression, so the file
 * is about as large as its pixels (3 bytes each). `pngSize` reads a PNG's width and height.
 */
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function pngOf(width: number, height: number, o: { noise?: boolean; rgb?: [number, number, number] } = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = 1 + width * 3;
  const pixels = o.noise ? randomBytes(row * height) : Buffer.alloc(row * height);
  const [r, g, b] = o.rgb ?? [40, 120, 200];
  for (let y = 0; y < height; y += 1) {
    pixels[y * row] = 0; // no filter
    if (!o.noise) for (let x = 0; x < width; x += 1) pixels.set([r, g, b], y * row + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: o.noise ? 0 : 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function pngSize(data: Buffer | string): { width: number; height: number } {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
