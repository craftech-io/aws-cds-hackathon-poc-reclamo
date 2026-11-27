// guests/register.ts (FL-113): one transaction from the named request only, idempotent, QA apart.
import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { leadsKeys } from "../leads/keys";
import { registerSignup, registrableWorld } from "./register";
import type { SignupRequest } from "../leads/records";
import { createSignupHarness, startInput } from "./testing/harness";

async function codeSent() {
  const harness = await createSignupHarness().ready();
  const started = await harness.signup.start(startInput(), "203.0.113.7");
  if (started.status !== "CODE_SENT") throw new Error(started.status);
  const request = (await harness.leads.getSignup(started.signupId)) as SignupRequest;
  return { harness, request };
}

describe("registration of a confirmed sign-up [FL-113]", () => {
  it("writes nothing for another sub or a request that is not CODE_SENT", async () => {
    const { harness, request } = await codeSent();
    expect(await registerSignup(request, "someone-else", harness.deps)).toEqual({ status: "MISMATCH" });
    expect(await registerSignup({ ...request, status: "SUPERSEDED" }, request.sub ?? "", harness.deps)).toEqual({ status: "MISMATCH" });
    expect(await harness.connector.worlds.getMeta(request.worldId ?? "")).toBeUndefined();
  });

  it("registers the world PHONE_PENDING outside the queue, with no TTL and no ticket, and a second run finds it done", async () => {
    const { harness, request } = await codeSent();
    const first = await registerSignup(request, request.sub ?? "", harness.deps);
    expect(first).toEqual({ status: "REGISTERED", worldId: request.worldId });
    const meta = await harness.store.get("Worlds", keys.worldMeta(request.worldId ?? ""));
    expect(meta).toMatchObject({ status: "PHONE_PENDING", origin: "SIGNUP" });
    expect(meta?.guestIndexKey).toBeUndefined();
    expect(meta?.expiresAt).toBeUndefined();
    expect(await harness.leads.getLead(request.sub ?? "")).toMatchObject({ phoneStatus: "PENDING" });
    expect(await harness.store.get("Leads", leadsKeys.accountPhone(request.sub ?? ""))).toMatchObject({ status: "PENDING", phone: "+5491155550100", locale: "es" });
    expect(await registerSignup(request, request.sub ?? "", harness.deps)).toEqual({ status: "ALREADY_REGISTERED", worldId: request.worldId });
  });

  it("[FL-129] queues the world with its first ticket only when the account verifies its mobile", async () => {
    const { harness, request } = await codeSent();
    await registerSignup(request, request.sub ?? "", harness.deps);
    expect(harness.invoked.worlds).toEqual([]);
    expect(await harness.enrolPhone(request.sub ?? "")).toEqual({ status: "VERIFIED" });
    expect(await harness.store.get("Worlds", keys.worldMeta(request.worldId ?? ""))).toMatchObject({ status: "REGISTERED", guestIndexKey: "GUEST#REGISTERED" });
    expect(harness.invoked.worlds).toEqual([expect.objectContaining({ kind: "WORLD_CREATE", worldId: request.worldId })]);
    expect(harness.invoked.notices).toEqual([{ leadId: request.sub }]);
  });

  it("accepts only the scenario runner's own qa world, and never a gs-* for it", () => {
    const base = { qa: { runId: "r7", key: "su1" } } as SignupRequest;
    expect(registrableWorld({ ...base, worldId: "qa-r7-su1" })).toBe("qa-r7-su1");
    expect(registrableWorld({ ...base, worldId: "qa-r8-su1" })).toBeUndefined();
    expect(registrableWorld({ ...base, worldId: "gs-abcdefgh23" })).toBeUndefined();
    expect(registrableWorld({ worldId: "g03" } as SignupRequest)).toBeUndefined();
  });
});
