import { describe, expect, it } from "vitest";
import { ToolError } from "@reclamo/shared";
import { complaint, evidence, testConnector } from "../connector/testing";
import { sha256Hex } from "../lib/crypto";
import type { BedrockReading } from "./bedrock-reader";
import { IMAGE_READ_CAPS, type ReadBudget, connectorReadBudget } from "./budget";
import { SEED_RECEIPT_HASH_REFERENCE } from "./seed-hash";
import { type ImageStore, type ReadReceiptRequest, readReceiptEvidence } from "./service";
import { SUR_FIELDS, clearReading, png, receiptPng, scriptedBedrock, testLog } from "./testing";

type EvidenceDetails = NonNullable<Parameters<typeof evidence>[1]>["details"];

const SIM_NOW = new Date("2026-10-07T10:10:00-03:00");
const BYTES = receiptPng(SUR_FIELDS);
const KEY = "up/g07/wa-in-7/0.png";

function memoryImages(objects: Record<string, Uint8Array>): ImageStore {
  return { get: async (location, maxBytes) => (objects[`${location.bucket}:${location.key}`] === undefined ? undefined : (objects[`${location.bucket}:${location.key}`]?.length ?? 0) > maxBytes ? "TOO_LARGE" : objects[`${location.bucket}:${location.key}`]) };
}

const allow: ReadBudget = { admit: async () => ({ ok: true }) };

async function setup(options: { answers?: BedrockReading[]; budget?: ReadBudget; images?: Record<string, Uint8Array>; details?: EvidenceDetails; worldId?: string } = {}) {
  const worldId = options.worldId ?? "g07";
  const mc = testConnector();
  await mc.connector.write(mc.connector.complaints.createOp(complaint(worldId, { complaintId: "cmp-0004", customerId: "cus-0004", complaintNumber: "R-2026-000124" })));
  await mc.connector.caseItems.putEvidence(
    evidence(worldId, { complaintId: "cmp-0004", evidenceId: "evd-img-wa-in-7", kind: "RECEIPT_IMAGE", actor: "SYSTEM", details: options.details ?? { s3Key: KEY, sha256: sha256Hex(BYTES), contentType: "image/png", sizeBytes: BYTES.length, scan: "NO_THREATS_FOUND", messageId: "wa-in-7" } }),
  );
  const bedrock = scriptedBedrock(...(options.answers ?? [{ kind: "READ", raw: clearReading() }]));
  const { log, lines } = testLog();
  let n = 0;
  const deps = {
    connector: mc.connector,
    images: memoryImages(options.images ?? { [`Media:${KEY}`]: BYTES }),
    budget: options.budget ?? allow,
    bedrock,
    log,
    now: () => new Date("2026-10-07T13:10:00.000Z"),
    newId: () => `id${(n += 1)}`,
  };
  const request: ReadReceiptRequest = { worldId, epoch: 1, complaintId: "cmp-0004", customerId: "cus-0004", evidenceId: "evd-img-wa-in-7", simNow: SIM_NOW, turnId: "turn-1" };
  return { mc, deps, request, bedrock, lines };
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ToolError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("read_receipt below its fences [FL-019] [FL-027] [FL-028]", () => {
  it("[FL-028] reads a clean image of the complaint and files a RECEIPT_READING without the image nor Bedrock's notes", async () => {
    const { mc, deps, request } = await setup({ answers: [{ kind: "READ", raw: clearReading({ notes: "texto impreso" }) }] });
    const response = await readReceiptEvidence(deps, request);
    expect(response).toMatchObject({ result: "READ", readingId: "rdg-id1", source: "BOTH_AGREE", attemptsLeft: 2, suspiciousText: false });
    const reading = await mc.connector.caseItems.getEvidence("g07", "cmp-0004", "evd-rdg-id1");
    expect(reading).toMatchObject({ kind: "RECEIPT_READING", refId: "rdg-id1", actor: "AGENT", turnId: "turn-1", details: { result: "READ", imageEvidenceId: "evd-img-wa-in-7" } });
    expect(JSON.stringify(reading)).not.toContain("texto impreso");
  });

  it("[FL-028] a payer reference with a DNI, a CUIT or a CBU is masked in the evidence and in the tool output", async () => {
    const printed = "DNI 30.123.456 / CUIT 20-30123456-7";
    const { mc, deps, request } = await setup({ answers: [{ kind: "READ", raw: clearReading({ payerReference: printed }) }] });
    const response = await readReceiptEvidence(deps, request);
    expect(response.result).toBe("READ");
    const reading = await mc.connector.caseItems.getEvidence("g07", "cmp-0004", "evd-rdg-id1");
    for (const secret of ["30.123.456", "30123456", "20-30123456-7"]) {
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(JSON.stringify(reading)).not.toContain(secret);
    }
    expect(response.fields?.payerReference).toContain("[DNI]");
  });

  it("[FL-028] a suspicious image is audited SUSPICIOUS_RECEIPT_TEXT and the reading goes on", async () => {
    const { mc, deps, request } = await setup({ answers: [{ kind: "READ", raw: clearReading({ suspiciousText: true }) }] });
    expect(await readReceiptEvidence(deps, request)).toMatchObject({ result: "READ", suspiciousText: true });
    const audit = await mc.connector.audit.listByAction("g07", "SUSPICIOUS_RECEIPT_TEXT");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "AGENT", refs: { complaintId: "cmp-0004", readingId: "rdg-id1" } });
  });

  it("[FL-019] two unreadable photos leave no attempt: the second one goes to a person", async () => {
    const { deps, request } = await setup({ answers: [{ kind: "READ", raw: { isReceipt: true, legibility: "ILLEGIBLE", suspiciousText: false } }] });
    expect(await readReceiptEvidence(deps, request)).toMatchObject({ result: "UNREADABLE", attemptsLeft: 1 });
    expect(await readReceiptEvidence(deps, request)).toMatchObject({ result: "UNREADABLE", attemptsLeft: 0 });
    expect("fields" in (await readReceiptEvidence(deps, request))).toBe(false);
  });

  it("only a RECEIPT_IMAGE of this complaint is read", async () => {
    const { deps, request } = await setup();
    await rejects(readReceiptEvidence(deps, { ...request, evidenceId: "evd-other" }), "NOT_FOUND");
    await rejects(readReceiptEvidence(deps, { ...request, complaintId: "cmp-0001" }), "NOT_FOUND");
  });

  it("an image whose bytes changed after the scan is not read, nor one over the limits", async () => {
    const changed = await setup({ images: { [`Media:${KEY}`]: png() } });
    await rejects(readReceiptEvidence(changed.deps, changed.request), "EVIDENCE_REQUIRED");
    expect(changed.bedrock.calls).toBe(0);
    const big = await setup({ images: { [`Media:${KEY}`]: new Uint8Array(3_932_161) } });
    await rejects(readReceiptEvidence(big.deps, big.request), "INVALID");
  });

  it("a seed receipt is read from Seed only when its hash is a known synthetic receipt", async () => {
    const seedKey = "receipts/legible/c04-1.png";
    const details = { seedKey, sha256: sha256Hex(BYTES), contentType: "image/png" };
    const unknown = await setup({ details, images: { [`Seed:${seedKey}`]: BYTES } });
    await rejects(readReceiptEvidence(unknown.deps, unknown.request), "EVIDENCE_REQUIRED");
    const known = await setup({ details, images: { [`Seed:${seedKey}`]: BYTES } });
    await known.mc.store.write({ kind: "put", table: "Reference", item: { pk: `REF#${SEED_RECEIPT_HASH_REFERENCE.type}#${SEED_RECEIPT_HASH_REFERENCE.scope}`, sk: sha256Hex(BYTES), sha256: sha256Hex(BYTES), seedKey } });
    expect(await readReceiptEvidence(known.deps, known.request)).toMatchObject({ result: "READ" });
  });

  it("the budget refuses before Bedrock: kill switch → AGENT_KILLED, cap → TURN_CAP; forceFallback spends nothing", async () => {
    const killed = await setup({ budget: { admit: async () => ({ ok: false, code: "AGENT_KILLED", reason: "KILL_SWITCH" }) } });
    await rejects(readReceiptEvidence(killed.deps, killed.request), "AGENT_KILLED");
    expect(killed.bedrock.calls).toBe(0);
    const capped = await setup({ budget: { admit: async () => ({ ok: false, code: "TURN_CAP", reason: "IMAGE_READS_WORLD" }) } });
    await rejects(readReceiptEvidence(capped.deps, capped.request), "TURN_CAP");
    const forced = await setup({ worldId: "qa-r1-sc03", budget: { admit: async () => ({ ok: false, code: "TURN_CAP", reason: "x" }) } });
    expect(await readReceiptEvidence(forced.deps, { ...forced.request, forceFallback: true })).toMatchObject({ result: "READ", source: "FALLBACK" });
    // Outside a QA world the flag is ignored: the budget still decides before Bedrock.
    const notQa = await setup({ budget: { admit: async () => ({ ok: false, code: "TURN_CAP", reason: "x" }) } });
    await rejects(readReceiptEvidence(notQa.deps, { ...notQa.request, forceFallback: true }), "TURN_CAP");
    expect(notQa.bedrock.calls).toBe(0);
  });

  it("[FL-027] Bedrock unavailable and no chunk: UNAVAILABLE, nothing filed", async () => {
    const plain = png();
    const { mc, deps, request } = await setup({ answers: [{ kind: "UNAVAILABLE", reason: "TIMEOUT", attempts: 3 }], images: { [`Media:${KEY}`]: plain }, details: { s3Key: KEY, sha256: sha256Hex(plain), contentType: "image/png", sizeBytes: plain.length, scan: "NO_THREATS_FOUND" } });
    await rejects(readReceiptEvidence(deps, request), "UNAVAILABLE");
    expect((await mc.connector.caseItems.listEvidence("g07", "cmp-0004")).filter((item) => item.kind === "RECEIPT_READING")).toHaveLength(0);
  });

  it("the same receipt already read in another open complaint of the customer is DUPLICATE_OF its number", async () => {
    const { mc, deps, request } = await setup();
    await mc.connector.write(mc.connector.complaints.createOp(complaint("g07", { complaintId: "cmp-0017", customerId: "cus-0004", complaintNumber: "R-2026-000117", status: "HUMAN_REVIEW", filedAtSim: "2026-10-06T10:10:00-03:00" })));
    await mc.connector.caseItems.putEvidence(evidence("g07", { complaintId: "cmp-0017", evidenceId: "evd-0017-read", refId: "rdg-0017", details: { result: "READ", source: "BOTH_AGREE", fields: { network: "SUR", operationCode: SUR_FIELDS.operationCode, amount: 11_864_000, paidAtLocal: SUR_FIELDS.paidAtLocal } } }));
    expect(await readReceiptEvidence(deps, request)).toMatchObject({ result: "DUPLICATE_OF", duplicateOf: "R-2026-000117", fields: { operationCode: SUR_FIELDS.operationCode } });
  });
});

describe("budget of image reads on the real clock", () => {
  const signupPool = (allowed: boolean) => async () => allowed;

  it("counts per conversation, per guest world and in the global pool; the kill switch comes first", async () => {
    const mc = testConnector();
    let now = new Date("2026-10-07T13:00:00.000Z");
    const budget = connectorReadBudget({ connector: mc.connector, now: () => now, signupImagePool: signupPool(true), log: testLog().log });
    for (let i = 0; i < IMAGE_READ_CAPS.perConversationPerDay; i += 1) expect(await budget.admit({ worldId: "g07", customerId: "cus-0004" })).toEqual({ ok: true });
    expect(await budget.admit({ worldId: "g07", customerId: "cus-0004" })).toMatchObject({ ok: false, code: "TURN_CAP", reason: "IMAGE_READS_CONVERSATION" });
    // A new REAL day opens a new bucket; the simulated clock never does.
    now = new Date("2026-10-08T13:00:00.000Z");
    expect(await budget.admit({ worldId: "g07", customerId: "cus-0004" })).toEqual({ ok: true });
    await mc.connector.runtime.setKill({ worldId: "g07", on: true, by: "SYSTEM", atReal: now.toISOString() });
    expect(await budget.admit({ worldId: "g07", customerId: "cus-0005" })).toMatchObject({ ok: false, code: "AGENT_KILLED" });
  });

  it("a guest world has its own daily cap and a self-signup world asks its pool", async () => {
    const mc = testConnector();
    const now = new Date("2026-10-07T13:00:00.000Z");
    await mc.connector.caps.set({ kind: "IMGCAP", worldId: "g07", customerId: "ALL", at: now }, IMAGE_READ_CAPS.invitedGuestWorldPerDay);
    const budget = connectorReadBudget({ connector: mc.connector, now: () => now, signupImagePool: signupPool(false), log: testLog().log });
    expect(await budget.admit({ worldId: "g07", customerId: "cus-0004" })).toMatchObject({ ok: false, reason: "IMAGE_READS_WORLD" });
    expect(await budget.admit({ worldId: "gs-abcdefghij", customerId: "cus-0004" })).toMatchObject({ ok: false, reason: "GLOBAL_SIGNUP_IMAGES" });
    await mc.connector.caps.set({ kind: "GLOBALCAP", pool: "PUBLIC", window: "DAY", at: now }, IMAGE_READ_CAPS.public.perDay);
    expect(await budget.admit({ worldId: "demo", customerId: "cus-0004" })).toMatchObject({ ok: false, reason: "GLOBAL_PUBLIC_DAY" });
    expect(await budget.admit({ worldId: "qa-r1-sc03", customerId: "cus-0004" })).toEqual({ ok: true });
  });
});
