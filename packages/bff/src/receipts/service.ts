// `read_receipt` below its fences (docs/architecture-integrations.md §7, step 1; docs/tool-catalog.md):
// the investigation tool (WP-28) resolves the session, the identification and the complaint, then
// calls this. It loads the `RECEIPT_IMAGE` evidence OF THAT complaint (never a key of the input),
// checks that the image was scanned clean (or is a seed receipt whose hash is known), its magic
// number, size and dimensions, asks the budget before Bedrock, reads, and leaves a `RECEIPT_READING`
// evidence. The image never travels back; Bedrock's notes are dropped; the fields are never logged.
import { type ReceiptResult, ToolError, worldKindOf } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import type { Evidence } from "../domain/case-items";
import { INBOX_CLOSED_STATUSES } from "../domain/complaint";
import { sha256Hex, ulid } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { ReadBudget } from "./budget";
import { inspectImage } from "./image";
import { type ReaderDeps, type ReaderOutcome, isUnavailable, readReceiptImage } from "./reader";
import { MAX_IMAGE_BYTES, type ReceiptFields, ReceiptImageDetails, ReceiptReadingDetails } from "./schema";
import { isSeedReceiptHash } from "./seed-hash";

/** Readings that ask for another photo; the second one goes to a person (`RECEIPT_DOUBT`). */
export const MAX_UNREADABLE_READINGS = 2;

export interface ImageLocation {
  readonly bucket: "Media" | "Seed";
  readonly key: string;
}

/** Reads an image object: `undefined` when it is gone, `TOO_LARGE` above `maxBytes` (never downloaded whole). */
export interface ImageStore {
  get(location: ImageLocation, maxBytes: number): Promise<Uint8Array | "TOO_LARGE" | undefined>;
}

export interface ReceiptServiceDeps extends ReaderDeps {
  readonly connector: Pick<Connector, "caseItems" | "complaints" | "audit" | "reference">;
  readonly images: ImageStore;
  readonly budget: ReadBudget;
  /** Real clock: ids and audit stamps. */
  readonly now: () => Date;
  readonly log: Logger;
  readonly newId?: () => string;
}

export interface ReadReceiptRequest {
  readonly worldId: string;
  readonly epoch: number;
  readonly complaintId: string;
  readonly customerId: string;
  readonly evidenceId: string;
  /** The world's simulated "now". */
  readonly simNow: Date;
  readonly turnId?: string;
  readonly forceFallback?: boolean;
}

export interface ReadReceiptResponse {
  readonly result: ReceiptResult;
  readonly readingId: string;
  readonly readingEvidenceId: string;
  readonly source: ReaderOutcome["source"];
  readonly fields?: ReceiptFields;
  readonly suspiciousText: boolean;
  readonly duplicateOf?: string;
  readonly attemptsLeft: number;
}

const ASKS_FOR_ANOTHER_PHOTO: ReadonlySet<ReceiptResult> = new Set<ReceiptResult>(["UNREADABLE", "NOT_A_RECEIPT"]);

function details(evidence: Evidence): ReceiptReadingDetails | undefined {
  const parsed = ReceiptReadingDetails.safeParse(evidence.details);
  return parsed.success ? parsed.data : undefined;
}

/** The image of the evidence, checked: clean scan or known seed hash, the stored hash, and §6's limits. */
async function loadImage(deps: ReceiptServiceDeps, evidence: Evidence) {
  const parsed = ReceiptImageDetails.safeParse(evidence.details);
  if (!parsed.success) throw new ToolError("EVIDENCE_REQUIRED", "the evidence is not a readable receipt image");
  const image = parsed.data;
  const seedOnly = "seedKey" in image;
  if (seedOnly || image.scan === "SEED_SKIPPED") {
    if (!(await isSeedReceiptHash(deps.connector, image.sha256))) throw new ToolError("EVIDENCE_REQUIRED", "the image was not scanned and is not a known synthetic receipt");
  }
  const location: ImageLocation = seedOnly ? { bucket: "Seed", key: image.seedKey } : { bucket: "Media", key: image.s3Key };
  const bytes = await deps.images.get(location, MAX_IMAGE_BYTES);
  if (bytes === undefined) throw new ToolError("NOT_FOUND", "the receipt image is no longer available");
  if (bytes === "TOO_LARGE") throw new ToolError("INVALID", "the receipt image is too large to read");
  // The object must still be the one that was scanned (or the seed rendered).
  if (sha256Hex(bytes) !== image.sha256) throw new ToolError("EVIDENCE_REQUIRED", "the receipt image changed after it was checked");
  const check = inspectImage(bytes);
  if (!check.ok) throw new ToolError("INVALID", `the receipt image cannot be read (${check.problem})`);
  return { bytes, contentType: check.contentType };
}

/** The number of another OPEN complaint of the customer that already holds a reading of this code. */
export async function findDuplicateOf(connector: Pick<Connector, "complaints" | "caseItems">, request: Pick<ReadReceiptRequest, "worldId" | "customerId" | "complaintId">, fields: ReceiptFields): Promise<string | undefined> {
  const complaints = await connector.complaints.listByCustomer(request.worldId, request.customerId);
  for (const complaint of complaints) {
    if (complaint.complaintId === request.complaintId || INBOX_CLOSED_STATUSES.has(complaint.status)) continue;
    const evidence = await connector.caseItems.listEvidence(request.worldId, complaint.complaintId);
    const seen = evidence.some((item) => {
      if (item.kind !== "RECEIPT_READING") return false;
      const reading = details(item);
      return reading?.fields?.operationCode === fields.operationCode && reading.fields.network === fields.network && (reading.result === "READ" || reading.result === "DUPLICATE_OF");
    });
    if (seen) return complaint.complaintNumber;
  }
  return undefined;
}

export async function readReceiptEvidence(deps: ReceiptServiceDeps, request: ReadReceiptRequest): Promise<ReadReceiptResponse> {
  const evidence = await deps.connector.caseItems.getEvidence(request.worldId, request.complaintId, request.evidenceId);
  if (evidence === undefined) throw new ToolError("NOT_FOUND", "no such evidence in this complaint");
  if (evidence.kind !== "RECEIPT_IMAGE") throw new ToolError("EVIDENCE_REQUIRED", "the evidence is not a receipt image");
  const { bytes, contentType } = await loadImage(deps, evidence);

  // `receipt.forceFallback` exists only in QA worlds: anywhere else Bedrock is asked, and budgeted.
  const forced = request.forceFallback === true && worldKindOf(request.worldId) === "QA";
  if (!forced) {
    const verdict = await deps.budget.admit({ worldId: request.worldId, customerId: request.customerId });
    if (!verdict.ok) throw new ToolError(verdict.code, "the receipt cannot be read now", verdict.reason);
  }
  const outcome = await readReceiptImage({ worldId: request.worldId, bytes, contentType, simNow: request.simNow, forceFallback: forced }, deps);
  if (isUnavailable(outcome)) throw new ToolError("UNAVAILABLE", "the receipt reader is not available right now", outcome.reason);

  const duplicateOf = outcome.result === "READ" && outcome.fields ? await findDuplicateOf(deps.connector, request, outcome.fields) : undefined;
  const result: ReceiptResult = duplicateOf === undefined ? outcome.result : "DUPLICATE_OF";
  const now = deps.now();
  const id = deps.newId?.() ?? ulid(now.getTime());
  const readingId = `rdg-${id}`;
  const readingEvidenceId = `evd-rdg-${id}`;
  const record: ReceiptReadingDetails = ReceiptReadingDetails.parse({
    result,
    source: outcome.source,
    ...(outcome.fields ? { fields: outcome.fields } : {}),
    ...(outcome.problem ? { problem: outcome.problem } : {}),
    suspiciousText: outcome.suspiciousText,
    imageEvidenceId: request.evidenceId,
    ...(outcome.bedrock ? { bedrock: outcome.bedrock } : {}),
    ...(outcome.fallback ? { fallback: outcome.fallback } : {}),
    ...(outcome.disagreement ? { disagreement: outcome.disagreement } : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
    readAtReal: now.toISOString(),
  });
  const previous = (await deps.connector.caseItems.listEvidence(request.worldId, request.complaintId)).filter((item) => {
    const reading = item.kind === "RECEIPT_READING" ? details(item) : undefined;
    return reading !== undefined && ASKS_FOR_ANOTHER_PHOTO.has(reading.result);
  }).length;
  await deps.connector.caseItems.putEvidence({
    worldId: request.worldId,
    complaintId: request.complaintId,
    evidenceId: readingEvidenceId,
    kind: "RECEIPT_READING",
    refId: readingId,
    atSim: request.simNow.toISOString(),
    actor: "AGENT",
    ...(request.turnId ? { turnId: request.turnId } : {}),
    details: JSON.parse(JSON.stringify(record)),
  });
  if (outcome.suspiciousText) await auditSuspicious(deps, request, readingId, now);
  deps.log.info("receipts.read", { worldId: request.worldId, complaintId: request.complaintId, result, source: outcome.source, suspicious: outcome.suspiciousText });
  const unreadable = previous + (ASKS_FOR_ANOTHER_PHOTO.has(result) ? 1 : 0);
  return {
    result,
    readingId,
    readingEvidenceId,
    source: outcome.source,
    // A field the code did not validate, or one of a disagreement, never leaves.
    ...(result === "READ" || result === "DUPLICATE_OF" ? (outcome.fields ? { fields: outcome.fields } : {}) : {}),
    suspiciousText: outcome.suspiciousText,
    ...(duplicateOf ? { duplicateOf } : {}),
    attemptsLeft: Math.max(0, MAX_UNREADABLE_READINGS - unreadable),
  };
}

async function auditSuspicious(deps: ReceiptServiceDeps, request: ReadReceiptRequest, readingId: string, now: Date): Promise<void> {
  await deps.connector.audit.append({
    worldId: request.worldId,
    epoch: request.epoch,
    auditId: `aud-sus-${readingId}`,
    ts: now.toISOString(),
    atSim: request.simNow.toISOString(),
    action: "SUSPICIOUS_RECEIPT_TEXT",
    actor: "AGENT",
    refs: { complaintId: request.complaintId, evidenceId: request.evidenceId, readingId, ...(request.turnId ? { turnId: request.turnId } : {}) },
    primaryRef: `CMP#${request.complaintId}`,
    outcome: "FLAGGED",
  });
}
