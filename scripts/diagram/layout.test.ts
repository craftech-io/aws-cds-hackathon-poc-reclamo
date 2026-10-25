// The grid rule of the architecture diagram (ADR-0021 §13): runs are horizontal or vertical and never
// cross a box; touching a box's border is how a run connects.
import { describe, expect, it } from "vitest";
import { crosses, layoutProblems, parsePoints } from "./layout";

const box = { name: "Box", left: 100, top: 100, right: 200, bottom: 200 };

describe("architecture diagram layout", () => {
  it("reads an SVG polyline's points", () => {
    expect(parsePoints(" 1,2  3,4 ")).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(() => parsePoints("1,a")).toThrow(/not a point/);
  });

  it("lets a run end on a box's border and pass beside it", () => {
    expect(crosses({ x: 50, y: 150 }, { x: 100, y: 150 }, box)).toBe(false);
    expect(crosses({ x: 150, y: 200 }, { x: 150, y: 260 }, box)).toBe(false);
    expect(crosses({ x: 50, y: 90 }, { x: 250, y: 90 }, box)).toBe(false);
  });

  it("refuses a run through a box and a diagonal one", () => {
    expect(crosses({ x: 50, y: 150 }, { x: 250, y: 150 }, box)).toBe(true);
    expect(crosses({ x: 150, y: 50 }, { x: 150, y: 120 }, box)).toBe(true);
    expect(layoutProblems(["50,150 250,150"], [box])).toEqual(["wire 1: (50,150)→(250,150) crosses “Box”"]);
    expect(layoutProblems(["0,0 10,10"], [box])).toEqual(["wire 1: (0,0)→(10,10) is diagonal"]);
    expect(layoutProblems(["50,150 100,150", "150,200 150,260 300,260"], [box])).toEqual([]);
  });
});
