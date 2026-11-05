import { readFileSync } from 'node:fs';
import { derivePermissions, validateManifest } from '@tetravox/module-sdk/manifest-schema.mjs';
import { describe, expect, it } from 'vitest';
import { manifest } from '../src/manifest';

describe('manifest', () => {
  it('passes the app\'s own validator', () => {
    const result = validateManifest(JSON.parse(JSON.stringify(manifest)));
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(derivePermissions(manifest)).toContain('Store its own data inside a saved scene');
  });
  it('has the version package.json has', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe(manifest.version);
  });
  it('every command is an operation, except the one that is another operation\'s argument (§13.6)', () => {
    const ops = new Set(manifest.operations?.map((o) => o.id));
    expect(manifest.commands.filter((c) => !ops.has(c.id)).map((c) => c.id)).toEqual(['add-region-at-cursor']);
  });
  it('claims nothing from File > Open', () => {
    for (const r of manifest.readers ?? []) expect(r.match).toBe('^$');
  });
});
