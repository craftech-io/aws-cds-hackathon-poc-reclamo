import { describe, expect, it } from "vitest";
import { linePath, linearScale, niceStep, niceTicks, stepPath } from "./chart-geometry";

describe("linearScale", () => {
  it("maps the domain onto the range, inverted axes included", () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(50)).toBe(100);
    expect(y(100)).toBe(0);
  });

  it("never divides by zero on an empty domain", () => {
    expect(linearScale([5, 5], [0, 10])(5)).toBe(0);
  });
});

describe("niceTicks", () => {
  it("uses round steps and covers the maximum", () => {
    expect(niceStep(1_111_500_000, 4)).toBe(500_000_000);
    expect(niceTicks(1_111_500_000)).toEqual([0, 500_000_000, 1_000_000_000, 1_500_000_000]);
    expect(niceTicks(100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it("still draws an axis when everything is zero", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("paths", () => {
  const x = linearScale([1, 3], [0, 20]);
  const y = linearScale([0, 10], [10, 0]);
  const points = [
    { x: 1, y: 0 },
    { x: 2, y: 5 },
    { x: 3, y: 10 },
  ];

  it("draws straight segments", () => {
    expect(linePath(points, x, y)).toBe("M0 10 L10 5 L20 0");
  });

  it("draws steps that move on the day the value changes", () => {
    expect(stepPath(points, x, y)).toBe("M0 10 H10 V5 H20 V0");
    expect(stepPath([], x, y)).toBe("");
  });
});
