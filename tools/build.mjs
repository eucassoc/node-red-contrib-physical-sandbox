// Builds dist/: the runtime code (plugin and nodes) as CommonJS bundles that Node-RED can require,
// the editor .html files beside them, and the pane page (src/pane, when present) as one browser
// ES module with three.js inside.
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });

// Node-RED requires each file named in package.json "node-red"; dev dependencies are bundled in,
// package.json "dependencies" (the MCP SDK, zod) are not: npm installs them beside the package.
const { dependencies = {} } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const external = Object.keys(dependencies).flatMap((name) => [name, `${name}/*`]);
await build({
  absWorkingDir: root,
  entryPoints: {
    'plugin/index': 'src/plugin/index.ts',
    'nodes/ps-in': 'src/nodes/ps-in.ts',
    'nodes/ps-play': 'src/nodes/ps-play.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external,
  logLevel: 'warning',
});

// Node-RED loads the editor side from the .html file with the same base name as the .js file.
await mkdir(join(dist, 'plugin'), { recursive: true });
await cp(join(src, 'plugin', 'editor.html'), join(dist, 'plugin', 'index.html'));
for (const name of await readdir(join(src, 'nodes'))) {
  if (name.endsWith('.html')) await cp(join(src, 'nodes', name), join(dist, 'nodes', name));
}

// The pane page, served by the plugin: index.html plus one bundled module.
if (existsSync(join(src, 'pane', 'main.ts'))) {
  await build({
    absWorkingDir: root,
    entryPoints: { 'pane/main': 'src/pane/main.ts' },
    outdir: 'dist',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    logLevel: 'warning',
  });
  await cp(join(src, 'pane', 'index.html'), join(dist, 'pane', 'index.html'));
}
