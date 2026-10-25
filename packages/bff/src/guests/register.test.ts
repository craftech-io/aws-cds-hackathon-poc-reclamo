// guests/register.ts (FL-113): one transaction from the named request only, idempotent, QA apart.
import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
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

  it("registers the world REGISTERED in the queue, with no TTL, and a second run finds it done", async () => {
    const { harness, request } = await codeSent();
    const first = await registerSignup(request, request.sub ?? "", harness.deps);
    expect(first.status).toBe("REGISTERED");
    const meta = await harness.store.get("Worlds", keys.worldMeta(request.worldId ?? ""));
    expect(meta).toMatchObject({ status: "REGISTERED", guestIndexKey: "GUEST#REGISTERED", origin: "SIGNUP" });
    expect(meta?.expiresAt).toBeUndefined();
    expect(await registerSignup(request, request.sub ?? "", harness.deps)).toEqual({ status: "ALREADY_REGISTERED", worldId: request.worldId });
  });

  it("accepts only the scenario runner's own qa world, and never a gs-* for it", () => {
    const base = { qa: { runId: "r7", key: "su1" } } as SignupRequest;
    expect(registrableWorld({ ...base, worldId: "qa-r7-su1" })).toBe("qa-r7-su1");
    expect(registrableWorld({ ...base, worldId: "qa-r8-su1" })).toBeUndefined();
    expect(registrableWorld({ ...base, worldId: "gs-abcdefgh23" })).toBeUndefined();
    expect(registrableWorld({ worldId: "g03" } as SignupRequest)).toBeUndefined();
  });
});
