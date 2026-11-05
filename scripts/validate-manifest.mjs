/**
 * `dist/manifest.json` against the app's **own** validator, shipped in the SDK.
 *
 * `manifest-schema.mjs` is the same code `main/module-store.ts` runs on a downloaded manifest before
 * it will register, list or serve a module, so a manifest that passes here is one the app will
 * accept — and one that fails here would have been a module that silently never appeared. It is
 * plain ESM in the tarball precisely so a module repository can run it with `node` and no install
 * step of its own.
 *
 * `derivePermissions` prints what the consent sheet will show and what the registry entry has to
 * repeat, so the two can be compared by eye at release time.
 */

import { readFileSync } from 'node:fs';
import { derivePermissions, validateManifest } from '@tetravox/module-sdk/manifest-schema.mjs';
import { MODULE_HOST_VERSION } from '@tetravox/module-sdk/manifest-types.mjs';

const file = process.argv[2] ?? 'dist/manifest.json';
const result = validateManifest(JSON.parse(readFileSync(file, 'utf8')));
if (!result.ok) {
  console.error(`${file} is not a valid module manifest:\n${result.errors.join('\n')}`);
  process.exit(1);
}

const manifest = result.manifest;
if (manifest.hostApi !== MODULE_HOST_VERSION) {
  console.error(
    `${file} declares hostApi ${manifest.hostApi}; this SDK is host API ${MODULE_HOST_VERSION}. ` +
      'A module whose hostApi is not the one the app implements is refused at activation.'
  );
  process.exit(1);
}

console.log(`${file}: valid, ${manifest.id} ${manifest.version}, hostApi ${manifest.hostApi}`);
console.log(JSON.stringify(derivePermissions(manifest), null, 2));
