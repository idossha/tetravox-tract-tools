/**
 * Declarations for the SDK's two plain-ESM subpaths.
 *
 * `manifest-schema.mjs` and `manifest-types.mjs` are in the tarball so a module repository can
 * validate its own `manifest.json` with `node` and no install step, and the SDK's `exports` map
 * names them — but it ships no `.d.ts` beside them, so TypeScript sees `any` and this repository's
 * `noImplicitAny` refuses them.
 *
 * `manifest-types.mjs` is re-exported from the package's own entry, so its two members are the
 * SDK's declarations and not a second opinion. `manifest-schema.mjs`'s are restated, because the
 * validator is deliberately absent from the entry (it is a build-time tool, not part of the module
 * surface) — the shapes below are copied from `types/manifest-schema.d.ts` in the same tarball, and
 * this file goes away when the SDK ships types for its subpaths.
 */

declare module '@tetravox/module-sdk/manifest-types.mjs' {
  export { MODULE_HOST_VERSION, stemOf } from '@tetravox/module-sdk';
}

declare module '@tetravox/module-sdk/manifest-schema.mjs' {
  import type { InstalledManifest } from '@tetravox/module-sdk';

  export type ManifestValidation =
    | { ok: true; manifest: InstalledManifest }
    | { ok: false; errors: string[] };

  export function validateManifest(raw: unknown): ManifestValidation;
  export function derivePermissions(manifest: InstalledManifest): string[];
}
