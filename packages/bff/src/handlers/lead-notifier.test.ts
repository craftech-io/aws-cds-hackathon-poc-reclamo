// `LeadNotifier` (FL-126): one notice per lead, never for QA, never unconfigured, 100 a day, audited
// without the email; the Lambda entry logs only the outcome.
import { describe, expect, it } from "vitest";
import type { LeadNotice } from "../leads/notice";
import { type LeadNotifierDeps, notifyLead } from "../leads/notifier";
import { createSignupHarness, silentLogger, startInput } from "../guests/testing/harness";
import { createLeadNotifierHandler } from "./lead-notifier";

async function confirmedLead() {
  const harness = await createSignupHarness().ready();
  const started = await harness.signup.start(startInput({ acceptContact: true }), "203.0.113.7");
  if (started.status !== "CODE_SENT") throw new Error(started.status);
  await harness.signup.confirm({ signupId: started.signupId, code: harness.cognito.lastCode("ana.prospecto@empresa-ficticia.ar") ?? "" });
  const sub = harness.cognito.user("ana.prospecto@empresa-ficticia.ar")?.sub ?? "";
  const sent: LeadNotice[] = [];
  let mailbox = "ventas@craftech.io";
  let failing = false;
  const deps: LeadNotifierDeps = {
    ctx: harness.ctx,
    connector: harness.connector,
    leads: harness.leads,
    caps: harness.caps,
    transport: {
      send: async (notice) => {
        if (failing) throw new Error("ThrottlingException");
        sent.push(notice);
      },
    },
    mailbox: () => mailbox,
    log: silentLogger(),
  };
  return {
    harness,
    sub,
    sent,
    deps,
    setMailbox: (value: string) => {
      mailbox = value;
    },
    setFailing: (value: boolean) => {
      failing = value;
    },
  };
}

async function edgeAudit(harness: Awaited<ReturnType<typeof confirmedLead>>["harness"]) {
  return (await harness.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#${harness.now().toISOString().slice(0, 7)}` })).items;
}

describe("lead notifier [FL-126]", () => {
  it("sends one plain notice to the configured mailbox, once", async () => {
    const { sub, sent, deps, harness } = await confirmedLead();
    expect(await notifyLead({ leadId: sub }, deps)).toBe("SENT");
    expect(await notifyLead({ leadId: sub }, deps)).toBe("ALREADY_SENT");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ventas@craftech.io");
    const audit = await edgeAudit(harness);
    expect(audit.map((item) => item.action)).toContain("LEAD_NOTICE_SENT");
    expect(JSON.stringify(audit)).not.toContain("@");
  });

  it("skips and audits while not-configured, and sends nothing to another domain", async () => {
    const { sub, sent, deps, setMailbox } = await confirmedLead();
    setMailbox("not-configured");
    expect(await notifyLead({ leadId: sub }, deps)).toBe("NOT_CONFIGURED");
    setMailbox("alguien@otra-empresa.ar");
    expect(await notifyLead({ leadId: sub }, deps)).toBe("NOT_CONFIGURED");
    expect(sent).toEqual([]);
  });

  it("gives the claim back when the send fails, so a retry sends it", async () => {
    const { sub, sent, deps, setFailing } = await confirmedLead();
    setFailing(true);
    await expect(notifyLead({ leadId: sub }, deps)).rejects.toThrow();
    setFailing(false);
    expect(await notifyLead({ leadId: sub }, deps)).toBe("SENT");
    expect(sent).toHaveLength(1);
  });

  it("stops at 100 notices a real day and refuses anything but {leadId}", async () => {
    const { sub, deps, harness } = await confirmedLead();
    await harness.store.write({ kind: "put", table: "Runtime", item: { pk: `LEADNOTICE#${harness.now().toISOString().slice(0, 10)}`, sk: "META", count: 100 } });
    expect(await notifyLead({ leadId: sub }, deps)).toBe("DAILY_CAP");
    await expect(notifyLead({ leadId: sub, to: "x@y.z" }, deps)).rejects.toThrow();
  });

  it("[FL-126] never sends a notice for a lead of the scenario runner", async () => {
    const { deps, harness, sent } = await confirmedLead();
    const qaSub = "00000000-0000-4000-8000-0000000000aa";
    await harness.store.write({ kind: "put", table: "Leads", item: { pk: `LEAD#${qaSub}`, sk: "META", entity: "Lead", ...(await qaLead(harness, qaSub)) } });
    expect(await notifyLead({ leadId: qaSub }, deps)).toBe("QA_LEAD");
    expect(await notifyLead({ leadId: "00000000-0000-4000-8000-0000000000ff" }, deps)).toBe("NO_LEAD");
    expect(sent).toEqual([]);
  });

  it("[FL-126] the Lambda entry answers the outcome and logs neither the lead nor its email", async () => {
    const { sub, deps } = await confirmedLead();
    const lines: string[] = [];
    const { log: _log, ...adapters } = deps;
    const handler = createLeadNotifierHandler(() => adapters, (line) => lines.push(line));
    expect(await handler({ leadId: sub })).toEqual({ outcome: "SENT" });
    expect(lines.join("\n")).not.toContain("@");
    expect(lines.join("\n")).not.toContain(sub);
    await expect(handler({ leadId: "ana@empresa-ficticia.ar" })).rejects.toThrow();
  });
});

/** A lead row as the post-confirmation trigger writes it for a scenario-runner sign-up. */
async function qaLead(harness: Awaited<ReturnType<typeof confirmedLead>>["harness"], sub: string) {
  const at = harness.now().toISOString();
  return {
    sub,
    email: "success+qa-r7-su1@simulator.amazonses.com",
    locale: "en",
    consents: { terms: { acceptedAtReal: at, textVersion: "2026-10-06" }, contact: { accepted: false, textVersion: "2026-10-06" } },
    sourcePoc: "reclamo-en-regla",
    emailHash: "a".repeat(64),
    worldId: "qa-r7-su1",
    signupAtReal: at,
    confirmedAtReal: at,
    qa: { runId: "r7", key: "su1" },
  };
}
