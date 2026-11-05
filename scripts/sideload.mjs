/**
 * Install this working tree's build into the local Tetravox store, so a change can be seen in the
 * real app before it is tagged, released and catalogued.
 *
 * The app refuses to run module files whose hashes were never recorded (`verifyInstalled`,
 * `main/module-store.ts`), so copying `dist/` into place is not enough: the install **receipt**
 * beside the files is part of the on-disk contract. This writes the same three files the extensions
 * dialog would have written, with the same layout and the same receipt shape the E2E's `stageSeeg`
 * builds — one place, so a hand-copy cannot drift from what the app actually checks.
 *
 *   ~/.tetravox/modules/tetravox.tract-tools/<version>/{index.js,manifest.json,tetravox-module.json}
 *
 * `TETRAVOX_MODULE_DIR` overrides the root, exactly as it does for the app (dev builds only — a
 * packaged build ignores the seam on purpose).
 *
 * Usage:  pnpm run build && node scripts/sideload.mjs [--clean]
 *         --clean  first removes every other installed version of this module, so the app cannot
 *                  quietly keep running the older one it already has consent for.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIST = 'dist';
const NAMES = ['index.js', 'manifest.json'];

for (const name of NAMES) {
  if (!existsSync(join(DIST, name))) {
    console.error(`${join(DIST, name)} is missing — run \`pnpm run build\` first.`);
    process.exit(1);
  }
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const { id, version } = manifest;
if (typeof id !== 'string' || typeof version !== 'string') {
  console.error('dist/manifest.json has no id/version — the build is not a module.');
  process.exit(1);
}

const store = process.env['TETRAVOX_MODULE_DIR'] ?? join(homedir(), '.tetravox', 'modules');
const moduleRoot = join(store, id);
const dir = join(moduleRoot, version);

if (process.argv.includes('--clean') && existsSync(moduleRoot)) {
  for (const other of readdirSync(moduleRoot)) {
    if (other === version) continue;
    rmSync(join(moduleRoot, other), { recursive: true, force: true });
    console.log(`removed ${id} ${other}`);
  }
}

mkdirSync(dir, { recursive: true });
const files = NAMES.map((name) => {
  const bytes = readFileSync(join(DIST, name));
  writeFileSync(join(dir, name), bytes);
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});

writeFileSync(
  join(dir, 'tetravox-module.json'),
  `${JSON.stringify(
    { schema: 1, id, version, installedAt: new Date().toISOString(), files },
    null,
    2
  )}\n`
);

console.log(`installed ${id} ${version} → ${dir}`);
for (const f of files) console.log(`  ${f.name}  ${f.bytes} bytes  ${f.sha256.slice(0, 12)}…`);
console.log('\nRestart Tetravox, then File ▸ Extensions… to confirm the version, and consent if asked.');
