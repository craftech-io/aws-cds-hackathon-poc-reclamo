// leads:notice-test (FL-126): ONE "[PRUEBA]" notice through the real transport's
// MAILBOX fence to the configured @craftech.io mailbox, audited LEAD_NOTICE_TEST, no lead created, and
// never the address in what it prints or audits.
import { describe, expect, it } from "vitest";
import { createConnector } from "../../packages/bff/src/connector/create";
import { createSignupHarness } from "../../packages/bff/src/guests/testing/harness";
import { LEAD_NOTICE_SUBJECT, LEAD_NOTICE_TEST_SUBJECT, NOT_CONFIGURED, type LeadNotice } from "../../packages/bff/src/leads/notice";
import type { NoticeTestDeps } from "../../packages/bff/src/leads/notice-test";
import { createLogger } from "../../packages/bff/src/lib/log";
import { sesLeadNoticeTransport } from "../../packages/bff/src/outbound/transports/lead-notice";
import { parseNoticeTestArgs, runNoticeTest } from "./notice-test";

const MAILBOX = "ventas@craftech.io";

async function kit(mailbox: string, fail?: Error) {
  const harness = await createSignupHarness().ready();
  const sent: { to: string; subject: string; text: string }[] = [];
  // The real transport over a recording SES client: its MAILBOX fence decides what may leave.
  const client = {
    send: async (command: { input: { Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } } }) => {
      if (fail) throw fail;
      const { input } = command;
      sent.push({ to: input.Destination.ToAddresses[0] ?? "", subject: input.Content.Simple.Subject.Data, text: input.Content.Simple.Body.Text.Data });
      return {};
    },
  };
  const deps: NoticeTestDeps = {
    ctx: { store: harness.store, now: harness.now },
    connector: createConnector(harness.store, { now: harness.now }),
    transport: sesLeadNoticeTransport("Reclamo en regla <no-reply@example.test>", client as never),
    mailbox: () => mailbox,
    log: createLogger({ sink: () => undefined }),
  };
  const audit = async () => (await harness.store.query({ table: "AuditLog", partition: `SIGNUP#AUD#${harness.now().toISOString().slice(0, 7)}` })).items;
  return { deps, sent, audit };
}

describe("leads:notice-test [FL-126]", () => {
  it("sends ONE [PRUEBA] notice to the configured mailbox through the real transport, audits SENT and notifies no lead", async () => {
    const { deps, sent, audit } = await kit(MAILBOX);
    const printed = await runNoticeTest("send", deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: MAILBOX, subject: LEAD_NOTICE_TEST_SUBJECT });
    expect(sent[0]?.subject.startsWith("[PRUEBA] ")).toBe(true);
    expect(sent[0]?.text).toContain("No hay ningún lead nuevo");
    expect(sent[0]?.text).not.toContain("@");
    expect(printed).toContain("SENT");
    expect(printed).not.toContain(MAILBOX);
    const entries = await audit();
    expect(entries.map((entry) => [entry.action, entry.outcome])).toEqual([["LEAD_NOTICE_TEST", "SENT"]]);
    expect(JSON.stringify(entries)).not.toContain(MAILBOX);
    expect(entries.some((entry) => entry.action === "LEAD_NOTICE_SENT")).toBe(false);
  });

  it("sends nothing while LeadNotifyEmail is not-configured or not one @craftech.io address, and --check never sends", async () => {
    for (const mailbox of [NOT_CONFIGURED, "someone@example.org"]) {
      const { deps, sent, audit } = await kit(mailbox);
      expect(await runNoticeTest("check", deps)).toContain("nothing would be sent");
      expect(await runNoticeTest("send", deps)).toContain("NOT_CONFIGURED");
      expect(sent).toEqual([]);
      expect((await audit()).map((entry) => entry.outcome)).toEqual(["NOT_CONFIGURED"]);
    }
    const ready = await kit(MAILBOX);
    expect(await runNoticeTest("check", ready.deps)).not.toContain(MAILBOX);
    expect(ready.sent).toEqual([]);
  });

  it("audits a failed send by its error name and fails the run", async () => {
    const { deps, audit } = await kit(MAILBOX, Object.assign(new Error("boom"), { name: "MessageRejected" }));
    await expect(runNoticeTest("send", deps)).rejects.toMatchObject({ name: "MessageRejected" });
    expect((await audit()).map((entry) => [entry.outcome, (entry.refs as Record<string, string>).errorName])).toEqual([["FAILED", "MessageRejected"]]);
  });

  it("keeps the transport's fence: the test subject only to the team's mailbox, never to the probe's simulator", async () => {
    const { deps } = await kit(MAILBOX);
    const notice = (to: string, subject: string): LeadNotice => ({ to, subject, text: "x" });
    await expect(deps.transport.send(notice("success@simulator.amazonses.com", LEAD_NOTICE_TEST_SUBJECT))).rejects.toMatchObject({ name: "LeadNoticeRefused" });
    await expect(deps.transport.send(notice(MAILBOX, `${LEAD_NOTICE_SUBJECT} (otro)`))).rejects.toMatchObject({ name: "LeadNoticeRefused" });
    const probe = sesLeadNoticeTransport("x <no-reply@example.test>", { send: async () => ({}) } as never, "PROBE");
    await expect(probe.send(notice("success@simulator.amazonses.com", LEAD_NOTICE_TEST_SUBJECT))).rejects.toMatchObject({ name: "LeadNoticeRefused" });
  });

  it("takes exactly one action", () => {
    expect(parseNoticeTestArgs(["--send"])).toBe("send");
    expect(parseNoticeTestArgs(["--check"])).toBe("check");
    expect(() => parseNoticeTestArgs([])).toThrow(RangeError);
    expect(() => parseNoticeTestArgs(["--send", "--check"])).toThrow(RangeError);
    expect(() => parseNoticeTestArgs(["--to", MAILBOX])).toThrow(RangeError);
  });
});
