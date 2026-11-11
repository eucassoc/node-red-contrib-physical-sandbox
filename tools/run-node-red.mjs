// Starts Node-RED on http://127.0.0.1:1881 with this package installed, for trying it by hand.
//   node tools/run-node-red.mjs [userDir]
// Without userDir it makes a new temporary one. The package is installed there as npm would
// install it from the registry (npm i --install-links packs this folder), so run the build first.
// PS_NODE_RED=node-red-5 runs Node-RED 5 instead of the 4.1 floor.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 1881;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const nodeRedName = process.env.PS_NODE_RED || 'node-red';

const userDir = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'ps-nr-dev-'));
await mkdir(userDir, { recursive: true });
// Without a package.json here npm would install into the nearest folder above that has one.
if (!existsSync(join(userDir, 'package.json'))) {
  await writeFile(
    join(userDir, 'package.json'),
    JSON.stringify({ name: 'node-red-project', description: 'A Node-RED project', version: '0.0.1', private: true }, null, 2) + '\n',
  );
}
execFileSync('npm', ['install', '--install-links', '--no-audit', '--no-fund', root], { cwd: userDir, stdio: 'inherit' });

const RED = require(nodeRedName);
const server = http.createServer();
RED.init(server, {
  userDir,
  httpAdminRoot: '/',
  httpNodeRoot: false,
  uiHost: HOST,
  uiPort: PORT,
  flowFile: 'flows.json',
  telemetry: { enabled: false },
  logging: { console: { level: 'info', metrics: false, audit: false } },
});
server.on('request', RED.httpAdmin);
await RED.start();
await new Promise((done) => server.listen(PORT, HOST, done));
console.log(`Node-RED ${RED.version()} is at http://${HOST}:${PORT}/ (userDir ${userDir})`);

async function shutdown() {
  await RED.stop();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
