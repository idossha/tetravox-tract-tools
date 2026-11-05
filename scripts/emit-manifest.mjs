/**
 * `src/manifest.ts` → `dist/manifest.json`, the file the release ships beside `index.js`.
 *
 * A manifest is **data**: the app's main process validates a `type: "module"` job action against it
 * before a window exists, so it may not be code. It is written as typed TypeScript here so that the
 * `ModuleManifest` type is what checks it, and this script is the one-way door to the JSON carrier.
 * Nothing is added on the way through — entry names, sizes and hashes belong to the release, not to
 * a module's self-description — so the output is byte-for-byte a `ModuleManifest`.
 *
 * Rollup does the compiling, with this repository's own config, so the manifest is produced by the
 * same toolchain as the bundle and a `manifest.ts` that does not compile fails here.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const build = await rollup({
  input: 'src/manifest.ts',
  external: [],
  plugins: [
    nodeResolve({ extensions: ['.ts'] }),
    typescript({ tsconfig: './tsconfig.json', noEmit: false, declaration: false, sourceMap: false }),
  ],
});
const { output } = await build.generate({ format: 'es' });
await build.close();

const code = output[0].code;
const { manifest } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`dist/manifest.json: ${manifest.id} ${manifest.version} (hostApi ${manifest.hostApi})`);
