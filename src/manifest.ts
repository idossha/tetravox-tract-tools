import type { ModuleManifest } from '@tetravox/module-sdk';

export const manifest: ModuleManifest = {
  id: 'tetravox.tract-tools',
  title: 'Tract tools',
  version: '0.1.0',
  hostApi: 1,
  docs: 'https://github.com/idossha/tetravox-tract-tools#readme',
  activation: ['onToggle', 'onSceneBlock'],
  commands: [
    { id: 'add-sphere', title: 'Add a sphere rule at the crosshair' },
    { id: 'add-region-at-cursor', title: 'Add the region under the crosshair' },
    { id: 'clear', title: 'Clear the selection' },
    { id: 'connectome', title: 'Compute the connectome' },
    { id: 'export-matrix', title: 'Export the matrix as .csv' },
    { id: 'export-selection', title: 'Export the selection as .txt' },
    { id: 'load-names', title: 'Load node names' },
  ],
  readers: [
    // Never claims File ▸ Open: `.txt` is too generic, so nothing matches and only the panel's sheet reaches it.
    { id: 'names', title: 'Node names (lookup table)', extensions: ['txt', 'csv', 'tsv'], match: '^$' },
  ],
  writers: [
    { id: 'matrix', title: 'Export connectome matrix', filters: [{ name: 'CSV', extensions: ['csv'] }], siblings: [] },
    { id: 'selection', title: 'Export selection', filters: [{ name: 'Text', extensions: ['txt'] }], siblings: [] },
  ],
  operations: [
    {
      id: 'add-sphere',
      args: {
        center: 'vec3?',
        radiusMm: 'number?',
        effect: 'string?',
        test: 'string?',
        endsOnly: 'boolean?',
      },
    },
    { id: 'add-region', args: { volume: 'string', labels: 'string', effect: 'string?', endsOnly: 'boolean?' } },
    { id: 'set-length', args: { minMm: 'number?', maxMm: 'number?' } },
    { id: 'clear', args: {} },
    {
      id: 'connectome',
      args: {
        volume: 'string?',
        mode: 'string?',
        radiusMm: 'number?',
        pair: 'string?',
        weightField: 'string?',
        metricField: 'string?',
        edgeField: 'boolean?',
      },
    },
    { id: 'select-edge', args: { a: 'number', b: 'number?' } },
    { id: 'clear-edge', args: {} },
    { id: 'stats', args: { field: 'string', stats: 'string?' } },
    { id: 'export-matrix', args: { out: 'out' } },
    { id: 'export-selection', args: { out: 'out' } },
    { id: 'load-names', args: { path: 'path' } },
  ],
  sceneBlock: { version: 1 },
  ui: { popout: 'allowed', windowWidth: 980, windowHeight: 680 },
};
