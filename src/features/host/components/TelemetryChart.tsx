import { useId, useMemo } from 'react';
import styles from './TelemetryChart.module.scss';

interface TelemetrySeries {
  label: string;
  color: string;
  values: number[];
}

interface TelemetryChartProps {
  series: TelemetrySeries[];
  ariaLabel: string;
}

const WIDTH = 640;
const HEIGHT = 180;
const PADDING = 8;

const linePath = (values: number[], max: number): string => {
  if (values.length === 0) return '';
  return values
    .map((value, index) => {
      const x = values.length === 1 ? WIDTH / 2 : (index / (values.length - 1)) * WIDTH;
      const ratio = Math.max(0, value) / Math.max(1, max);
      const y = HEIGHT - PADDING - ratio * (HEIGHT - PADDING * 2);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
};

export function TelemetryChart({ series, ariaLabel }: TelemetryChartProps) {
  const patternID = useId();
  const max = useMemo(
    () => Math.max(1, ...series.flatMap((entry) => entry.values.filter(Number.isFinite))),
    [series]
  );

  return (
    <div className={styles.chartWrap}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          <pattern id={patternID} width="80" height="45" patternUnits="userSpaceOnUse">
            <path d="M 80 0 L 0 0 0 45" className={styles.gridLine} fill="none" />
          </pattern>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill={`url(#${patternID})`} />
        {series.map((entry) => (
          <path
            key={entry.label}
            d={linePath(entry.values, max)}
            className={styles.trace}
            style={{ stroke: entry.color }}
          />
        ))}
      </svg>
      <div className={styles.legend} aria-hidden="true">
        {series.map((entry) => (
          <span key={entry.label}>
            <i style={{ background: entry.color }} />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}
