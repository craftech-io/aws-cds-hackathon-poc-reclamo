// The `Leads` table and its keys (docs/architecture-guests.md §10): no email in a key or an index,
// hashes per purpose, the pre-token read limited to `worldId`, the lead's last sign-in and the notice
// fence to one @craftech.io mailbox.
import { describe, expect, it } from "vitest";
import { GUEST_WORLD_PATTERN, base32, leadHashes, leadsKeys, subscriberPrefix } from "./keys";
import { NOT_CONFIGURED, leadNotice, leadNoticeRecipient } from "./notice";
import { isTestLead } from "./records";
import { createSignupHarness, startInput, TEST_PHONE_HASH_KEY } from "../guests/testing/harness";
import { createLogger } from "../lib/log";

describe("keys and hashes [FL-121] [FL-127]", () => {
  const hashes = leadHashes(TEST_PHONE_HASH_KEY);

  it("never puts an email in a key: the hashes differ per purpose and per form of the address", () => {
    const literal = hashes.emailHash("ana+x@empresa-ficticia.ar");
    expect(literal).toMatch(/^[0-9a-f]{64}$/);
    expect(literal).not.toBe(hashes.canonHash("ana+x@empresa-ficticia.ar"));
    expect(leadsKeys.pending(literal).pk).toBe(`PENDING#${literal}`);
    expect(leadsKeys.emailHashKey(literal)).not.toContain("@");
  });

  it("flags a lead as a test lead exactly when it carries a qa scope, which is what keys it QALEAD#", () => {
    const qa = { runId: "r1", key: "su1" };
    expect(isTestLead({ qa })).toBe(true);
    expect(isTestLead({})).toBe(false);
    expect(leadsKeys.lead("sub-1", qa).pk.startsWith("QALEAD#")).toBe(isTestLead({ qa }));
    expect(leadsKeys.lead("sub-1").pk.startsWith("QALEAD#")).toBe(isTestLead({}));
  });

  it("derives a stable gs-* world per sub, and counts an IPv6 /64 as one address", () => {
    const world = hashes.guestWorldId("3b7c1d2e-0000-4000-8000-00000000c001");
    expect(world).toMatch(GUEST_WORLD_PATTERN);
    expect(hashes.guestWorldId("3b7c1d2e-0000-4000-8000-00000000c001")).toBe(world);
    expect(hashes.guestWorldId("3b7c1d2e-0000-4000-8000-00000000c002")).not.toBe(world);
    expect(subscriberPrefix("2001:DB8:0:1::7")).toBe("2001:db8:0:1::/64");
    expect(subscriberPrefix("2001:db8:0:1:ffff:0:0:1")).toBe("2001:db8:0:1::/64");
    expect(subscriberPrefix("203.0.113.7")).toBe("203.0.113.7");
    expect(hashes.ipHash("2001:db8:0:1::7")).toBe(hashes.ipHash("2001:db8:0:1:aaaa:bbbb:cccc:dddd"));
    expect(base32(new Uint8Array([0xff]))).toBe("74");
  });

  it("separates the scenario runner's rows", () => {
    expect(leadsKeys.signup("abcdefghijklmnopqrstuvwxyz", { runId: "r7", key: "su1" }).pk).toBe("QASIGNUP#r7#abcdefghijklmnopqrstuvwxyz");
    expect(leadsKeys.lead("sub-1", { runId: "r7", key: "su1" }).pk).toBe("QALEAD#r7#sub-1");
  });
});

describe("leads repository [FL-121]", () => {
  it("reads only worldId for the pre-token trigger, and stamps the last sign-in with the retention", async () => {
    const harness = await createSignupHarness().ready();
    const started = await harness.signup.start(startInput(), "203.0.113.7");
    if (started.status !== "CODE_SENT") throw new Error(started.status);
    await harness.signup.confirm({ signupId: started.signupId, code: harness.cognito.lastCode("ana.prospecto@empresa-ficticia.ar") ?? "" });
    const sub = harness.cognito.user("ana.prospecto@empresa-ficticia.ar")?.sub ?? "";
    expect(await harness.leads.leadWorldId(sub)).toBe(harness.hashes.guestWorldId(sub));
    const projected = await harness.store.get("Leads", leadsKeys.lead(sub), { attributes: ["pk", "sk", "worldId"] });
    expect(Object.keys(projected ?? {}).sort()).toEqual(["pk", "sk", "worldId"]);

    harness.advance(3_600_000);
    expect(await harness.leads.touchSignIn(sub)).toBe(true);
    const item = await harness.store.get("Leads", leadsKeys.lead(sub));
    expect(item?.lastLoginAtReal).toBe(harness.now().toISOString());
    expect(item?.expiresAt).toBe(Math.floor(harness.now().getTime() / 1000) + 730 * 86_400);
    expect(await harness.leads.touchSignIn("no-such-sub")).toBe(false);
  });

  it("indexes requests and leads only by the email hash, keys only", async () => {
    const harness = await createSignupHarness().ready();
    await harness.signup.start(startInput(), "203.0.113.7");
    const page = await harness.store.query({ table: "Leads", index: "ByEmailHash", partition: `EMAIL#${harness.hashes.emailHash("ana.prospecto@empresa-ficticia.ar")}` });
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page.items)).not.toContain("@");
  });
});

describe("lead notice fence [FL-126]", () => {
  it("accepts exactly one @craftech.io address, and nothing while not-configured", () => {
    expect(leadNoticeRecipient("Ventas@Craftech.io")).toBe("ventas@craftech.io");
    for (const value of [NOT_CONFIGURED, "a@craftech.io,b@craftech.io", "x@craftech.io.evil.ar", "x@gmail.com", "", "x@sub.craftech.io"]) expect(leadNoticeRecipient(value), value).toBeUndefined();
  });

  it("puts no lead data in the subject and leaves out a value that fails the text rules", () => {
    const lead = {
      sub: "s",
      email: "ana@empresa-ficticia.ar",
      name: "Ana\nBcc: x@y.z",
      company: "Financiera Sur",
      consents: { terms: { acceptedAtReal: "2026-10-07T13:10:00.000Z", textVersion: "signup-v1" }, contact: { accepted: true, textVersion: "signup-v1" } },
      sourcePoc: "reclamo-en-regla",
      locale: "es" as const,
      emailHash: "0".repeat(64),
      worldId: "gs-abcdefgh23",
      signupAtReal: "2026-10-07T13:10:00.000Z",
      confirmedAtReal: "2026-10-07T13:12:00.000Z",
    };
    const notice = leadNotice(lead, "ventas@craftech.io");
    expect(notice.subject).toBe("Nuevo lead · Reclamo en regla");
    expect(notice.text).toContain("Email: ana@empresa-ficticia.ar");
    expect(notice.text).toContain("Empresa: Financiera Sur");
    expect(notice.text).toContain("Acepta que Craftech lo contacte: sí");
    expect(notice.text).not.toContain("Bcc");
  });
});

describe("a lead's email and a self-signup username never reach a log line [FL-121] [FL-127]", () => {
  it("[FL-121] masks the address under any key, inside a text, a nested object and an error", () => {
    const lines: string[] = [];
    const log = createLogger({ correlationId: "corr-lead-0001", level: "debug", sink: (line) => void lines.push(line) });
    const email = "ana.prospecto@empresa-ficticia.ar";
    log.info("guest.session", { "cognito:username": email, username: email, user: { email, login: email }, detail: `sign-in of ${email} refused` });
    log.error("signup.failed", { cause: new Error(`UsernameExistsException: ${email}`), leads: [{ to: email }] });
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("@");
    expect(lines.join("\n")).not.toContain("prospecto");
    expect(lines[0]).toContain("[EMAIL]");
  });

  it("[FL-127] keeps the hashes the operator needs to find a lead", () => {
    const lines: string[] = [];
    const hash = leadHashes(TEST_PHONE_HASH_KEY).emailHash("ana.prospecto@empresa-ficticia.ar");
    createLogger({ level: "debug", sink: (line) => void lines.push(line) }).info("lead.deleted", { emailHash: hash.slice(0, 16) });
    expect(lines[0]).toContain(hash.slice(0, 16));
  });
});
