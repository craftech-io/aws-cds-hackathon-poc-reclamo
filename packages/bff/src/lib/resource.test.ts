import { describe, expect, it } from "vitest";
import { stageAllowsLiveWhatsApp } from "./resource";

describe("stageAllowsLiveWhatsApp (ADR-0002)", () => {
  const none = { email: "live" as const, whatsapp: { liveWorlds: [] } };
  const live = { email: "live" as const, whatsapp: { liveWorlds: ["demo", "qa-live-*"] } };

  it("keeps every world simulated while the list is empty", () => {
    for (const world of ["demo", "qa-live-r1"]) expect(stageAllowsLiveWhatsApp(world, none), world).toBe(false);
  });

  it("allows only demo and the QA live worlds once listed, never a guest, QA or simulated-load world", () => {
    expect(stageAllowsLiveWhatsApp("demo", live)).toBe(true);
    expect(stageAllowsLiveWhatsApp("qa-live-r1", live)).toBe(true);
    for (const world of ["g01", "gtest", "gprobe", "qamin", "qa-r1-sc01", "sim-001"]) expect(stageAllowsLiveWhatsApp(world, live), world).toBe(false);
    expect(stageAllowsLiveWhatsApp("g01", { email: "live", whatsapp: { liveWorlds: ["g01"] } })).toBe(false);
  });
});
