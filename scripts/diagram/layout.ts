// The grid rule of the architecture diagram (ADR-0021 §13): every connector is made of horizontal and
// vertical runs, and no run crosses a box. A run may start or end on a box's border (that is where it
// connects) but never enter its inside. Pure geometry over what the renderer reads from the page.
export interface Rect {
  readonly name: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** "x1,y1 x2,y2 …" (an SVG polyline's `points`) as points. */
export function parsePoints(points: string): Point[] {
  return points
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`not a point: ${pair}`);
      return { x, y };
    });
}

/** Whether the run from `a` to `b` (horizontal or vertical) passes through the inside of `box`. */
export function crosses(a: Point, b: Point, box: Rect): boolean {
  if (a.y === b.y) {
    const [from, to] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
    return a.y > box.top && a.y < box.bottom && from < box.right && to > box.left;
  }
  const [from, to] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
  return a.x > box.left && a.x < box.right && from < box.bottom && to > box.top;
}

/** Every broken rule of a diagram: a diagonal run, or a run through a box. */
export function layoutProblems(wires: readonly string[], boxes: readonly Rect[]): string[] {
  const problems: string[] = [];
  wires.forEach((wire, index) => {
    const points = parsePoints(wire);
    for (let at = 1; at < points.length; at += 1) {
      const a = points[at - 1] as Point;
      const b = points[at] as Point;
      if (a.x !== b.x && a.y !== b.y) problems.push(`wire ${index + 1}: (${a.x},${a.y})→(${b.x},${b.y}) is diagonal`);
      else for (const box of boxes) if (crosses(a, b, box)) problems.push(`wire ${index + 1}: (${a.x},${a.y})→(${b.x},${b.y}) crosses “${box.name}”`);
    }
  });
  return problems;
}
