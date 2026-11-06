// The saved tracts: a click applies one, and the Export tab writes them all.

import { createElement, react, useState } from '@tetravox/module-sdk';
import type { SavedTract, TractModel, View } from '../model';
import { Button, fmt, Heading } from './controls';

function SavedRow(props: { model: TractModel; tract: SavedTract; index: number }): React.JSX.Element {
  const { model, tract, index } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  if (renaming !== null) {
    const done = (): void => {
      void model.run('rename-tract', { name: tract.name, to: renaming });
      setRenaming(null);
    };
    return (
      <li className="flex items-center gap-1">
        <input
          data-testid={`tt-saved-name-${index}`}
          className="tvx-input min-w-0 flex-1 px-1 py-0.5"
          aria-label="New name"
          value={renaming}
          onChange={(event) => setRenaming(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') done();
            if (event.key === 'Escape') setRenaming(null);
            event.stopPropagation();
          }}
        />
        <Button id={`tt-saved-rename-ok-${index}`} onClick={done}>
          Rename
        </Button>
      </li>
    );
  }
  return (
    <li data-testid={`tt-saved-${index}`} className="flex items-center gap-1">
      <button
        type="button"
        data-testid={`tt-saved-apply-${index}`}
        className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-tvx-text"
        title={`Apply ${tract.name}`}
        onClick={() => void model.run('apply-tract', { name: tract.name })}
      >
        {tract.name}
      </button>
      <span className="shrink-0 tabular-nums text-tvx-dim">{fmt(tract.count)}</span>
      <Button id={`tt-saved-rename-${index}`} title="Rename" onClick={() => setRenaming(tract.name)}>
        ✎
      </Button>
      <Button id={`tt-saved-delete-${index}`} title="Delete" onClick={() => void model.run('delete-tract', { name: tract.name })}>
        ✕
      </Button>
    </li>
  );
}

export function Saved(props: { model: TractModel; view: View }): React.JSX.Element | null {
  const { model, view } = props;
  if (view.recipe.saved.length === 0) return null;
  return (
    <>
      <Heading>Saved tracts</Heading>
      <ul className="flex flex-col gap-0.5">
        {view.recipe.saved.map((t, i) => (
          <SavedRow key={t.name} model={model} tract={t} index={i} />
        ))}
      </ul>
    </>
  );
}
