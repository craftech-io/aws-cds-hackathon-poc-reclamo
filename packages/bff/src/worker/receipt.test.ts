// What the worker does with an image MediaIntake or InboundWhatsApp handed over (docs/architecture-
// integrations.md §9): `RECEIPT_RECEIVED` files the `RECEIPT_IMAGE` evidence in the open complaint
// before the turn (MediaIntake cannot write Complaints), once per message; `MEDIA_REJECTED` answers the
// fixed reply its payload names.
import { describe, expect, it } from "vitest";
import { WHATSAPP_TEXT } from "../copy";
import { receiptImageEvidenceId } from "../media-intake/intake";
import { eventOf, recordOf, workerKit } from "./testing";
import { processRecord } from "./worker";

const AT = "2026-10-07T10:10:00-03:00";
const image = { s3Key: "up/demo/m/msg-0003.png", sha256: "a".repeat(64), contentType: "image/png" as const, sizeBytes: 120_000, width: 900, height: 1400, scan: "NO_THREATS_FOUND" as const, messageId: "msg-0003", source: "SIMULATOR" as const };

describe("RECEIPT_RECEIVED [FL-029]", () => {
  it("[FL-029] files the image as RECEIPT_IMAGE evidence of the customer's open complaint, then runs the turn with its line", async () => {
    const kit = await workerKit();
    const complaint = await kit.addComplaint({ status: "AWAITING_CUSTOMER" });
    await kit.addInbound("msg-0003", "acá va el comprobante");
    const event = eventOf("RECEIPT_RECEIVED", { messageId: "msg-0003", messageAtSim: AT, image });
    expect(await processRecord(kit.deps, recordOf(event))).toBe("PROCESSED");
    const evidence = await kit.connector.caseItems.getEvidence("demo", complaint.complaintId, receiptImageEvidenceId("msg-0003"));
    expect(evidence).toMatchObject({ kind: "RECEIPT_IMAGE", actor: "SYSTEM", details: { s3Key: image.s3Key, sha256: image.sha256 } });
    expect((await kit.connector.complaints.get("demo", complaint.complaintId, { consistent: true }))?.status).toBe("INVESTIGATING");
    expect(kit.harness.requests).toHaveLength(1);
    expect(kit.harness.requests[0]?.envelope).toContain(`evidenceId="${receiptImageEvidenceId("msg-0003")}"`);
    // A redelivery files nothing new.
    await processRecord(kit.deps, recordOf({ ...event, eventId: "evt-receipt-again" }));
    expect((await kit.connector.caseItems.listEvidence("demo", complaint.complaintId)).filter((item) => item.kind === "RECEIPT_IMAGE")).toHaveLength(1);
  });

  it("[FL-029] prefers the complaint the intake named, when it is still open", async () => {
    const kit = await workerKit();
    const named = await kit.addComplaint({ status: "INVESTIGATING", filedAtSim: "2026-10-01T10:00:00-03:00" });
    const newer = await kit.addComplaint({ status: "INVESTIGATING", filedAtSim: "2026-10-06T10:00:00-03:00" });
    await kit.addInbound("msg-0003", "");
    await processRecord(kit.deps, recordOf(eventOf("RECEIPT_RECEIVED", { messageId: "msg-0003", messageAtSim: AT, image, complaintId: named.complaintId })));
    expect(await kit.connector.caseItems.getEvidence("demo", named.complaintId, receiptImageEvidenceId("msg-0003"))).toBeDefined();
    expect(await kit.connector.caseItems.getEvidence("demo", newer.complaintId, receiptImageEvidenceId("msg-0003"))).toBeUndefined();
  });

  it("[FL-029] without an open complaint the image stays on the conversation and no second turn runs", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "CLOSED" });
    await kit.addInbound("msg-0003", "");
    expect(await processRecord(kit.deps, recordOf(eventOf("RECEIPT_RECEIVED", { messageId: "msg-0003", messageAtSim: AT, image })))).toBe("PROCESSED");
    expect(kit.harness.requests).toHaveLength(0);
  });
});

describe("MEDIA_REJECTED [FL-029]", () => {
  it("[FL-029] an image above 3.75 MB gets the 'lighter photo' reply its payload names, without a turn", async () => {
    const kit = await workerKit();
    await processRecord(kit.deps, recordOf(eventOf("MEDIA_REJECTED", { messageId: "msg-0004", reason: "TOO_LARGE", reply: "MEDIA_TOO_LARGE" })));
    expect(kit.harness.requests).toHaveLength(0);
    expect(kit.gate.requests).toMatchObject([{ sender: "SYSTEM", channel: "WHATSAPP", text: WHATSAPP_TEXT.MEDIA_TOO_LARGE }]);
  });
});
