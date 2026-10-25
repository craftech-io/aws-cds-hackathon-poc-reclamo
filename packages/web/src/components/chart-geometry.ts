// Geometry of the inline SVG charts (no chart library, docs/build-plan.md §1): linear scales,
// round tick values and the path of a line or step series.

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Scale = (value: number) => number;

export function linearScale(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0));
}

/** A round step (1, 2, 2.5 or 5 times a power of ten) that splits `max` in about `count` parts. */
export function niceStep(max: number, count: number): number {
  if (max <= 0 || count <= 0) return 1;
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** Ticks from 0 to the first round value at or above `max`. */
export function niceTicks(max: number, count = 4): number[] {
  const step = niceStep(max, count);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
  return ticks;
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Straight segments between consecutive points. */
export function linePath(points: readonly Point[], x: Scale, y: Scale): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${round(x(point.x))} ${round(y(point.y))}`).join(" ");
}

/** Horizontal then vertical segments: a running total that jumps on the day money moves. */
export function stepPath(points: readonly Point[], x: Scale, y: Scale): string {
  const [first, ...rest] = points;
  if (!first) return "";
  const parts = [`M${round(x(first.x))} ${round(y(first.y))}`];
  for (const point of rest) parts.push(`H${round(x(point.x))}`, `V${round(y(point.y))}`);
  return parts.join(" ");
}
