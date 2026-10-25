// Inline SVG line chart (no chart library, docs/build-plan.md §1). Colours come from the theme as
// Tailwind classes chosen per series tone; the figure carries a title and a description for screen
// readers, and the legend is plain text so a series is found by its name.
import { useId } from "react";
import { type Point, linePath, linearScale, niceTicks, stepPath } from "./chart-geometry";

export type ChartTone = "pine" | "seal" | "success" | "warning" | "danger" | "slate";

const STROKE: Readonly<Record<ChartTone, string>> = {
  pine: "stroke-pine",
  seal: "stroke-seal",
  success: "stroke-success",
  warning: "stroke-warning",
  danger: "stroke-danger",
  slate: "stroke-slate",
};

const SWATCH: Readonly<Record<ChartTone, string>> = {
  pine: "bg-pine",
  seal: "bg-seal",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  slate: "bg-slate",
};

const LABEL_FILL: Readonly<Record<ChartTone, string>> = {
  pine: "fill-pine",
  seal: "fill-seal-deep",
  success: "fill-success",
  warning: "fill-warning",
  danger: "fill-danger",
  slate: "fill-slate",
};

export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  readonly tone: ChartTone;
  readonly points: readonly Point[];
  readonly shape?: "line" | "step";
  readonly dashed?: boolean;
}

export interface ChartMarker {
  readonly x: number;
  readonly label: string;
  readonly tone?: ChartTone;
}

interface ChartProps {
  readonly title: string;
  readonly description?: string;
  readonly series: readonly ChartSeries[];
  readonly xDomain: readonly [number, number];
  readonly xTicks: readonly number[];
  readonly formatX: (x: number) => string;
  readonly formatY: (y: number) => string;
  readonly markers?: readonly ChartMarker[];
}

const WIDTH = 720;
const HEIGHT = 280;
const PAD = { top: 24, right: 16, bottom: 32, left: 76 } as const;

export function Chart({ title, description, series, xDomain, xTicks, formatX, formatY, markers = [] }: ChartProps) {
  const titleId = useId();
  const descId = useId();
  const max = Math.max(0, ...series.flatMap((row) => row.points.map((point) => point.y)));
  const yTicks = niceTicks(max);
  const top = yTicks.at(-1) ?? 1;
  const x = linearScale(xDomain, [PAD.left, WIDTH - PAD.right]);
  const y = linearScale([0, top], [HEIGHT - PAD.bottom, PAD.top]);

  return (
    <figure className="m-0">
      <svg role="img" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full">
        <title id={titleId}>{title}</title>
        {description ? <desc id={descId}>{description}</desc> : null}
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-mist" />
            <text x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" className="fill-slate text-xs">
              {formatY(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={`x-${tick}`} x={x(tick)} y={HEIGHT - PAD.bottom + 18} textAnchor="middle" className="fill-slate text-xs">
            {formatX(tick)}
          </text>
        ))}
        {markers.map((marker) => {
          const tone = marker.tone ?? "slate";
          return (
            <g key={`m-${marker.label}-${marker.x}`}>
              <line x1={x(marker.x)} x2={x(marker.x)} y1={PAD.top - 6} y2={HEIGHT - PAD.bottom} strokeDasharray="4 4" className={STROKE[tone]} />
              <text x={x(marker.x) + 4} y={PAD.top - 10} className={`text-xs font-semibold ${LABEL_FILL[tone]}`}>
                {marker.label}
              </text>
            </g>
          );
        })}
        {series.map((row) =>
          row.points.length === 0 ? null : (
            <path
              key={row.id}
              d={row.shape === "line" ? linePath(row.points, x, y) : stepPath(row.points, x, y)}
              fill="none"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeDasharray={row.dashed ? "6 5" : undefined}
              className={STROKE[row.tone]}
            />
          ),
        )}
      </svg>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate">
        {series.map((row) => (
          <span key={row.id} className="inline-flex items-center gap-2">
            <span aria-hidden="true" className={`inline-block h-1 w-5 rounded-full ${SWATCH[row.tone]}`} />
            {row.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
