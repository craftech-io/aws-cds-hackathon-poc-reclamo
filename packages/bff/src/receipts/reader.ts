// The result table of the receipt reader (docs/architecture-integrations.md §7, step 5; ADR-0007;
// FL-019, FL-020, FL-027, FL-028):
//
//   Bedrock CLEAR, valid digit; fallback agrees or absent        → READ (BOTH_AGREE | BEDROCK)
//   Bedrock PARTIAL with code, amount and date and valid digit   → as CLEAR
//   Bedrock NOT AVAILABLE and fallback present                   → READ (FALLBACK), metric ReceiptReadFallbacks
//   Bedrock ILLEGIBLE, or PARTIAL incomplete, WITH OR WITHOUT a chunk → UNREADABLE (the fallback is not asked)
//   invalid check digit or impossible format                     → INVALID_RECEIPT (a person reviews it)
//   Bedrock CLEAR and the fallback differ in code or amount      → DISAGREE (a person reviews it)
//   isReceipt = false                                            → NOT_A_RECEIPT
//   suspiciousText = true                                        → flagged; the fields only reconcile
//
// Pure: the image bytes, the world's simulated "now" and Bedrock's port in, an outcome out. Nothing
// read here imputes anything: `apply_payment` needs a MATCHED line of the published settlement.
import { worldKindOf } from "@reclamo/shared";
import type { Logger } from "../lib/log";
import type { BedrockReceiptReader, BedrockUnavailable } from "./bedrock-reader";
import { type FallbackRead, readFallback } from "./fallback-parser";
import type { DisagreeingRead, ImageType, Legibility, ReaderResult, ReadingProblem, ReadingSource, ReceiptFields } from "./schema";
import { candidateOf, isComplete, validateFields } from "./validate";

export interface ReaderOutcome {
  readonly result: ReaderResult;
  readonly source: ReadingSource;
  readonly fields?: ReceiptFields;
  readonly problem?: ReadingProblem;
  readonly suspiciousText: boolean;
  readonly bedrock?: { readonly legibility?: Legibility; readonly isReceipt?: boolean; readonly unavailable?: BedrockUnavailable | "FORCED" };
  readonly fallback?: { readonly present: boolean; readonly agrees?: boolean };
  readonly disagreement?: { readonly bedrock: DisagreeingRead; readonly fallback?: DisagreeingRead };
}

/** Bedrock was not available and the image carries no usable fallback: no reading at all. */
export type ReaderUnavailable = { readonly unavailable: true; readonly reason: BedrockUnavailable | "FORCED" };

export interface ReaderDeps {
  readonly bedrock: BedrockReceiptReader;
  readonly log: Logger;
}

export interface ReadInput {
  readonly worldId: string;
  readonly bytes: Uint8Array;
  readonly contentType: ImageType;
  /** The world's simulated "now": a payment after it cannot be. */
  readonly simNow: Date;
  /** `receipt.forceFallback` of the QA driver; ignored outside QA worlds. */
  readonly forceFallback?: boolean;
}

function lite(fields: { operationCode?: string; amount?: number }): DisagreeingRead {
  return { operationCode: fields.operationCode ?? "", amount: fields.amount ?? 0 };
}

/** Bedrock is out: the fallback reads the chunk, and its fields pass the same validation. */
function fromFallback(input: ReadInput, reason: BedrockUnavailable | "FORCED", deps: ReaderDeps): ReaderOutcome | ReaderUnavailable {
  const fallback = readFallback(input.bytes);
  if (!fallback.present || !fallback.valid) {
    deps.log.warn("receipts.no_reading", { reason, fallback: fallback.present ? fallback.reason : "ABSENT" });
    return { unavailable: true, reason };
  }
  const check = validateFields(fallback.candidate, input.simNow);
  deps.log.info("receipts.fallback_used", { metric: "ReceiptReadFallbacks", reason, valid: check.ok });
  const base = { source: "FALLBACK" as const, suspiciousText: false, bedrock: { unavailable: reason }, fallback: { present: true } };
  if (!check.ok) return { ...base, result: "INVALID_RECEIPT", problem: check.problem };
  return { ...base, result: "READ", fields: check.fields };
}

/** The cross-check of a valid Bedrock reading against the chunk, when there is one. */
function crossCheck(fields: ReceiptFields, fallback: FallbackRead): Pick<ReaderOutcome, "result" | "source" | "fallback" | "disagreement" | "fields"> {
  if (!fallback.present) return { result: "READ", source: "BEDROCK", fields, fallback: { present: false } };
  if (!fallback.valid) return { result: "DISAGREE", source: "DISAGREE", fallback: { present: true, agrees: false }, disagreement: { bedrock: lite(fields) } };
  const other = fallback.candidate;
  if (other.operationCode === fields.operationCode && other.amount === fields.amount) {
    return { result: "READ", source: "BOTH_AGREE", fields, fallback: { present: true, agrees: true } };
  }
  return { result: "DISAGREE", source: "DISAGREE", fallback: { present: true, agrees: false }, disagreement: { bedrock: lite(fields), fallback: lite(other) } };
}

export async function readReceiptImage(input: ReadInput, deps: ReaderDeps): Promise<ReaderOutcome | ReaderUnavailable> {
  const forced = input.forceFallback === true && worldKindOf(input.worldId) === "QA";
  if (forced) return fromFallback(input, "FORCED", deps);

  const answer = await deps.bedrock.read({ bytes: input.bytes, contentType: input.contentType });
  if (answer.kind === "UNAVAILABLE") return fromFallback(input, answer.reason, deps);
  if (answer.kind === "INVALID_OUTPUT") return { result: "UNREADABLE", source: "BEDROCK", problem: "INVALID_OUTPUT", suspiciousText: false };

  const raw = answer.raw;
  const suspiciousText = raw.suspiciousText;
  const bedrock = { legibility: raw.legibility, isReceipt: raw.isReceipt };
  if (suspiciousText) deps.log.warn("receipts.suspicious_text", { legibility: raw.legibility });
  if (!raw.isReceipt) return { result: "NOT_A_RECEIPT", source: "BEDROCK", suspiciousText, bedrock };
  // Never rescued by the chunk: a real photo has none, and the demo must not pretend to read a blur.
  if (raw.legibility === "ILLEGIBLE" || (raw.legibility === "PARTIAL" && !isComplete(raw))) {
    return { result: "UNREADABLE", source: "BEDROCK", suspiciousText, bedrock, ...(raw.legibility === "PARTIAL" ? { problem: "INCOMPLETE" as const } : {}) };
  }
  const check = validateFields(candidateOf(raw), input.simNow);
  if (!check.ok) {
    if (check.problem === "INCOMPLETE") return { result: "UNREADABLE", source: "BEDROCK", problem: "INCOMPLETE", suspiciousText, bedrock };
    return { result: "INVALID_RECEIPT", source: "BEDROCK", problem: check.problem, suspiciousText, bedrock };
  }
  return { ...crossCheck(check.fields, readFallback(input.bytes)), suspiciousText, bedrock };
}

export function isUnavailable(outcome: ReaderOutcome | ReaderUnavailable): outcome is ReaderUnavailable {
  return "unavailable" in outcome;
}
