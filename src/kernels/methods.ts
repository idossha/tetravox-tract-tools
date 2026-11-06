// The record of an export: what was done, with what, in words and as the MRtrix commands that reproduce it.

import type { Rule } from './select';

export interface MethodsInput {
  moduleVersion: string;
  hostVersion: string;
  when: string;
  tractogram: { name: string; path: string | null; format: string; streamlines: number; points: number; fingerprint: string };
  atlas: { name: string; path: string | null; dims: readonly number[]; regions: number; fingerprint: string } | null;
  network: { mode: 'radial' | 'end' | 'pair'; radiusMm: number; pair: string | null; symmetric: boolean; matrixSize: number } | null;
  weights: string | null;
  value: { label: string; how: string } | null;
  namesFrom: string | null;
  tracts: { name: string; file: string; count: number; rules: Rule[]; minMm: number | null; maxMm: number | null; connection: string | null; ruleText: string[] }[];
  toleranceMm: number;
  files: string[];
}

const assignText = (n: NonNullable<MethodsInput['network']>): string =>
  n.mode === 'radial'
    ? `each streamline end goes to the nearest labelled voxel centre within ${n.radiusMm} mm (tck2connectome -assignment_radial_search ${n.radiusMm})`
    : n.mode === 'end'
      ? 'each streamline end goes to the label of the voxel it lands in (tck2connectome -assignment_end_voxels)'
      : `each streamline's two regions come from the attached pair ${n.pair ?? ''} (an -out_assignments file)`;

export function methodsText(m: MethodsInput): string {
  const out: string[] = [
    'Tract tools export',
    `Written ${m.when} by tetravox.tract-tools ${m.moduleVersion} in Tetravox (host API ${m.hostVersion}).`,
    '',
    'INPUTS',
    `Tractogram: ${m.tractogram.name} (${m.tractogram.format}), ${m.tractogram.streamlines} streamlines, ${m.tractogram.points} points, content fingerprint ${m.tractogram.fingerprint} (FNV-1a over the coordinates as read).`,
  ];
  if (m.tractogram.path !== null) out.push(`  at ${m.tractogram.path}`);
  if (m.atlas !== null) {
    out.push(`Atlas: ${m.atlas.name}, ${m.atlas.dims.join(' x ')} voxels, ${m.atlas.regions} regions, label fingerprint ${m.atlas.fingerprint} (FNV-1a over its label ids and voxel grid).`);
    if (m.atlas.path !== null) out.push(`  at ${m.atlas.path}`);
  }
  if (m.weights !== null) out.push(`Weights: per-streamline field ${m.weights}.`);
  if (m.value !== null) out.push(`Value: ${m.value.label}: ${m.value.how}.`);
  if (m.namesFrom !== null) out.push(`Region names: ${m.namesFrom}.`);
  out.push(
    '',
    'WHAT THE NUMBERS COVER',
    `Every number uses all ${m.tractogram.streamlines} streamlines in the file, whatever was drawn on screen.`,
    'Streamline length is the sum of the distances between consecutive points.',
    `A streamline is tested against a region at each of its points, using the label of the nearest voxel. Length limits are widened by ${Number(m.toleranceMm.toFixed(4))} mm (step_size / (2 x downsample_factor) from the header), as tckedit does.`,
    ''
  );
  if (m.tracts.length > 0) {
    out.push('TRACTS');
    for (const t of m.tracts) {
      out.push(`${t.name} (${t.file}): ${t.count} streamlines.`);
      for (const line of t.ruleText) out.push(`  ${line}`);
      if (t.minMm !== null || t.maxMm !== null) out.push(`  Length between ${t.minMm ?? 0} and ${t.maxMm ?? 'any'} mm.`);
      if (t.connection !== null) out.push(`  Only the connection ${t.connection}.`);
      const command = tckeditCommand(m.tractogram.name, t);
      if (command !== null) out.push(`  MRtrix: ${command}`);
    }
    out.push(
      'Starts-and-ends-in has no tckedit option. It is what tck2connectome -assignment_end_voxels -out_assignments reports as the region paired with itself.',
      ''
    );
  }
  if (m.network !== null) {
    const n = m.network;
    const t = m.tractogram.name;
    const a = m.atlas?.name ?? 'atlas';
    out.push(
      'NETWORK',
      `Regions are the atlas's nonzero labels. ${assignText(n).replace(/^./, (c) => c.toUpperCase())}. A streamline with an unassigned end joins nothing and is not counted.`,
      `Matrices have ${n.matrixSize} rows and columns, numbered 1 to ${n.matrixSize} by label id, with no header, so ids missing from the atlas are empty rows. They hold ${n.symmetric ? 'both triangles (tck2connectome -symmetric)' : "the upper triangle and the diagonal, tck2connectome's default"}.`,
      'Edges and density count pairs of different regions; density is edges over the regions choose 2. Degree and strength leave out a region connected to itself; strength is that region\'s streamlines.',
      '',
      'MRtrix equivalents:',
      `  connectome_count.csv:   tck2connectome ${t} ${a} out.csv ${assignFlag(n)}`,
      `  connectome_length.csv:  tck2connectome ${t} ${a} out.csv ${assignFlag(n)} -scale_length -stat_edge mean`
    );
    if (m.weights !== null) out.push(`  connectome_weight.csv:  tck2connectome ${t} ${a} out.csv ${assignFlag(n)} -tck_weights_in weights.txt`);
    if (m.value !== null) {
      out.push(`  value matrix:           tcksample ${t} value_image values.txt -stat_tck mean; tck2connectome ${t} ${a} out.csv ${assignFlag(n)} -scale_file values.txt -stat_edge mean`);
      out.push('  A value mean is the plain mean over the connection\'s streamlines; weights do not enter it.');
    }
    out.push('');
  }
  out.push('FILES', ...m.files.map((f) => `  ${f}`), '');
  return out.join('\n');
}

const assignFlag = (n: NonNullable<MethodsInput['network']>): string =>
  n.mode === 'radial' ? `-assignment_radial_search ${n.radiusMm}` : n.mode === 'end' ? '-assignment_end_voxels' : '(assignments attached)';

function tckeditCommand(tractogram: string, t: MethodsInput['tracts'][number]): string | null {
  if (t.connection !== null || t.rules.some((r) => r.mode === 'both')) return null;
  const ends = t.rules.some((r) => r.mode === 'ends');
  // tckedit's -ends_only applies to every rule, so a mixed recipe has no one command.
  if (ends && t.rules.some((r) => r.mode !== 'ends')) return null;
  const args = t.rules.map((r) => {
    const flag = r.effect === 'include' ? '-include' : '-exclude';
    if (r.kind === 'sphere') return `${flag} ${r.center.join(',')},${r.radiusMm}`;
    return `${flag} ${r.labels.length === 0 ? r.volume : `mask_of_${r.labels.join('_')}.mif`}`;
  });
  if (t.minMm !== null) args.push(`-minlength ${t.minMm}`);
  if (t.maxMm !== null) args.push(`-maxlength ${t.maxMm}`);
  if (ends) args.push('-ends_only');
  return `tckedit ${tractogram} ${t.file} ${args.join(' ')}`;
}

/** Sixteen hex digits of two FNV-1a lanes over 32-bit words. */
export class Fingerprint {
  private a = 0x811c9dc5;
  private b = 0x01000193;

  add(words: Uint32Array): void {
    let a = this.a;
    let b = this.b;
    for (let i = 0; i < words.length; i += 1) {
      a = Math.imul(a ^ words[i]!, 0x01000193);
      b = Math.imul(b ^ words[i]!, 0x85ebca6b);
    }
    this.a = a;
    this.b = b;
  }

  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}
