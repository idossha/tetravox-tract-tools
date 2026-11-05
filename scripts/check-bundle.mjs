/**
 * The zero-imports check, plus the size the app will refuse.
 *
 * `@tetravox/module-sdk`'s README calls this "the one rule": the built bundle is loaded over
 * `tetravox://module/<id>/<version>/index.js` and nothing there resolves a bare specifier, so a
 * surviving `import` is a module that fails at load with a specifier error rather than a diagnosis.
 * The check is on the emitted bytes rather than on the rollup config, because a config is an
 * intention.
 *
 * The size ceiling is the app's own (`main/module-store.ts`, `MAX_MODULE_FILE_BYTES`): a module file
 * is code, and 32 MiB is already an order of magnitude past plausible. Failing here is a better
 * place to learn it than an install that refuses the download.
 */

import { readFileSync, statSync } from 'node:fs';

/** `main/module-store.ts`'s `MAX_MODULE_FILE_BYTES`. */
const MAX_BYTES = 32 * 1024 * 1024;

const file = process.argv[2] ?? 'dist/index.js';
const src = readFileSync(file, 'utf8');

const bad = src.match(/^\s*(?:import\b.*|export\b.*\bfrom\b.*)$/gm) ?? [];
if (bad.length > 0) {
  console.error(`${file} must have no imports:\n${bad.join('\n')}`);
  process.exit(1);
}

// A dynamic `import(` would be a second way in, and a module has no use for one: everything it can
// reach is already on the SDK global.
const dynamic = src.match(/\bimport\s*\(/g) ?? [];
if (dynamic.length > 0) {
  console.error(`${file} must not call import(): ${dynamic.length} call(s)`);
  process.exit(1);
}

const { size } = statSync(file);
if (size > MAX_BYTES) {
  console.error(`${file} is ${size} B, over the app's ${MAX_BYTES} B ceiling for a module file`);
  process.exit(1);
}

// The shim has to be *in* the bundle, not merely not-imported: an empty file passes both checks
// above and loads nothing.
if (!src.includes('__tetravoxModuleSdk')) {
  console.error(`${file} does not read globalThis.__tetravoxModuleSdk — the SDK shim is not inlined`);
  process.exit(1);
}

console.log(`${file}: no imports, ${size} B, SDK shim inlined`);
