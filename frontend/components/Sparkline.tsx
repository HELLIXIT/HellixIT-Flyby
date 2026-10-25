'use client';

interface Props {
  values: number[];
  color: string;
  label: string;
  format: (v: number) => string;
  height?: number;
}

/** Tiny area chart for the live altitude/speed history of a flight. */
export default function Sparkline({ values, color, label, format, height = 56 }: Props) {
  const w = 280;
  const h = height;
  if (values.length < 2) {
    return (
      <div className="spark">
        <div className="spark-head">
          <span>{label}</span>
          <span className="muted">collecting…</span>
        </div>
        <div className="spark-empty" style={{ height: h }} />
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 8)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  const id = `g-${label.replace(/\W/g, '')}`;
  return (
    <div className="spark">
      <div className="spark-head">
        <span>{label}</span>
        <span>{format(values[values.length - 1])}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height={h} role="img" aria-label={`${label} history`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${id})`} />
        <polyline points={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="spark-foot muted">
        <span>min {format(min)}</span>
        <span>max {format(max)}</span>
      </div>
    </div>
  );
}
