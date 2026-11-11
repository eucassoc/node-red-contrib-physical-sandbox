/**
 * The built package installed as npm would put it under `<dir>/node_modules`: package.json plus the
 * files it lists, and its runtime dependencies (linked from this repository's node_modules, whose
 * own dependencies are then found there).
 */
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');

export async function installBuiltPackage(dir: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const target = join(dir, 'node_modules', pkg.name);
  await mkdir(target, { recursive: true });
  await cp(join(repoRoot, 'package.json'), join(target, 'package.json'));
  for (const entry of pkg.files as string[]) {
    await cp(join(repoRoot, entry), join(target, entry), { recursive: true });
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const link = join(dir, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(repoRoot, 'node_modules', name), link, 'dir');
  }
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'node-red-project', private: true, dependencies: { [pkg.name]: pkg.version } }, null, 2),
  );
  return target;
}
