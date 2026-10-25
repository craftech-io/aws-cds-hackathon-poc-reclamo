// guests:signup-switch (docs/architecture-guests.md §7): an absent row reads closed; opened and closed
// only by the operator, audited.
import { describe, expect, it } from "vitest";
import { createSignupHarness } from "../../packages/bff/src/guests/testing/harness";
import { applySwitch, parseSwitchArgs } from "./signup-switch";

describe("guests:signup-switch [FL-112]", () => {
  it("starts closed, opens (lifting the kill) and closes, auditing each change", async () => {
    const harness = await createSignupHarness({ open: false }).ready();
    expect(await applySwitch("check", harness.store)).toEqual({ open: false, killed: false });
    await harness.store.write({ kind: "put", table: "Runtime", item: { pk: "KILL#SIGNUP", sk: "META", active: true } });
    expect(await applySwitch("on", harness.store, harness.now)).toEqual({ open: true, killed: false });
    expect(await harness.caps.signupOpen()).toBe(true);
    harness.advance(1000);
    expect(await applySwitch("off", harness.store, harness.now)).toEqual({ open: false, killed: false });
    const audit = await harness.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#${harness.now().toISOString().slice(0, 7)}` });
    expect(audit.items.map((item) => item.outcome)).toEqual(["OPEN", "CLOSED"]);
  });

  it("audits both changes even when they share the same millisecond", async () => {
    const harness = await createSignupHarness({ open: false }).ready();
    for (let round = 0; round < 8; round++) {
      await applySwitch("on", harness.store, harness.now);
      await applySwitch("off", harness.store, harness.now);
    }
    const audit = await harness.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#${harness.now().toISOString().slice(0, 7)}` });
    expect(audit.items.map((item) => item.outcome).sort()).toEqual([...Array<string>(8).fill("CLOSED"), ...Array<string>(8).fill("OPEN")]);
  });

  it("takes exactly one action", () => {
    expect(parseSwitchArgs(["--on"])).toBe("on");
    expect(() => parseSwitchArgs([])).toThrow(RangeError);
    expect(() => parseSwitchArgs(["--on", "--off"])).toThrow(RangeError);
  });
});
