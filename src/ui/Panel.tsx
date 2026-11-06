// Chrome only: every control is one model call.

import { createElement, useSyncExternalStore } from '@tetravox/module-sdk';
import type { TractModel, View } from '../model';
import { manifest } from '../manifest';
import { Bar, Button } from './controls';
import { ExportTab } from './ExportTab';
import { NetworkTab } from './NetworkTab';

/** Core draws the tab row when docked; a window has none, so the panel draws its own. */
function WindowNav(props: { model: TractModel; view: View }): React.JSX.Element {
  const { model, view } = props;
  return (
    <nav data-testid="tt-window-nav" className="flex items-center gap-1 border-b border-tvx-line pb-1">
      {(manifest.ui?.panelTabs ?? []).map((t) => (
        <Button key={t.id} id={`tt-tab-${t.id}`} on={view.tab === t.id} onClick={() => void model.run('set-tab', { tab: t.id })}>
          {t.label}
        </Button>
      ))}
    </nav>
  );
}

function Status(props: { model: TractModel; view: View }): React.JSX.Element | null {
  const { model, view } = props;
  if (view.progress === null && view.message === null) return null;
  return (
    <div className="flex flex-col gap-0.5 bg-tvx-panel py-0.5" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
      {view.progress !== null && (
        <div data-testid="tt-busy" className="flex items-center gap-1 text-tvx-dim">
          <div className="min-w-0 flex-1">
            <div className="truncate" title={view.progress.label}>
              {view.progress.label} {Math.round(100 * view.progress.fraction)}%
            </div>
            <Bar fraction={view.progress.fraction} />
          </div>
          <Button id="tt-cancel" title="Stop reading. Nothing already computed is lost." onClick={() => void model.run('cancel')}>
            Cancel
          </Button>
        </div>
      )}
      {view.message !== null && (
        <p data-testid="tt-message" className="text-tvx-warn">
          {view.message}
        </p>
      )}
    </div>
  );
}

export function TractPanel(props: { model: TractModel }): React.JSX.Element {
  const { model } = props;
  const view = useSyncExternalStore(model.subscribe, model.state, model.state);
  if (!view.available) {
    return (
      <p data-testid="tt-unavailable" className="text-[11px] text-tvx-warn">
        {view.message}
      </p>
    );
  }
  return (
    <div data-testid="tract-tools" className="flex flex-col gap-1 text-[11px]">
      {view.placement === 'window' && <WindowNav model={model} view={view} />}
      <Status model={model} view={view} />
      {view.tracts.length > 1 && (
        <select
          data-testid="tt-tract"
          className="tvx-input min-w-0 px-1 py-0.5"
          value={view.recipe.tract ?? ''}
          onChange={(event) => void model.run('select-tract', { name: event.target.value })}
        >
          {view.tracts.map((t) => (
            <option key={t.id} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {view.tab === 'export' ? <ExportTab model={model} view={view} /> : <NetworkTab model={model} view={view} />}
    </div>
  );
}
