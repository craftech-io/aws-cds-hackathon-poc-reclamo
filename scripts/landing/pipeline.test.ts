// The landing's capture pipeline (WP-44, docs/landing-spec.md §7-§8) without a browser: which captures
// exist and when the tour's walk takes them, the arguments, the encoded widths, the check of each
// frame's text (fails closed without the list) and the performance budget.
import { describe, expect, it } from "vitest";
import { TOUR_STEPS } from "../../packages/web/src/views/landing/tour/tour-steps";
import { parseCaptureArgs, pngSize, viewportsOf } from "./capture-console";
import { isMoment, momentOrder } from "./capture-world";
import { CAPTURES, CAPTURE_IDS, EVIDENCE_VIEWPORTS, PANEL_VIEWPORTS } from "./captures";
import { widthsOf } from "./encode";
import { frameProblems, requiredTerms } from "./frame-check";
import { LCP_BUDGET_MS, budgetProblems } from "./lcp";

describe("landing captures [FL-102]", () => {
  it("takes one capture per tour step but the metrics (its targets stay a render until a measured batch) and the two gallery views, the tour's in both viewports", () => {
    const tour = TOUR_STEPS.map((step) => step.mediaId).filter((id) => id !== "tour-07-metrics");
    expect(CAPTURE_IDS).toEqual([...tour, "gallery-console-inbox", "gallery-console-approvals"]);
    for (const id of tour) expect(viewportsOf(CAPTURES[id]!), id).toEqual(["desktop", "mobile"]);
    // The phone steps keep only the phone, down to their one bubble.
    expect(["tour-01-whatsapp", "tour-02-ack"].map((id) => CAPTURES[id]?.clip !== undefined)).toEqual([true, true]);
    expect(viewportsOf(CAPTURES["gallery-console-inbox"]!)).toEqual(["desktop"]);
  });

  it("keeps only the step's block in the console steps, shot at about the width the landing draws them", () => {
    for (const id of ["tour-04-email", "tour-05-blocked", "tour-06-register"]) {
      expect(CAPTURES[id]?.clip, id).toBeDefined();
      expect(CAPTURES[id]?.viewports, id).toBe(PANEL_VIEWPORTS);
    }
    // The evidence lays the read receipt and its matching settlement line side by side: each at half the panel.
    expect(CAPTURES["tour-03-evidence"]?.clip).toBeDefined();
    expect(CAPTURES["tour-03-evidence"]?.viewports).toBe(EVIDENCE_VIEWPORTS);
    expect(EVIDENCE_VIEWPORTS.desktop.width * 2).toBeLessThanOrEqual(2 * PANEL_VIEWPORTS.desktop.width);
    // Below the console's `md` (no sidebar) and no wider than the tour's 620 px panel plus its gutter.
    expect(PANEL_VIEWPORTS.desktop.width).toBeLessThan(768);
    expect(PANEL_VIEWPORTS.desktop.width).toBeLessThanOrEqual(640);
    expect(PANEL_VIEWPORTS.mobile.width).toBeLessThanOrEqual(390);
    for (const id of ["gallery-console-inbox", "gallery-console-approvals"]) expect(CAPTURES[id]?.viewports, id).toBeUndefined();
  });

  it("shoots each capture at a moment the tour's walk reaches, in the console's views", () => {
    const order = momentOrder();
    expect(order.slice(0, 4)).toEqual(["1:clock", "1", "2:simulator", "2"]);
    expect(order).toContain("7:approvals");
    for (const [id, spec] of Object.entries(CAPTURES)) {
      expect(isMoment(spec.moment), id).toBe(true);
      expect(order, id).toContain(spec.moment);
      if (typeof spec.view === "string") expect(spec.view, id).toMatch(/^\/app\/[a-z]+$/);
    }
    expect(isMoment("11")).toBe(false);
    expect(isMoment("2:nowhere")).toBe(false);
  });

  it("refuses an unknown capture and reads the output directory", () => {
    expect(parseCaptureArgs([])).toEqual({ only: undefined, out: undefined });
    expect(parseCaptureArgs(["--only", "tour-01-whatsapp, tour-06-register", "--out", "/tmp/x"])).toEqual({ only: new Set(["tour-01-whatsapp", "tour-06-register"]), out: "/tmp/x" });
    expect(() => parseCaptureArgs(["--only", "tour-07-metrics"])).toThrow(/unknown capture/);
    expect(() => parseCaptureArgs(["--only", "tour-99"])).toThrow(/unknown capture/);
    expect(() => parseCaptureArgs(["--target", "poc"])).toThrow();
  });

  it("serves every picture at 1x and 2x of its screenshot", () => {
    expect(widthsOf(2560)).toEqual([1280, 2560]);
    expect(widthsOf(780)).toEqual([390, 780]);
  });
});

describe("what a frame may show [FL-102] [FL-128]", () => {
  it("fails closed without the list of forbidden terms", () => {
    expect(() => requiredTerms({})).toThrow(/fails closed/);
    expect(requiredTerms({ FORBIDDEN_TERMS: "Marca Ajena\nOtra" })).toHaveLength(2);
  });

  it("names the line and the term's position, never the term, and catches the contest's words", () => {
    const terms = requiredTerms({ FORBIDDEN_TERMS: "Marca Ajena" });
    expect(frameProblems("tour-01/desktop", "Bandeja\nPago en Marca Ajena", terms)).toEqual(["tour-01/desktop: line 2 matches forbidden term #1"]);
    expect(frameProblems("tour-01/desktop", "Recorrido guiado\nJurado", terms)).toEqual(['tour-01/desktop: line 2 names "jurado"']);
    expect(frameProblems("tour-01/desktop", "Reclamo R-2026-000123 · Jarilla (ficticio)", terms)).toEqual([]);
  });
});

describe("landing performance budget [FL-102]", () => {
  it("flags a slow largest paint, a blocked main thread and a capture that competes with the first paint", () => {
    const ok = { page: "/ 390x844", lcpMs: 1_400, tbtMs: 10, capturesBeforeLcp: 0 };
    expect(budgetProblems([ok])).toEqual([]);
    expect(budgetProblems([{ ...ok, lcpMs: LCP_BUDGET_MS }, { ...ok, tbtMs: 250, capturesBeforeLcp: 1 }])).toEqual([
      "/ 390x844: LCP 2500 ms, budget 2500 ms",
      "/ 390x844: total blocking time 250 ms, budget 200 ms",
      "/ 390x844: 1 console capture(s) started before the largest paint",
    ]);
  });
});

describe("the size of a cropped frame [FL-102]", () => {
  it("reads a PNG's width and height from its header", () => {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(896, 16);
    header.writeUInt32BE(412, 20);
    expect(pngSize(header)).toEqual({ width: 896, height: 412 });
    expect(() => pngSize(Buffer.alloc(24))).toThrow(/not a PNG/);
  });
});
