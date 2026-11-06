import { createElement } from '@tetravox/module-sdk';
import type { Histogram as Data } from '../kernels/select';
import { fmt } from './controls';

/** Bars of counts; a bar outside `range` is dimmed. Its height is the bar's share of the tallest. */
export function Histogram(props: {
  id: string;
  data: Data;
  range?: { min: number | null; max: number | null };
  height?: number;
  unit?: string;
}): React.JSX.Element {
  const { data, range } = props;
  const top = Math.max(1, ...data.counts);
  const bins = data.counts.length;
  const width = (data.hi - data.lo) / bins;
  const inRange = (i: number): boolean => {
    const left = data.lo + i * width;
    return (range?.max == null || left <= range.max) && (range?.min == null || left + width >= range.min);
  };
  const total = data.counts.reduce((sum, c) => sum + c, 0);
  return (
    <div>
      <svg
        data-testid={props.id}
        data-total={total}
        viewBox={`0 0 ${bins} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Lengths from ${data.lo} to ${data.hi} ${props.unit ?? 'mm'}`}
        className="text-tvx-accent"
        style={{ display: 'block', width: '100%', height: props.height ?? 44 }}
      >
        {data.counts.map((c, i) => (
          <rect
            key={i}
            x={i + 0.08}
            width={0.84}
            y={100 - (100 * c) / top}
            height={(100 * c) / top}
            fill="currentColor"
            fillOpacity={inRange(i) ? 1 : 0.25}
            data-kept={inRange(i) ? 1 : 0}
          />
        ))}
      </svg>
      <div className="flex justify-between tabular-nums text-tvx-dim">
        <span>{data.lo} mm</span>
        <span>{fmt(total)} streamlines</span>
        <span>{data.hi} mm</span>
      </div>
    </div>
  );
}
