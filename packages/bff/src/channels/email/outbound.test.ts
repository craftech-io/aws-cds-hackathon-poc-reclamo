// The single SES client (FL-011, FL-073): raw MIME with explicit `FromEmailAddress` and
// `Destination`, the `.eml`, the record and the pending mail stored BEFORE SES, the proof `SENT`
// after; the fence and the real-clock caps refuse before anything is written; only throttling is
// retried; a repeated `mailId` never sends twice; no address reaches a log line.
import { describe, expect, it } from "vitest";
import { TEST_NOW } from "../../connector/testing";
import { ANSWERS_ADDRESS, DEMO_RECIPIENT_EMAILS_PER_DAY, EMAILS_PER_WORLD_HOUR } from "./config";
import { inspectMime } from "./mime";
import { PDF_BYTES, TEST_CONFIGURATION_SET, TEST_MAIL_ID, TEST_PROVIDER_ID, emailKit, sendRequest } from "./testing";

const REF = { worldId: "g01", customerId: "cus-0001", sentAtSim: "2026-10-07T10:10:00-03:00", mailId: TEST_MAIL_ID };
const RAW_KEY = `W/g01/2026-10-07/${TEST_MAIL_ID}.eml`;

function throttled(): Error {
  const error = new Error("slow down");
  error.name = "TooManyRequestsException";
  return error;
}

describe("SES client: what goes out and what is stored first [FL-011]", () => {
  it("sends the stored raw MIME with explicit From and one Destination, the configuration set and the tags", async () => {
    const kit = emailKit();
    const result = await kit.client.send(sendRequest());
    expect(result).toMatchObject({ status: "SENT", mailId: TEST_MAIL_ID, providerMessageId: TEST_PROVIDER_ID, s3RawKey: RAW_KEY, replayed: false });
    expect(kit.sent).toHaveLength(1);
    const input = kit.sent[0];
    expect(input?.FromEmailAddress).toBe(ANSWERS_ADDRESS);
    expect(input?.Destination).toEqual({ ToAddresses: ["success+g01-cus-0001@simulator.amazonses.com"] });
    expect(input?.Destination?.CcAddresses).toBeUndefined();
    expect(input?.Destination?.BccAddresses).toBeUndefined();
    expect(input?.ReplyToAddresses).toBeUndefined();
    expect(input?.ConfigurationSetName).toBe(TEST_CONFIGURATION_SET);
    expect(input?.Content?.Simple).toBeUndefined();
    expect(input?.EmailTags).toEqual([
      { Name: "worldId", Value: "g01" },
      { Name: "epoch", Value: "1" },
      { Name: "complaintId", Value: "cmp-0001" },
      { Name: "mailId", Value: TEST_MAIL_ID },
      { Name: "kind", Value: "ACK_EMAIL" },
      { Name: "stage", Value: "poc" },
    ]);
    const raw = input?.Content?.Raw?.Data as Uint8Array;
    expect(Buffer.from(kit.objects.get(RAW_KEY)?.body ?? []).equals(Buffer.from(raw))).toBe(true);
    const summary = await inspectMime(raw);
    expect(summary.to).toEqual(input?.Destination?.ToAddresses);
    expect(summary.attachments[0]?.bytes).toEqual(PDF_BYTES);
  });

  it("writes the .eml, its view, the EmailRecord and the pending mail before calling SES", async () => {
    let seenBeforeSes: { record: unknown; pending: unknown } | undefined;
    const kit = emailKit({
      ses: async () => {
        seenBeforeSes = { record: await kit.connector.emails.get(REF), pending: await kit.connector.runtime.listPending("g01") };
        return { MessageId: TEST_PROVIDER_ID };
      },
    });
    await kit.client.send(sendRequest());
    expect(kit.trail).toEqual([`put:${RAW_KEY}`, `put:W/g01/2026-10-07/${TEST_MAIL_ID}.json`, "ses"]);
    expect(seenBeforeSes?.record).toMatchObject({ mailId: TEST_MAIL_ID, s3RawKey: RAW_KEY, toMasked: "s***@simulator.amazonses.com", events: [] });
    expect((seenBeforeSes?.record as { providerMessageId?: string }).providerMessageId).toBeUndefined();
    expect(seenBeforeSes?.pending).toEqual([expect.objectContaining({ kind: "MAIL", pendingId: TEST_MAIL_ID, customerId: "cus-0001" })]);
    const after = await kit.connector.emails.get(REF);
    expect(after).toMatchObject({ providerMessageId: TEST_PROVIDER_ID, deliveryProof: "SENT", attachments: [{ docKind: "ACK", s3Key: "W/g01/complaints/cmp-0001/ACK-1.pdf" }] });
    expect(after?.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    const view = JSON.parse(new TextDecoder().decode(kit.objects.get(`W/g01/2026-10-07/${TEST_MAIL_ID}.json`)?.body));
    expect(view.headers.toMasked).toBe("s***@simulator.amazonses.com");
    expect(JSON.stringify(view)).not.toContain("success+g01-cus-0001");
  });

  it("puts QA worlds under qa/<runId>/<worldId>/", async () => {
    const kit = emailKit();
    const result = await kit.client.send(sendRequest({ worldId: "qa-123456789-1-sc01", to: "success+qa-123456789-1-sc01-c01@simulator.amazonses.com" }));
    expect(result).toMatchObject({ status: "SENT", s3RawKey: `qa/123456789-1/qa-123456789-1-sc01/2026-10-07/${TEST_MAIL_ID}.eml` });
  });

  it("never logs the recipient", async () => {
    const kit = emailKit();
    await kit.client.send(sendRequest());
    await kit.client.send(sendRequest({ mailId: "01JZ0000000000000000000009", to: "admin@simulator.amazonses.com" }));
    expect(kit.lines.join("\n")).not.toMatch(/success\+g01|admin@simulator/);
  });
});

describe("SES client: fence and caps refuse before anything is written [FL-073]", () => {
  it.each([
    ["a domain outside the simulator", "cliente@empresa-ficticia.ar"],
    ["a reserved domain", "cliente@jarilla.test"],
    ["a look-alike suffix", "success@simulator.amazonses.com.example.net"],
    ["upper case", "SUCCESS@simulator.amazonses.com"],
    ["several @", "success@simulator.amazonses.com@craftech.io"],
    ["a demo recipient from a guest world", "equipo-demo@craftech.io"],
  ])("refuses %s with RECIPIENT_NOT_ALLOWED and no SES call", async (_label, to) => {
    const kit = emailKit({ demoRecipients: ["equipo-demo@craftech.io"] });
    const result = await kit.client.send(sendRequest({ to }));
    expect(result).toMatchObject({ status: "REFUSED", code: "RECIPIENT_NOT_ALLOWED", ruleId: "CH-RECIPIENT-FENCE" });
    expect(kit.trail).toEqual([]);
    expect(await kit.connector.emails.get(REF)).toBeUndefined();
    expect(await kit.connector.runtime.listPending("g01")).toEqual([]);
  });

  it("sends to a demo recipient only from demo, at most 20 per real day, audited", async () => {
    const kit = emailKit({ demoRecipients: ["equipo-demo@craftech.io"] });
    const request = (n: number) => sendRequest({ worldId: "demo", to: "equipo-demo@craftech.io", mailId: `01JZ00000000000000000000${String(n).padStart(2, "0")}` });
    for (let n = 1; n <= DEMO_RECIPIENT_EMAILS_PER_DAY; n += 1) expect(await kit.client.send(request(n))).toMatchObject({ status: "SENT" });
    expect(await kit.client.send(request(99))).toEqual({ status: "REFUSED", code: "RATE_LIMITED", reason: "DEMO_RECIPIENT_DAILY_CAP" });
    expect(kit.sent).toHaveLength(DEMO_RECIPIENT_EMAILS_PER_DAY);
    const audited = await kit.connector.audit.listByAction("demo", "DEMO_RECIPIENT_EMAIL");
    expect(audited).toHaveLength(DEMO_RECIPIENT_EMAILS_PER_DAY);
    expect(JSON.stringify(audited)).not.toContain("equipo-demo");
  });

  it("stops a world at 200 emails per real hour, whatever its simulated clock says", async () => {
    const kit = emailKit();
    await kit.connector.caps.set({ kind: "RATE", worldId: "g01", phoneHash: "EMAIL", at: TEST_NOW }, EMAILS_PER_WORLD_HOUR);
    expect(await kit.client.send(sendRequest({ sentAtSim: "2026-12-31T10:00:00-03:00" }))).toEqual({ status: "REFUSED", code: "RATE_LIMITED", reason: "WORLD_HOURLY_EMAIL_CAP" });
    expect(kit.trail).toEqual([]);
    const nextHour = emailKit({ connector: kit.connector, now: () => new Date(TEST_NOW.getTime() + 60 * 60 * 1000) });
    expect(await nextHour.client.send(sendRequest())).toMatchObject({ status: "SENT" });
  });

  it("refuses a malformed request before the fence", async () => {
    const kit = emailKit();
    await expect(kit.client.send({ ...sendRequest(), cc: "x@simulator.amazonses.com" } as never)).rejects.toMatchObject({ code: "INVALID" });
    await expect(kit.client.send(sendRequest({ subject: "R-2026-000123\nBcc: x" }))).rejects.toMatchObject({ code: "INVALID" });
    expect(kit.trail).toEqual([]);
  });

  it("answers the gate's step 5 and fence.probe without writing or sending", () => {
    const kit = emailKit();
    expect(kit.client.checkRecipient({ worldId: "g01", to: "success@simulator.amazonses.com" })).toMatchObject({ allowed: true });
    expect(kit.client.checkRecipient({ worldId: "g01", to: "cliente@empresa-ficticia.ar" })).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED" });
    expect(kit.trail).toEqual([]);
  });
});

describe("SES client: failures and repeats never send twice [FL-011]", () => {
  it("retries a throttled send and records the id of the one that went", async () => {
    let calls = 0;
    const kit = emailKit({
      ses: async () => {
        calls += 1;
        if (calls < 3) throw throttled();
        return { MessageId: TEST_PROVIDER_ID };
      },
    });
    expect(await kit.client.send(sendRequest())).toMatchObject({ status: "SENT", providerMessageId: TEST_PROVIDER_ID });
    expect(calls).toBe(3);
  });

  it("does not retry another failure, closes the pending mail and reports it", async () => {
    let calls = 0;
    const kit = emailKit({
      ses: async () => {
        calls += 1;
        const error = new Error("refused");
        error.name = "MessageRejected";
        throw error;
      },
    });
    await expect(kit.client.send(sendRequest())).rejects.toMatchObject({ code: "SEND_FAILED", retryable: false });
    expect(calls).toBe(1);
    expect(await kit.connector.runtime.listPending("g01")).toEqual([]);
    expect((await kit.connector.emails.get(REF))?.providerMessageId).toBeUndefined();
  });

  it("returns the earlier send for the same mailId, and UNKNOWN_DELIVERY when its SES id was never recorded", async () => {
    const kit = emailKit();
    await kit.client.send(sendRequest());
    expect(await kit.client.send(sendRequest())).toMatchObject({ status: "SENT", providerMessageId: TEST_PROVIDER_ID, replayed: true });
    expect(kit.sent).toHaveLength(1);

    const failing = emailKit({
      ses: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(failing.client.send(sendRequest())).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await failing.client.send(sendRequest())).toEqual({ status: "UNKNOWN_DELIVERY", mailId: TEST_MAIL_ID });
    expect(failing.sent).toHaveLength(1);
  });
});
