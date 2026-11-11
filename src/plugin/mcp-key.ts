/**
 * The key an MCP client on this machine sends (`Authorization: Bearer <key>`) to the plugin's MCP
 * route: `<userDir>/physical-sandbox/mcp-key`, 32 random bytes in hex, readable by its owner only.
 * The person copies it into the agent's MCP settings; another key can be written into the file
 * (it is read when Node-RED starts).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const keyFileIn = (userDir: string): string => join(userDir, 'physical-sandbox', 'mcp-key');

/**
 * The key in the file, made (mode 0600) when there is none: created only if no file is there, so
 * a key written meanwhile is never replaced. A file others may read is made 0600; an empty one is
 * given a key.
 */
export function ensureKey(userDir: string): string {
  const file = keyFileIn(userDir);
  mkdirSync(join(userDir, 'physical-sandbox'), { recursive: true });
  const key = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
  }
  chmodSync(file, 0o600);
  const kept = readFileSync(file, 'utf8').trim();
  if (kept) return kept;
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}
