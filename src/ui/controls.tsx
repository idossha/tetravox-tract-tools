// Small controls. The host's stylesheet holds only classes the app itself uses, so anything else is an
// inline style; e2e checks every class named under src/ui against the built CSS.

import { createElement, useState } from '@tetravox/module-sdk';

export const fmt = (n: number): string => n.toLocaleString('en-US');
export const mm = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '–' : n.toFixed(1));

export function Button(props: {
  id: string;
  onClick: () => void;
  title?: string;
  on?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={props.id}
      className={`tvx-btn tvx-btn-sm${props.on === true ? ' tvx-btn-on' : ''}`}
      title={props.title}
      disabled={props.disabled}
      onClick={(event) => {
        if (event.detail > 0) event.currentTarget.blur();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}

export function Heading(props: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="mt-2 font-semibold text-tvx-dim">{props.children}</h3>;
}

export function Fold(props: { title: string; id: string; initiallyOpen?: boolean; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(props.initiallyOpen === true);
  return (
    <details data-testid={props.id} className="mt-2 border-t border-tvx-line pt-1" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-tvx-dim">{props.title}</summary>
      <div className="mt-1 flex flex-col gap-1">{props.children}</div>
    </details>
  );
}

export function Select<T extends string>(props: {
  id: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  title?: string;
  width?: number;
}): React.JSX.Element {
  return (
    <select
      data-testid={props.id}
      className="tvx-input min-w-0 px-1 py-0.5"
      style={props.width === undefined ? { flex: 1 } : { width: props.width, flex: 'none' }}
      value={props.value}
      title={props.title}
      onChange={(event) => props.onChange(event.target.value as T)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function NumberInput(props: {
  id: string;
  value: number | null;
  onChange: (raw: string) => void;
  width?: number;
  min?: number;
  step?: number;
  placeholder?: string;
  title?: string;
}): React.JSX.Element {
  return (
    <input
      data-testid={props.id}
      type="number"
      min={props.min ?? 0}
      step={props.step}
      className="tvx-input px-1 py-0.5 tabular-nums"
      style={{ width: props.width ?? 56 }}
      placeholder={props.placeholder}
      title={props.title}
      value={props.value ?? ''}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function Card(props: { value: string; label: string; id?: string }): React.JSX.Element {
  return (
    <div data-testid={props.id} className="min-w-0 flex-1 rounded border border-tvx-line px-1 py-0.5" style={{ textAlign: 'center' }}>
      <div className="font-semibold tabular-nums" style={{ fontSize: 14 }}>
        {props.value}
      </div>
      <div className="text-tvx-dim">{props.label}</div>
    </div>
  );
}

/** A plain bar: the value's width of a track, for reading progress at a glance. */
export function Bar(props: { fraction: number }): React.JSX.Element {
  return (
    <div className="rounded border border-tvx-line" style={{ height: 6, overflow: 'hidden' }}>
      <div className="bg-tvx-accent" style={{ height: '100%', width: `${Math.round(100 * Math.min(1, Math.max(0, props.fraction)))}%` }} />
    </div>
  );
}
