// From and To. Each is a search box that lists the regions it matches, because an atlas can have
// hundreds; `kernels/choose.ts` turns them into connections.

import { createElement, useState } from '@tetravox/module-sdk';
import { regionMatches } from '../kernels/choose';
import type { ChooseRecipe } from '../kernels/choose';
import type { TractModel, View } from '../model';
import { NumberInput } from './controls';

function RegionSearch(props: { id: string; label: string; model: TractModel; view: View; value: readonly number[]; placeholder: string; onChange: (ids: number[]) => void }): React.JSX.Element {
  const { id, model, view, value } = props;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = view.regions
    .filter((r) => r > 0 && regionMatches(r, model.name(r), query))
    .sort((p, q) => model.name(p).localeCompare(model.name(q)));
  const at = Math.min(active, Math.max(0, matches.length - 1));
  // The search and the list stay as they are, so several regions can be taken from one search.
  const toggle = (region: number): void => props.onChange(value.includes(region) ? value.filter((x) => x !== region) : [...value, region]);
  return (
    <div className="flex items-start gap-1">
      <span className="shrink-0 pt-0.5 text-tvx-dim" style={{ width: 44 }}>{props.label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          data-testid={id}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-label={`${props.label}: search regions`}
          className="tvx-input min-w-0 px-1 py-0.5"
          placeholder={props.placeholder}
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            // ←/→ and ↑/↓ otherwise reach the crosshair's window listener.
            event.stopPropagation();
            if (event.key === 'ArrowDown') setActive(Math.min(at + 1, matches.length - 1));
            else if (event.key === 'ArrowUp') setActive(Math.max(at - 1, 0));
            else if (event.key === 'Enter' && matches[at] !== undefined) toggle(matches[at]);
            else if (event.key === 'Escape') {
              setOpen(false);
              event.currentTarget.blur();
            } else if (event.key === 'Backspace' && query === '' && value.length > 0) props.onChange(value.slice(0, -1));
            else return;
            if (event.key !== 'Backspace') event.preventDefault();
          }}
        />
        {open && (
          <ul id={`${id}-list`} data-testid={`${id}-list`} role="listbox" className="overflow-y-auto rounded border border-tvx-line" style={{ maxHeight: 132 }}>
            {matches.length === 0 && <li className="px-1 text-tvx-dim">No region matches.</li>}
            {matches.map((region, i) => (
              <li key={region} role="option" aria-selected={value.includes(region)}>
                <button
                  type="button"
                  data-testid={`${id}-option-${region}`}
                  className={`w-full cursor-pointer truncate px-1 text-left hover:text-tvx-text ${i === at ? 'font-semibold' : ''}`}
                  // Before the input's blur closes the list.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    toggle(region);
                  }}
                >
                  {value.includes(region) ? '✓ ' : ''}
                  {model.name(region)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {value.length > 0 && (
          <div className="flex flex-wrap gap-0.5">
            {value.map((region) => (
              <button key={region} type="button" data-testid={`${id}-chip-${region}`} className="tvx-btn tvx-btn-sm" title={`Remove ${model.name(region)}`} onClick={() => props.onChange(value.filter((x) => x !== region))}>
                {model.name(region)} ×
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Chooser(props: { model: TractModel; view: View }): React.JSX.Element {
  const { model, view } = props;
  const ch = view.recipe.connectome.choose;
  const edit = (patch: Partial<ChooseRecipe>): void => void model.run('choose', patch);
  return (
    <div data-testid="tt-chooser" className="flex flex-col gap-1 rounded border border-tvx-line p-1">
      <RegionSearch id="tt-from" label="From" model={model} view={view} value={ch.from} placeholder="Search regions…" onChange={(from) => edit({ from })} />
      <RegionSearch id="tt-to" label="To" model={model} view={view} value={ch.to} placeholder="Every region reached, or search…" onChange={(to) => edit({ to })} />
      <label className="flex items-center gap-1 text-tvx-dim" title="A connection with fewer streamlines is left out of From → To">
        Min streamlines
        <NumberInput id="tt-min-n" value={ch.minN} width={52} min={1} step={1} onChange={(raw) => Number(raw) >= 1 && edit({ minN: Math.round(Number(raw)) })} />
      </label>
    </div>
  );
}
