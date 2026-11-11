// Developer tool (not part of npm test): compares src/pscom/ with the PS.com checkout it was copied
// from and prints the differences. Exits 0 when ~/work/ps-com is absent, 1 when a file differs.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.PSCOM_DIR ?? join(homedir(), 'work', 'ps-com');
if (!existsSync(join(source, 'app', 'src'))) {
  console.log(`check-pscom-copy: ${source} is not here, skipped.`);
  process.exit(0);
}

const files = {
  'camera-model.js': 'camera-model.js', 'pose-solve.js': 'pose-solve.js', 'floor-frame.js': 'floor-frame.js',
  'roundtrip.js': 'roundtrip.js', 'i18n.js': 'i18n.js', 'record-upgrade.js': 'record-upgrade.js',
  'replay-rules.js': 'replay-rules.js', 'robot-build.js': 'robot-build.js', 'catalog-client.js': 'catalog-client.js',
  'orbit.js': 'orbit.js', 'state.js': 'devices/state.js',
};

/** The copy as the source would have been: header off, seam blocks off, seam edits undone. */
function undoCopy(text) {
  const lines = text.split('\n').slice(3);
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.startsWith('// PSCOM-SEAM-BEGIN')) { inBlock = true; continue; }
    if (line.startsWith('// PSCOM-SEAM-END')) { inBlock = false; continue; }
    if (inBlock || line.endsWith('// PSCOM-SEAM-NEW')) continue;
    out.push(line.startsWith('// PSCOM-SEAM-WAS ') ? line.slice('// PSCOM-SEAM-WAS '.length) : line);
  }
  return out.join('\n');
}

/** The text of `export function fitRect` with the comment above it. */
function fitRectOf(text) {
  const end = text.indexOf('\n}\n', text.indexOf('export function fitRect')) + 3;
  const start = text.lastIndexOf('/**', text.indexOf('export function fitRect'));
  return text.slice(start, end);
}

function firstDifference(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] !== y[i]) return `line ${i + 1}: copy ${JSON.stringify(x[i])} / source ${JSON.stringify(y[i])}`;
  }
  return null;
}

let bad = 0;
const report = (name, difference) => {
  if (difference) { bad += 1; console.log(`DIFFERENT ${name}: ${difference}`); } else console.log(`same      ${name}`);
};

for (const [name, from] of Object.entries(files)) {
  const copy = undoCopy(readFileSync(join(root, 'src', 'pscom', name), 'utf8'));
  report(name, firstDifference(copy, readFileSync(join(source, 'app', 'src', from), 'utf8')));
}

const excerpt = readFileSync(join(root, 'src', 'pscom', 'fit-rect.js'), 'utf8').split('\n').slice(3).join('\n').trim();
report('fit-rect.js', firstDifference(excerpt, fitRectOf(readFileSync(join(source, 'app', 'src', 'video-rules.js'), 'utf8')).trim()));

process.exit(bad ? 1 : 0);
