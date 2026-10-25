// leads:delete (FL-127): sessions out, staff row inactive, Cognito user gone, world retired, lead and
// requests removed, canonical count down, proof and audit with the hash only; the sign-up can happen again.
import { describe, expect, it } from "vitest";
import { keys } from "../../packages/bff/src/connector/keys";
import { leadsKeys } from "../../packages/bff/src/leads/keys";
import { createSignupHarness, startInput } from "../../packages/bff/src/guests/testing/harness";
import { deleteLead, parseDeleteArgs } from "./delete";

const EMAIL = "ana.prospecto@empresa-ficticia.ar";

async function confirmed() {
  const harness = await createSignupHarness().ready();
  const started = await harness.signup.start(startInput({ email: EMAIL }), "203.0.113.7");
  if (started.status !== "CODE_SENT") throw new Error(started.status);
  await harness.signup.confirm({ signupId: started.signupId, code: harness.cognito.lastCode(EMAIL) ?? "" });
  const sub = harness.cognito.user(EMAIL)?.sub ?? "";
  const order: string[] = [];
  const accounts = {
    signOutEverywhere: async () => void order.push("signOut"),
    deleteAccount: async (username: string) => {
      order.push("delete");
      await harness.cognito.deleteAccount(username);
    },
  };
  return { harness, sub, order, deps: { store: harness.store, hashes: harness.hashes, accounts, now: harness.now } };
}

describe("leads:delete [FL-127]", () => {
  it("deletes in order and leaves no email in Leads", async () => {
    const { harness, sub, order, deps } = await confirmed();
    const worldId = harness.hashes.guestWorldId(sub);
    await harness.store.write({ kind: "update", table: "Worlds", key: keys.worldMeta(worldId), update: { set: { status: "READY" } } });
    const report = await deleteLead(EMAIL, deps);
    expect(report).toMatchObject({ leadFound: true, worldId });
    expect(order).toEqual(["signOut", "delete"]);
    expect(harness.cognito.user(EMAIL)).toBeUndefined();
    expect((await harness.connector.worlds.getStaff(worldId, `stf-${worldId}`))?.active).toBe(false);
    expect((await harness.connector.worlds.getMeta(worldId))?.status).toBe("EXPIRING");
    expect(await harness.store.get("Worlds", keys.worldMeta(worldId))).toMatchObject({ guestIndexKey: "GUEST#EXPIRING" });
    expect(await harness.store.get("Leads", leadsKeys.lead(sub))).toBeUndefined();
    const emailHash = harness.hashes.emailHash(EMAIL);
    expect((await harness.store.query({ table: "Leads", index: "ByEmailHash", partition: leadsKeys.emailHashKey(emailHash) })).items).toEqual([]);
    expect((await harness.store.get("Leads", leadsKeys.canon(harness.hashes.canonHash(EMAIL))))?.confirmed).toBe(0);
    const proof = await harness.store.query({ table: "Leads", partition: `LEADDEL#${emailHash}` });
    expect(proof.items).toHaveLength(1);
    expect(JSON.stringify(proof.items)).not.toContain("@");
    expect((await harness.store.get("Worlds", keys.worldMeta(worldId)))?.expiresAt).toBeGreaterThan(0);
  });

  it("lets the same email sign up again afterwards", async () => {
    const { harness, deps } = await confirmed();
    await deleteLead(EMAIL, deps);
    expect((await harness.signup.start(startInput({ email: EMAIL }), "198.51.100.3")).status).toBe("CODE_SENT");
  });

  it("needs a valid --email and never echoes it", () => {
    expect(() => parseDeleteArgs([])).toThrow(RangeError);
    expect(parseDeleteArgs(["--email", " Ana@Empresa-Ficticia.ar "])).toEqual({ email: "ana@empresa-ficticia.ar" });
    expect(parseDeleteArgs(["--email", "ana@yopmail.com"])).toEqual({ email: "ana@yopmail.com" });
    expect(() => parseDeleteArgs(["--email", "no-es-un-email"])).toThrow(RangeError);
  });

  it("[FL-127] sends a world still in the queue straight to EXPIRED: it holds no place of the quota", async () => {
    const { harness, sub, deps } = await confirmed();
    const worldId = harness.hashes.guestWorldId(sub);
    expect((await harness.connector.worlds.getMeta(worldId))?.status).toBe("REGISTERED");
    await deleteLead(EMAIL, deps);
    const meta = await harness.store.get("Worlds", keys.worldMeta(worldId));
    expect(meta).toMatchObject({ status: "EXPIRED", guestIndexKey: "GUEST#EXPIRED" });
  });
});
