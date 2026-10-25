// What every investigation tool leaves on its complaint (docs/tool-catalog.md target `investigation`):
// one `Evidence` row with what the core, the networks or the reader answered, written before the tool
// answers, so a later action (`LAM-EVIDENCE`, agent-tools/actions/evidence.ts) and the case view read
// the same facts the model read. The evidence id and the tool's own id (`chargeCheckId`,
// `duplicateCheckId`, `readingId`, `reconciliationId`) are minted here; the details carry ids, codes
// and amounts in centavos, never personal data.
import { ToolError } from "@reclamo/shared";
import type { Evidence, EvidenceKind } from "../../domain/case-items";
import type { Complaint } from "../../domain/complaint";
import type { JsonObject } from "../../domain/common";
import { ulid } from "../../lib/crypto";
import { type ToolContext, actorOf } from "../common/context";
import { NO_OPEN_COMPLAINT } from "../common/fences";

/** The prefix of the id each kind of evidence answers with (`chk-…` is a `chargeCheckId`). */
export const REF_PREFIX: Readonly<Partial<Record<EvidenceKind, string>>> = {
  RECEIPT_READING: "rdg",
  SETTLEMENT_MATCH: "rec",
  CHARGE_CHECK: "chk",
  DUPLICATE_CHECK: "dup",
  TRANSFER_STATUS: "trs",
  DISBURSEMENT: "dsb",
  LOAN_STATUS: "lns",
  PAYOFF_QUOTE: "poq",
  TERMS_CLAUSE: "trm",
};

/** The complaint the `LAM-COMPLAINT-REQUIRED` fence resolved (every investigation tool is **Rc**). */
export function complaintOf(ctx: Pick<ToolContext<unknown>, "complaint">): Complaint {
  if (ctx.complaint === undefined) throw new ToolError("COMPLAINT_REQUIRED", NO_OPEN_COMPLAINT);
  return ctx.complaint;
}

export interface RecordedEvidence {
  readonly evidenceId: string;
  /** The id the tool answers with (`readingId`, `reconciliationId`, …). */
  readonly refId: string;
  readonly evidence: Evidence;
}

/** Writes one evidence of the call's complaint and returns its ids. */
export async function recordEvidence(ctx: ToolContext<unknown>, kind: EvidenceKind, details: JsonObject, complaint: Complaint = complaintOf(ctx)): Promise<RecordedEvidence> {
  const stamp = ulid(ctx.wallClock().getTime()).toLowerCase();
  const evidenceId = `evd-${stamp}`;
  const refId = `${REF_PREFIX[kind] ?? "evd"}-${stamp}`;
  const value = {
    worldId: ctx.session.worldId,
    complaintId: complaint.complaintId,
    evidenceId,
    kind,
    refId,
    atSim: ctx.session.eventAtSim,
    actor: actorOf(ctx.principal),
    turnId: ctx.session.turnId,
    details,
  };
  await ctx.connector.caseItems.putEvidence(value);
  const stored = await ctx.connector.caseItems.getEvidence(ctx.session.worldId, complaint.complaintId, evidenceId);
  if (stored === undefined) throw new ToolError("UNAVAILABLE", "the evidence could not be recorded, try again");
  return { evidenceId, refId, evidence: stored };
}
