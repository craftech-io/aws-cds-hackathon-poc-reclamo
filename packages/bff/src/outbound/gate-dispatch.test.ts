// Steps 5 to 9 of the gate and what surrounds them: `ALLOWED` before the transport, the `SEND#`
// claim, `UNKNOWN_DELIVERY` (never a blind resend), a redelivered request, the `DEFERRED_SEND` timer
// and its fire, the stored attachments and the daily email cap of a self-signup world.
import { ChannelError } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../lib/crypto";
import { DEFERRED_REF } from "./defer";
import { MAIL_CAP_PER_DAY, takeMailCap } from "./mail-cap";
import { VALERIA, call, customerWrote, gateRig, linesNamed, request, seedComplaint, tapeOf } from "./testing";
import { GATE_AUDIT, type OutboundRequest } from "./types";

const WROTE = "2026-10-07T10:05:00-03:00";
const ACK = (messageId?: string) => request("COMPLAINT_ACK", { text: "Registramos tu reclamo.", ...(messageId === undefined ? {} : { messageId }) });

/** The request a `DEFERRED_SEND` timer keeps (timers/events.ts `DeferredSendPayload`). */
function keptRequestOf(payload: unknown): OutboundRequest {
  return (payload as { request: unknown }).request as OutboundRequest;
}

async function readyRig(options: Parameters<typeof gateRig>[0] = {}) {
  const rig = await gateRig(options);
  await customerWrote(rig, VALERIA, WROTE);
  return rig;
}

describe("gate dispatch: tape and claim before the transport", () => {
  it("writes ALLOWED with the payload hash and takes the SEND# claim before the transport, DISPATCH SENT after", async () => {
    const rig = await readyRig();
    const seen: { decisions: string[]; claim: unknown }[] = [];
    rig.beforeWhatsApp = async () => {
      seen.push({ decisions: (await tapeOf(rig)).map((entry) => entry.decision), claim: await rig.kit.connector.claims.getSendClaim(rig.worldId, "msg-ack-1") });
    };
    const outcome = await rig.gate(ACK("msg-ack-1"), call(rig));
    expect(seen).toEqual([{ decisions: ["ALLOWED"], claim: expect.objectContaining({ messageId: "msg-ack-1" }) }]);
    expect((seen[0]?.claim as { providerMessageId?: string }).providerMessageId).toBeUndefined();
    const tape = await tapeOf(rig);
    expect(tape.map((entry) => [entry.decision, entry.result ?? null])).toEqual([
      ["ALLOWED", null],
      ["DISPATCH", "SENT"],
    ]);
    expect(tape[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tape[1]?.providerMessageId).toBe(outcome.ok && outcome.decision === "ALLOWED" ? outcome.providerMessageId : "missing");
    expect((await rig.kit.connector.claims.getSendClaim(rig.worldId, "msg-ack-1"))?.providerMessageId).toBe(tape[1]?.providerMessageId);
  });

  it("the payload hash is the SHA-256 of exactly what was rendered", async () => {
    const rig = await readyRig();
    await rig.gate(ACK("msg-ack-1"), call(rig));
    const [allowed] = await tapeOf(rig);
    const rendered = JSON.stringify({ text: "Registramos tu reclamo.", buttons: ["Hablar con alguien"] });
    expect(allowed?.payloadHash).toBe(sha256Hex(rendered));
  });

  it("a redelivered request with the same message id answers what was sent: no second transport, no new tape", async () => {
    const rig = await readyRig();
    const first = await rig.gate(ACK("msg-ack-1"), call(rig));
    const again = await rig.gate(ACK("msg-ack-1"), call(rig));
    expect(again).toMatchObject({ ok: true, decision: "ALLOWED", messageId: "msg-ack-1" });
    expect(again.ok && again.decision === "ALLOWED" && first.ok && first.decision === "ALLOWED" ? again.providerMessageId === first.providerMessageId : false).toBe(true);
    expect(rig.whatsappSent).toHaveLength(1);
    expect(await tapeOf(rig)).toHaveLength(2);
  });

  it("a claim already holding a provider id answers the earlier send without calling the transport", async () => {
    const rig = await readyRig();
    const { connector } = rig.kit;
    await connector.claims.claimSend(rig.worldId, "msg-ack-1", "WHATSAPP");
    await connector.write(connector.claims.recordSendOp(rig.worldId, "msg-ack-1", "wamid.SIM.earlier"));
    const outcome = await rig.gate(ACK("msg-ack-1"), call(rig));
    expect(outcome).toMatchObject({ ok: true, decision: "ALLOWED", providerMessageId: "wamid.SIM.earlier" });
    expect(rig.whatsappSent).toEqual([]);
  });

  it("a claim without a provider id (an attempt died after the send) is UNKNOWN_DELIVERY: never resent, a person checks it", async () => {
    const rig = await readyRig();
    await rig.kit.connector.claims.claimSend(rig.worldId, "msg-ack-1", "WHATSAPP");
    const outcome = await rig.gate(ACK("msg-ack-1"), call(rig));
    expect(outcome).toMatchObject({ ok: false, messageId: "msg-ack-1", failure: { error: { code: "UNKNOWN_DELIVERY" } } });
    expect(rig.whatsappSent).toEqual([]);
    expect((await rig.kit.connector.conversations.findMessage(rig.worldId, VALERIA, "msg-ack-1"))?.status).toBe("UNKNOWN_DELIVERY");
    expect(await rig.kit.connector.audit.listByAction(rig.worldId, GATE_AUDIT.UNKNOWN_DELIVERY)).toHaveLength(1);
    const retried = await rig.gate(ACK("msg-ack-1"), call(rig));
    expect(retried).toMatchObject({ ok: false, failure: { error: { code: "UNKNOWN_DELIVERY" } } });
    expect(rig.whatsappSent).toEqual([]);
  });

  it("a transport that timed out may have delivered: UNKNOWN_DELIVERY on the tape, the claim stays", async () => {
    const rig = await readyRig();
    rig.failWhatsApp = new ChannelError("TIMEOUT", "WHATSAPP", "the send timed out");
    const outcome = await rig.gate(ACK("msg-ack-1"), call(rig));
    expect(outcome).toMatchObject({ ok: false, failure: { error: { code: "UNKNOWN_DELIVERY" } } });
    expect((await tapeOf(rig)).map((entry) => [entry.decision, entry.result ?? null])).toEqual([
      ["ALLOWED", null],
      ["DISPATCH", "UNKNOWN_DELIVERY"],
    ]);
    expect(await rig.kit.connector.claims.getSendClaim(rig.worldId, "msg-ack-1")).toBeDefined();
  });

  it("a transport that refused before sending frees the claim: DISPATCH FAILED, and the event's retry sends", async () => {
    const rig = await readyRig();
    rig.failWhatsApp = new ChannelError("UNAVAILABLE", "WHATSAPP", "the provider refused");
    const outcome = await rig.gate(ACK("msg-ack-1"), call(rig));
    expect(outcome).toMatchObject({ ok: false, failure: { error: { code: "UNAVAILABLE" } } });
    expect((await tapeOf(rig)).at(-1)).toMatchObject({ decision: "DISPATCH", result: "FAILED" });
    expect(await rig.kit.connector.claims.getSendClaim(rig.worldId, "msg-ack-1")).toBeUndefined();
    expect(linesNamed(rig, "outbound.send_failed")).toHaveLength(1);
  });
});

describe("gate dispatch: a deferred send", () => {
  async function deferred() {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, "2026-10-07T20:30:00-03:00");
    await seedComplaint(rig);
    rig.simNow = "2026-10-07T21:00:00-03:00";
    const outcome = await rig.gate(request("COMPLAINT_UPDATE", { complaintId: "cmp-0001", text: "Hay una novedad en tu reclamo R-2026-000123." }), call(rig));
    return { rig, outcome };
  }

  it("outside contact hours is DEFERRED: tape with nextAllowedAt, a DEFERRED_SEND timer that keeps the request, the message waiting, nothing sent", async () => {
    const { rig, outcome } = await deferred();
    expect(outcome).toMatchObject({ ok: true, decision: "DEFERRED", ruleIds: ["CH-CONTACT-HOURS"], nextAllowedAt: "2026-10-08T08:00:00-03:00", deferredUntilText: "jueves 08/10 a las 08:00" });
    expect((await tapeOf(rig)).map((entry) => [entry.decision, entry.nextAllowedAt])).toEqual([["DEFERRED", "2026-10-08T08:00:00-03:00"]]);
    const [timer] = await rig.kit.connector.timers.listDue(rig.worldId, { untilSim: "2026-10-09T00:00:00-03:00" });
    expect(timer).toMatchObject({ kind: "DEFERRED_SEND", dueAtSim: "2026-10-08T08:00:00-03:00", ownerKey: "CMP#cmp-0001" });
    expect(keptRequestOf(timer?.payload)).toMatchObject({ messageId: outcome.messageId, refs: { [DEFERRED_REF.contentHash]: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect((await rig.kit.connector.conversations.findMessage(rig.worldId, VALERIA, outcome.messageId ?? ""))?.status).toBe("DEFERRED");
    expect(rig.whatsappSent).toEqual([]);
  });

  it("when its timer fires, the same message goes out once, without checking again the content it already passed", async () => {
    const { rig, outcome } = await deferred();
    const [timer] = await rig.kit.connector.timers.listDue(rig.worldId, { untilSim: "2026-10-09T00:00:00-03:00" });
    const kept = keptRequestOf(timer?.payload);
    const fired = { ...kept, refs: { ...kept.refs, [DEFERRED_REF.timerId]: timer?.timerId ?? "" } };
    rig.simNow = "2026-10-08T08:00:00-03:00";
    const g2Before = rig.g2.inputs.length;
    const sent = await rig.gate(fired, call(rig));
    expect(sent).toMatchObject({ ok: true, decision: "ALLOWED", messageId: outcome.messageId });
    expect(rig.g2.inputs).toHaveLength(g2Before);
    expect(rig.whatsappSent).toHaveLength(1);
    const again = await rig.gate(fired, call(rig));
    expect(again).toMatchObject({ ok: true, decision: "ALLOWED", messageId: outcome.messageId });
    expect(rig.whatsappSent).toHaveLength(1);
    expect((await tapeOf(rig)).map((entry) => entry.decision)).toEqual(["DEFERRED", "ALLOWED", "DISPATCH"]);
  });

  it("a redelivered request (not the timer) answers the deferral already decided", async () => {
    const { rig, outcome } = await deferred();
    const again = await rig.gate(request("COMPLAINT_UPDATE", { complaintId: "cmp-0001", messageId: outcome.messageId ?? "", text: "Hay una novedad en tu reclamo R-2026-000123." }), call(rig));
    expect(again).toMatchObject({ ok: true, decision: "DEFERRED", nextAllowedAt: "2026-10-08T08:00:00-03:00" });
    expect(await tapeOf(rig)).toHaveLength(1);
  });
});

describe("gate dispatch: email", () => {
  it("sends the acknowledgement with the stored PDF the request names, checked against its SHA-256", async () => {
    const rig = await gateRig();
    await seedComplaint(rig);
    const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
    rig.documents.set("W/demo/complaints/cmp-0001/ACK-1.pdf", pdf);
    const attachments = [{ docKind: "ACK" as const, s3Key: "W/demo/complaints/cmp-0001/ACK-1.pdf", sha256: sha256Hex(pdf) }];
    const outcome = await rig.gate(request("ACK_EMAIL", { channel: "EMAIL", complaintId: "cmp-0001", text: "Registramos tu reclamo R-2026-000123.", attachments }), call(rig));
    expect(outcome).toMatchObject({ ok: true, decision: "ALLOWED", mailId: expect.stringMatching(/^mail-[0-9a-f]{24}$/) });
    expect(rig.email.sent).toHaveLength(1);
    expect(rig.email.sent[0]?.Destination).toEqual({ ToAddresses: [`success+${VALERIA}@simulator.amazonses.com`] });
    const raw = new TextDecoder().decode(rig.email.sent[0]?.Content?.Raw?.Data);
    expect(raw).toContain("X-Reclamo-World: demo");
    expect(raw).toContain("R-2026-000123-ack.pdf");
  });

  it("refuses a stored document that is not the one the request names", async () => {
    const rig = await gateRig();
    await seedComplaint(rig);
    rig.documents.set("W/demo/complaints/cmp-0001/ACK-1.pdf", new TextEncoder().encode("%PDF-1.7 changed"));
    const attachments = [{ docKind: "ACK" as const, s3Key: "W/demo/complaints/cmp-0001/ACK-1.pdf", sha256: "0".repeat(64) }];
    await expect(rig.gate(request("ACK_EMAIL", { channel: "EMAIL", complaintId: "cmp-0001", text: "Registramos tu reclamo.", attachments }), call(rig))).rejects.toMatchObject({ code: "INVALID" });
    expect(rig.email.sent).toEqual([]);
  });
});

describe("gate dispatch: the daily email cap of a self-signup world [FL-125]", () => {
  const WORLD = "gs-abcdefghij";
  const ackEmail = () => request("ACK_EMAIL", { worldId: WORLD, channel: "EMAIL", complaintId: "cmp-0001", text: "Registramos tu reclamo R-2026-000123." });

  it("past 40 emails of the real day the email is BLOCKED on MAILCAP before the transport; the world clock moving does not open a new bucket [FL-125]", async () => {
    const rig = await gateRig({ worldId: WORLD });
    await seedComplaint(rig);
    for (let sent = 0; sent < MAIL_CAP_PER_DAY; sent += 1) expect(await takeMailCap(rig.kit.connector, WORLD, new Date("2026-10-07T13:10:00.000Z"))).toBe(true);
    rig.simNow = "2026-10-08T10:10:00-03:00";
    const outcome = await rig.gate(ackEmail(), call(rig));
    expect(outcome).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["MAILCAP"], failure: { error: { code: "UNAVAILABLE", reason: "MAILCAP" } } });
    expect(rig.email.sent).toEqual([]);
    expect(linesNamed(rig, "outbound.mail_cap")).toEqual([expect.objectContaining({ metric: "GuestMailCapHits" })]);
  });

  it("counts each email that goes out, and never one that was blocked before [FL-125]", async () => {
    const rig = await gateRig({ worldId: WORLD });
    await seedComplaint(rig);
    for (let sent = 0; sent < MAIL_CAP_PER_DAY - 1; sent += 1) await takeMailCap(rig.kit.connector, WORLD, new Date("2026-10-07T13:10:00.000Z"));
    const foreign = await rig.gate(request("ACK_EMAIL", { worldId: WORLD, channel: "EMAIL", complaintId: "cmp-0001", text: "Llamanos al 11 5555-0000." }), call(rig));
    expect(foreign).toMatchObject({ ok: false, decision: "BLOCKED", ruleIds: ["CH-NO-FOREIGN-LINKS"] });
    expect(await rig.gate(ackEmail(), call(rig))).toMatchObject({ ok: true, decision: "ALLOWED" });
    expect(await rig.gate({ ...ackEmail(), messageId: "msg-second" }, call(rig))).toMatchObject({ ok: false, ruleIds: ["MAILCAP"] });
    expect(rig.email.sent).toHaveLength(1);
  });

  it("an invited guest world and the demo world are not counted here", async () => {
    for (const worldId of ["g07", "demo"]) {
      expect(await takeMailCap({ write: async () => { throw new Error("must not count"); } } as never, worldId, new Date())).toBe(true);
    }
  });
});
