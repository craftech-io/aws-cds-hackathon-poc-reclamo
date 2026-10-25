import { describe, expect, it } from "vitest";
import type { CustomerSpec } from "@reclamo/core-mock/ledger/testing";
import type { BedrockReading } from "../../receipts/bedrock-reader";
import { RawReading, ReceiptReadingDetails } from "../../receipts/schema";
import { CUSTOMER, WORLD, monthlyInstalments } from "../account/testing";
import { clearReading, codeOf, investigationKit, okOf, operationCode, tinyPng } from "./testing";

const CODE = operationCode("NTE", "20261006", "004817");
const RECEIPT = { network: "NORTE", operationCode: CODE, amountPesos: 118_640, paidAtLocal: "2026-10-06T18:40" };
const CUSTOMER_SPEC: CustomerSpec = { customerId: CUSTOMER, loans: [{ loanId: "L-0001", principal: 60_000_000, instalments: monthlyInstalments() }] };
const ILLEGIBLE: BedrockReading = { kind: "READ", raw: RawReading.parse({ isReceipt: true, legibility: "ILLEGIBLE", suspiciousText: false }) };

async function setup() {
  const kit = await investigationKit([CUSTOMER_SPEC], { type: "PAYMENT_NOT_REFLECTED" });
  await kit.addReceiptImage("evd-img-1");
  return kit;
}

async function readings(kit: Awaited<ReturnType<typeof setup>>) {
  return (await kit.connector.caseItems.listEvidence(WORLD, kit.complaint.complaintId)).filter((item) => item.kind === "RECEIPT_READING").map((item) => ReceiptReadingDetails.parse(item.details));
}

describe("[FL-019] blurry receipt", () => {
  it("[FL-019] a legible receipt is READ with its validated fields as text; the image never comes back and the reading is an evidence", async () => {
    const kit = await setup();
    kit.bedrockAnswers.push(clearReading(RECEIPT));
    const answer = okOf(await kit.call("read_receipt", { evidenceId: "evd-img-1" }));
    expect(answer).toMatchObject({
      result: "READ",
      source: "BEDROCK",
      fields: { network: "NORTE", operationCode: CODE, amount: { amount: 118_640, text: "$ 118.640,00" }, paidAtText: "martes 06/10 18:40" },
      attemptsLeft: 2,
    });
    expect(JSON.stringify(answer)).not.toMatch(/s3Key|sha256|up\/qa-tools/);
    const [reading] = await readings(kit);
    expect(reading).toMatchObject({ result: "READ", imageEvidenceId: "evd-img-1", fields: { operationCode: CODE, amount: 11_864_000 } });
    const stored = (await kit.connector.caseItems.listEvidence(WORLD, kit.complaint.complaintId)).find((item) => item.kind === "RECEIPT_READING");
    expect(stored).toMatchObject({ refId: answer["readingId"], evidenceId: answer["evidenceId"] });
    expect((await kit.auditRows()).find((row) => row.action === "READ_RECEIPT")).toMatchObject({ outcome: "READ", refs: { readingId: answer["readingId"] } });
  });

  it("[FL-019] an illegible photo is UNREADABLE twice from Bedrock (never the fallback); the second leaves no attempts and the tool hands nothing over itself", async () => {
    const kit = await setup();
    await kit.addReceiptImage("evd-img-2", tinyPng(7));
    kit.bedrockAnswers.push(ILLEGIBLE);
    expect(okOf(await kit.call("read_receipt", { evidenceId: "evd-img-1" }))).toMatchObject({ result: "UNREADABLE", source: "BEDROCK", attemptsLeft: 1 });
    const second = okOf(await kit.call("read_receipt", { evidenceId: "evd-img-2" }));
    expect(second).toMatchObject({ result: "UNREADABLE", source: "BEDROCK", attemptsLeft: 0 });
    expect(second).not.toHaveProperty("fields");
    expect((await readings(kit)).map((reading) => [reading.result, reading.source])).toEqual([
      ["UNREADABLE", "BEDROCK"],
      ["UNREADABLE", "BEDROCK"],
    ]);
    expect((await kit.connector.complaints.get(WORLD, kit.complaint.complaintId))?.status).toBe("INVESTIGATING");
    expect(kit.gate.requests).toEqual([]);
  });

  it("[FL-019] only the complaint's RECEIPT_IMAGE can be read: a reading id, an evidence of another complaint or an extra key are refused", async () => {
    const kit = await setup();
    await kit.addComplaint({ complaintId: "cmp-other", complaintNumber: "R-2026-000077" });
    await kit.addReceiptImage("evd-img-other", tinyPng(3), "cmp-other");
    await kit.addEvidence({ evidenceId: "evd-reading", kind: "RECEIPT_READING", details: { result: "READ", source: "BEDROCK", suspiciousText: false } });
    expect(codeOf(await kit.call("read_receipt", { evidenceId: "evd-reading" }))).toBe("EVIDENCE_REQUIRED");
    expect(codeOf(await kit.call("read_receipt", { evidenceId: "evd-img-other" }))).toBe("FORBIDDEN");
    expect(codeOf(await kit.call("read_receipt", { evidenceId: "evd-img-1", s3Key: "up/qa-tools/other.png" }))).toBe("INVALID");
    expect(kit.bedrockAnswers).toEqual([]);
  });

  it("[FL-019] with the agent cut nothing is read (AGENT_KILLED); Bedrock unavailable and no fallback chunk is UNAVAILABLE", async () => {
    const kit = await setup();
    await kit.connector.runtime.setKill({ worldId: WORLD, on: true, by: "SYSTEM", atReal: new Date().toISOString() });
    expect(codeOf(await kit.call("read_receipt", { evidenceId: "evd-img-1" }))).toBe("AGENT_KILLED");
    await kit.connector.runtime.setKill({ worldId: WORLD, on: false, by: "SYSTEM", atReal: new Date().toISOString() });
    expect(codeOf(await kit.call("read_receipt", { evidenceId: "evd-img-1" }))).toBe("UNAVAILABLE");
    expect(await readings(kit)).toEqual([]);
  });
});

describe("[FL-021] the same receipt in two complaints", () => {
  it("[FL-021] a receipt already read in another open complaint of the customer is DUPLICATE_OF with that complaint's number", async () => {
    const kit = await setup();
    await kit.addComplaint({ complaintId: "cmp-first", complaintNumber: "R-2026-000050", status: "INVESTIGATING" });
    await kit.addEvidence({
      complaintId: "cmp-first",
      evidenceId: "evd-first-reading",
      kind: "RECEIPT_READING",
      refId: "rdg-first",
      details: { result: "READ", source: "BEDROCK", suspiciousText: false, fields: { network: "NORTE", operationCode: CODE, amount: 11_864_000, paidAtLocal: "2026-10-06T18:40" } },
    });
    kit.bedrockAnswers.push(clearReading(RECEIPT));
    const answer = okOf(await kit.call("read_receipt", { evidenceId: "evd-img-1" }));
    expect(answer).toMatchObject({ result: "DUPLICATE_OF", duplicateOf: "R-2026-000050", fields: { operationCode: CODE } });
    expect((await readings(kit))[0]).toMatchObject({ result: "DUPLICATE_OF", duplicateOf: "R-2026-000050" });
  });
});
