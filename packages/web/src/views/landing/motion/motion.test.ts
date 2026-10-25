// FL-102 · the landing's motion as numbers (docs/landing-spec.md §4): the bubble types itself in at
// most 1.4 s, the counters settle exactly on their target in 800 ms, the hero loops through its three
// stages, the desktop tour mounts only the active visual and its neighbours, and the menu's focus
// cycles inside it.
import { describe, expect, it } from "vitest";
import { nextFocus } from "../focus-trap";
import { mountedSteps } from "../tour/tour-steps";
import { COUNT_UP_MS, HERO_LOOP_MS, TYPE_MAX_MS, countUpValue, easeOut, heroStage, typedLength, typingStepMs } from "./timing";

describe("landing motion [FL-102]", () => {
  it("types ~35 ms per character and never takes longer than 1.4 s", () => {
    expect(typingStepMs(10)).toBe(35);
    expect(typingStepMs(100)).toBe(14);
    expect(typedLength(10, 0)).toBe(0);
    expect(typedLength(10, 70)).toBe(2);
    expect(typedLength(100, TYPE_MAX_MS)).toBe(100);
    expect(typedLength(0, 0)).toBe(0);
  });

  it("counts up with an ease-out and lands exactly on the target", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(countUpValue(60, 0)).toBe(0);
    expect(countUpValue(60, COUNT_UP_MS / 2)).toBeGreaterThan(30);
    expect(countUpValue(60, COUNT_UP_MS)).toBe(60);
    expect(countUpValue(5, COUNT_UP_MS * 3)).toBe(5);
  });

  it("loops the hero through the message, the number and the blocked attempt", () => {
    expect(heroStage(0)).toBe(1);
    expect(heroStage(1_000)).toBe(2);
    expect(heroStage(2_500)).toBe(3);
    expect(heroStage(HERO_LOOP_MS)).toBe(1);
  });

  it("mounts only the active tour visual and its neighbours", () => {
    expect(mountedSteps(0)).toEqual([0, 1]);
    expect(mountedSteps(3)).toEqual([2, 3, 4]);
    expect(mountedSteps(6)).toEqual([5, 6]);
  });

  it("cycles the menu's focus from the last element to the first and back", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => ({ id }) as unknown as HTMLElement) as [HTMLElement, HTMLElement, HTMLElement];
    expect(nextFocus([a, b, c], c, false)).toBe(a);
    expect(nextFocus([a, b, c], a, true)).toBe(c);
    expect(nextFocus([a, b, c], b, false)).toBeUndefined();
    expect(nextFocus([a, b, c], null, false)).toBe(a);
    expect(nextFocus([], null, false)).toBeUndefined();
  });
});
