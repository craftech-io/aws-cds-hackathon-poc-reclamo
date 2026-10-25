import { describe, expect, it } from "vitest";
import { Caller, carriesCaller } from "./caller";

describe("Caller", () => {
  it("accepts an in-process worker call and a console call with its staff", () => {
    expect(Caller.safeParse({ kind: "WORKER", worldId: "demo", eventId: "evt-1" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "CONSOLE", worldId: "g03", staffId: "stf-guest-03", role: "GUEST", eventId: "req-1" }).success).toBe(true);
  });

  it("rejects extra keys, unknown worlds and a console call without its staff and role", () => {
    expect(Caller.safeParse({ kind: "WORKER", worldId: "demo", eventId: "evt-1", sessionToken: "x" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "WORKER", worldId: "prod", eventId: "evt-1" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", worldId: "demo", eventId: "req-1" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", worldId: "demo", staffId: "stf-operator-01", eventId: "req-1" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "QA", worldId: "qamin", staffId: "stf-qa-operator", role: "OPERATOR", eventId: "s-1" }).success).toBe(true);
  });

  it("spots a caller smuggled into a deployed entry's input", () => {
    expect(carriesCaller({ sessionToken: "t", caller: { kind: "QA" } })).toBe(true);
    expect(carriesCaller({ sessionToken: "t" })).toBe(false);
    expect(carriesCaller(null)).toBe(false);
  });
});
