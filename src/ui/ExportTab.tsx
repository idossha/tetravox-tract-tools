import { createElement } from '@tetravox/module-sdk';
import { slug } from '../kernels/export';
import type { ExportOptions, TractModel, View } from '../model';
import { Button, Fold, Heading } from './controls';

function Check(props: { model: TractModel; view: View; option: keyof ExportOptions; label: string; files: string; disabled?: boolean }): React.JSX.Element {
  const { model, view, option } = props;
  return (
    <label className="flex gap-1" style={{ alignItems: 'flex-start', opacity: props.disabled === true ? 0.5 : 1 }}>
      <input
        data-testid={`tt-export-${option}`}
        type="checkbox"
        disabled={props.disabled}
        checked={view.recipe.exportOptions[option]}
        onChange={(event) => void model.run('set-export', { [option]: event.target.checked })}
      />
      <span className="min-w-0">
        {props.label}
        <span className="block font-mono text-tvx-dim" style={{ fontSize: 10, overflowWrap: 'anywhere' }}>
          {props.files}
        </span>
      </span>
    </label>
  );
}

export function ExportTab(props: { model: TractModel; view: View }): React.JSX.Element {
  const { model, view } = props;
  const c = view.recipe.connectome;
  const network = view.connectome !== null;
  const value = model.valueLabel();
  const matrices = ['connectome_count.csv', 'connectome_length.csv', ...(c.weightField !== null ? ['connectome_weight.csv'] : []), ...(value !== null ? [`connectome_${slug(value)}.csv`] : [])];
  const tracts = [...view.recipe.saved.map((t) => `${slug(t.name)}.tck`), ...(view.count !== null ? ['current_filter.tck'] : [])];
  const r = view.exportResult;
  return (
    <div data-testid="tt-export" className="flex flex-col gap-1">
      <p className="text-tvx-dim">One folder of plain files that open in Python, MATLAB, R, Excel and MRtrix3.</p>
      <Heading>Network</Heading>
      {!network && <p className="text-tvx-dim">Build a network on the Network tab to export these.</p>}
      <Check model={model} view={view} option="matrices" disabled={!network} label="Matrices" files={matrices.join(', ')} />
      <Check model={model} view={view} option="edges" disabled={!network} label="Connection table" files={`edges.csv: region A, region B, n, length${c.weightField !== null ? ', weight' : ''}${value !== null ? `, ${value}` : ''}`} />
      <Check model={model} view={view} option="nodes" disabled={!network} label="Region table" files="nodes.csv: id, name, degree, strength" />
      <Check model={model} view={view} option="figure" disabled={!network} label="Matrix figure" files="connectome.png, connectome.svg" />
      <Heading>Tracts</Heading>
      <Check model={model} view={view} option="tracts" disabled={tracts.length === 0} label="Streamlines" files={tracts.length === 0 ? 'Save a tract or filter first' : tracts.join(', ')} />
      <Check model={model} view={view} option="streamlines" label="Per-streamline values" files={`streamlines.csv: index, tracts, length${value !== null ? `, ${value}` : ''}${c.weightField !== null ? ', weight' : ''}${network ? ', regions' : ''}. ${tracts.length === 0 ? 'Every streamline.' : 'The streamlines in these tracts.'}`} />
      <Heading>Record</Heading>
      <Check model={model} view={view} option="record" label="Methods and settings" files="methods.txt, recipe.json" />
      <Fold title="Advanced" id="tt-export-advanced">
        <label className="flex gap-1" style={{ alignItems: 'flex-start' }}>
          <input data-testid="tt-export-symmetric" type="checkbox" checked={view.recipe.exportOptions.symmetric} onChange={(event) => void model.run('set-export', { symmetric: event.target.checked })} />
          <span className="min-w-0 text-tvx-dim">Write both triangles of each matrix (tck2connectome -symmetric). Off, the upper triangle only, as tck2connectome writes by default.</span>
        </label>
      </Fold>
      <div className="mt-2 flex items-center gap-1">
        <Button id="tt-export-folder" on disabled={view.exporting || view.tractId === null} onClick={() => void model.run('export-folder')}>
          Export to folder…
        </Button>
      </div>
      {r !== null && (
        <div data-testid="tt-export-result" className="rounded border border-tvx-line p-2">
          {r.cancelled ? (
            <p>Export cancelled.</p>
          ) : (
            <p>
              {r.failed === null ? 'Wrote' : 'Stopped after'} {r.finished.length} {r.finished.length === 1 ? 'file' : 'files'} to <span style={{ overflowWrap: 'anywhere' }}>{r.folder}</span>
            </p>
          )}
          {r.failed !== null && <p className="text-tvx-warn">{r.failed}</p>}
          {r.finished.length > 0 && (
            <ul className="overflow-y-auto font-mono text-tvx-dim" style={{ fontSize: 10, maxHeight: 96 }}>
              {r.finished.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
