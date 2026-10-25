// `guest.status` of a self-signup account (docs/architecture-guests.md §3-§6) [FL-120]: the first call of a
// session stamps the last sign-in of the account's lead, a visitor's `LEAD#` or, for the scenario runner's
// `qa-<runId>-su<n>` world, its `QALEAD#` under the QA scope; an invited guest has no lead to stamp.
import { describe, expect, it } from "vitest";
import { leadsKeys, qaScopeOfWorld } from "../leads/keys";
import { qaSignupEmail } from "./signup";
import { createSignupHarness, startInput } from "./testing/harness";

const QA = { runId: "4815162342-1", key: "su1" } as const;

describe("the QA scope of a world id", () => {
  it("reads only the runner's sign-up worlds qa-<runId>-su<n>", () => {
    expect(qaScopeOfWorld("qa-4815162342-1-su1")).toEqual(QA);
    expect(qaScopeOfWorld("qa-r7-su12")).toEqual({ runId: "r7", key: "su12" });
    for (const worldId of ["qa-r7-smk", "gs-abcdefghij", "g07", "demo", "qa-su1", "qa-r7-su1234", "qa-R7-su1"]) expect(qaScopeOfWorld(worldId), worldId).toBeUndefined();
  });
});

describe("the last sign-in of a self-signup lead [FL-120]", () => {
  it("stamps the QA lead of a qa-<runId>-su<n> world once per session, never a visitor's partition", async () => {
    const harness = await createSignupHarness().ready();
    const email = qaSignupEmail(QA);
    const started = await harness.signup.start(startInput({ email }), "203.0.113.7", QA);
    if (started.status !== "CODE_SENT") throw new Error(started.status);
    await harness.signup.confirm({ signupId: started.signupId, code: harness.cognito.lastCode(email) ?? "" }, QA);
    const sub = harness.cognito.user(email)?.sub ?? "";
    const caller = { sub, worldId: `qa-${QA.runId}-${QA.key}`, sessionId: "qa-session-1" };

    await harness.guestWorld.status(caller);
    const first = await harness.store.get("Leads", leadsKeys.lead(sub, QA));
    expect(first?.lastLoginAtReal).toBe(harness.now().toISOString());
    expect(await harness.store.get("Leads", leadsKeys.lead(sub))).toBeUndefined();

    harness.advance(60_000);
    await harness.guestWorld.status(caller);
    expect((await harness.store.get("Leads", leadsKeys.lead(sub, QA)))?.lastLoginAtReal).toBe(first?.lastLoginAtReal);
    await harness.guestWorld.status({ ...caller, sessionId: "qa-session-2" });
    expect((await harness.store.get("Leads", leadsKeys.lead(sub, QA)))?.lastLoginAtReal).toBe(harness.now().toISOString());
  });

  it("stamps nothing for a world that has no lead (an invited guest's gNN)", async () => {
    const harness = await createSignupHarness().ready();
    await harness.guestWorld.status({ sub: "sub-invited", worldId: "g07", sessionId: "s-1" });
    expect(await harness.store.get("Leads", leadsKeys.lead("sub-invited"))).toBeUndefined();
  });
});
