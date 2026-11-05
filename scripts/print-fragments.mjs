// The registry `versions[]` entry a release hands to idossha/tetravox-extensions. Printed, never written:
// that repository is not this one's. The consent sheet derives its list from the installed manifest, and
// a disagreement with `permissions` here is a hard install failure.

import { readFileSync } from 'node:fs';
import { derivePermissions, validateManifest } from '@tetravox/module-sdk/manifest-schema.mjs';

const [tag, repo, ...rest] = process.argv.slice(2);
const files = rest.map((entry) => {
  const [name, bytes, sha256] = entry.trim().split(/\s+/);
  return { name, bytes: Number(bytes), sha256 };
});
const validated = validateManifest(JSON.parse(readFileSync('dist/manifest.json', 'utf8')));
if (!validated.ok) {
  console.error(validated.errors.join('\n'));
  process.exit(1);
}
const { manifest } = validated;
const store = `https://github.com/${repo}/releases/download/${tag}`;
console.log(
  JSON.stringify(
    {
      version: manifest.version,
      hostApi: manifest.hostApi,
      published: new Date().toISOString().slice(0, 10),
      permissions: derivePermissions(manifest),
      files: files.map((f) => ({ ...f, url: `${store}/${f.sha256}` })),
    },
    null,
    2
  )
);
