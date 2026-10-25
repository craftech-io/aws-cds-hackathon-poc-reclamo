// `reconcile_payment` below its fences, and the worker's deterministic reconciliation
// (docs/architecture-integrations.md §6.1; docs/architecture.md §7 "Obligaciones"; docs/tool-catalog.md).
// It does not trust the network mock to decide: it lists the batches of the possible business dates,
// downloads the PUBLISHED files (checked against their SHA-256 and line count, networks/settlement-files.ts),
// and decides in code (decide.ts). With `source = SETTLEMENT` a `READ` reading of the complaint is
// required. Every reconciliation leaves a `SETTLEMENT_MATCH` evidence with what was reviewed; only the
// customer's own line is kept, and a `PAYER_MISMATCH` is audited without anything of the other payer.
//
// The callers do the rest: a PENDING_BATCH creates the `SETTLEMENT_RECHECK` timer (owner
// `BATCH#<network>#<businessDate>`), a PAYER_MISMATCH hands the complaint to a person (`RECEIPT_DOUBT`).
import type { CollectionNetwork as ContractNetwork } from "@reclamo/core-contract";
import { ToolError, type ReconciliationResult } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import type { CoreCallContext, CoreClient } from "../core/client";
import { loadHolidays } from "../complaints/sla";
import { ulid } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { NetworkClient } from "../networks/client";
import { NetworkClientError } from "../networks/errors";
import { SettlementFileError, type SettlementFileReader } from "../networks/settlement-files";
import { ReceiptReadingDetails } from "../receipts/schema";
import { localDateAr } from "../services/business-days";
import { type AppliedPaymentRef, type CandidateBatch, type CollectionNetwork, type MovementDecision, type MovementSource, type SettlementDecision, candidateBusinessDates, decideMovement, decideSettlement } from "./decide";

export type ReconcileSource = "SETTLEMENT" | MovementSource;

export interface ReconcileDeps {
  readonly connector: Connector;
  readonly core: CoreClient;
  readonly network: Pick<NetworkClient, "listSettlements">;
  readonly readFile: SettlementFileReader;
  /** Real clock: ids and audit stamps. */
  readonly now: () => Date;
  readonly log: Logger;
  readonly newId?: () => string;
}

export interface ReconcileRequest {
  readonly worldId: string;
  readonly epoch: number;
  readonly complaintId: string;
  readonly customerId: string;
  readonly source: ReconcileSource;
  readonly readingId?: string;
  readonly movementId?: string;
  /** The world's simulated "now", sent as `X-Sim-Now`. */
  readonly simNow: Date;
  readonly actor: "AGENT" | "SYSTEM";
  readonly turnId?: string;
  readonly correlationId?: string;
}

export interface ReconcileResponse {
  readonly result: ReconciliationResult;
  readonly reconciliationId: string;
  readonly evidenceId: string;
  readonly source: ReconcileSource;
  readonly decision: SettlementDecision | MovementDecision;
}

/** Days of operations a movement is looked for in (the core answers at most 90). */
const MOVEMENT_LOOKBACK_DAYS = 89;

async function readingOf(deps: ReconcileDeps, request: ReconcileRequest) {
  if (request.readingId === undefined) return undefined;
  const evidence = (await deps.connector.caseItems.listEvidence(request.worldId, request.complaintId)).find((item) => item.kind === "RECEIPT_READING" && item.refId === request.readingId);
  if (evidence === undefined) throw new ToolError("NOT_FOUND", "no such reading in this complaint");
  const parsed = ReceiptReadingDetails.safeParse(evidence.details);
  if (!parsed.success || parsed.data.result !== "READ" || parsed.data.fields === undefined) throw new ToolError("EVIDENCE_REQUIRED", "the reading is not a READ receipt");
  return parsed.data.fields;
}

async function customerLoans(deps: ReconcileDeps, ctx: CoreCallContext, customerId: string): Promise<{ loanIds: string[]; applied: AppliedPaymentRef[] }> {
  const customer = await deps.core.call("getCustomer", ctx, { params: { customerId } });
  const loanIds = customer.loans.map((loan) => loan.loanId);
  const lists = await Promise.all(loanIds.map((loanId) => deps.core.call("listInstalments", ctx, { params: { loanId } })));
  const applied = lists.flatMap((list) =>
    list.customerId !== customerId ? [] : list.instalments.flatMap((instalment) => instalment.payments.map((payment) => ({ network: payment.network, operationCode: payment.operationCode, loanId: list.loanId, appliedAtSim: payment.appliedAtSim }))),
  );
  return { loanIds, applied };
}

async function candidateBatches(deps: ReconcileDeps, ctx: CoreCallContext, network: CollectionNetwork, dates: readonly string[]): Promise<CandidateBatch[]> {
  const from = dates[0] ?? "";
  const to = dates[dates.length - 1] ?? from;
  try {
    const listed = await deps.network.listSettlements({ worldId: ctx.worldId, simNow: ctx.simNow, ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}) }, network as ContractNetwork, { from, to });
    const wanted = listed.batches.filter((batch) => dates.includes(batch.businessDate));
    return await Promise.all(wanted.map(async (batch) => (batch.status === "PUBLISHED" ? { batch, lines: await deps.readFile(batch) } : { batch })));
  } catch (error) {
    if (error instanceof NetworkClientError || error instanceof SettlementFileError) {
      deps.log.warn("reconcile.network_unavailable", { worldId: ctx.worldId, code: error.code });
      throw new ToolError("UNAVAILABLE", "the network's settlements cannot be read right now", error.code, { cause: error });
    }
    throw error;
  }
}

function settlementDetails(request: ReconcileRequest, fields: { network: string; operationCode: string }, decision: SettlementDecision): Record<string, unknown> {
  const base = { result: decision.result, source: "SETTLEMENT", readingId: request.readingId, network: fields.network, operationCode: fields.operationCode, reviewed: decision.reviewed };
  switch (decision.result) {
    case "MATCHED":
    case "AMOUNT_MISMATCH":
      return { ...base, line: decision.line };
    case "ALREADY_APPLIED":
      return { ...base, appliedAtSim: decision.appliedAtSim, loanId: decision.loanId };
    case "PENDING_BATCH":
      return { ...base, pending: decision.pending };
    default:
      // PAYER_MISMATCH and NOT_FOUND: what was reviewed, never a line of someone else.
      return base;
  }
}

async function record(deps: ReconcileDeps, request: ReconcileRequest, result: ReconciliationResult, details: Record<string, unknown>) {
  const now = deps.now();
  const id = deps.newId?.() ?? ulid(now.getTime());
  const reconciliationId = `rcn-${id}`;
  const evidenceId = `evd-rcn-${id}`;
  await deps.connector.caseItems.putEvidence({
    worldId: request.worldId,
    complaintId: request.complaintId,
    evidenceId,
    kind: "SETTLEMENT_MATCH",
    refId: reconciliationId,
    atSim: request.simNow.toISOString(),
    actor: request.actor,
    ...(request.turnId ? { turnId: request.turnId } : {}),
    details: JSON.parse(JSON.stringify(details)),
  });
  if (result === "PAYER_MISMATCH") {
    deps.log.warn("reconcile.payer_mismatch", { metric: "PayerMismatch", worldId: request.worldId, complaintId: request.complaintId });
    await deps.connector.audit.append({
      worldId: request.worldId,
      epoch: request.epoch,
      auditId: `aud-pm-${reconciliationId}`,
      ts: now.toISOString(),
      atSim: request.simNow.toISOString(),
      action: "PAYER_MISMATCH",
      actor: request.actor,
      ruleIds: ["LAM-EVIDENCE"],
      refs: { complaintId: request.complaintId, reconciliationId, ...(request.readingId ? { readingId: request.readingId } : {}), ...(request.turnId ? { turnId: request.turnId } : {}) },
      primaryRef: `CMP#${request.complaintId}`,
      outcome: "RECEIPT_DOUBT",
    });
  }
  return { reconciliationId, evidenceId };
}

export async function reconcilePayment(deps: ReconcileDeps, request: ReconcileRequest): Promise<ReconcileResponse> {
  const ctx: CoreCallContext = { worldId: request.worldId, simNow: request.simNow.toISOString(), ...(request.correlationId ? { correlationId: request.correlationId } : {}) };
  if (request.source === "SETTLEMENT") {
    // Without a reading there is no reconciliation against a network (docs/tool-catalog.md).
    if (request.readingId === undefined) throw new ToolError("INVALID", "a settlement reconciliation needs the readingId of a READ receipt");
    const fields = await readingOf(deps, request);
    if (fields === undefined) throw new ToolError("INVALID", "a settlement reconciliation needs the readingId of a READ receipt");
    if (fields.network !== "NORTE" && fields.network !== "SUR") throw new ToolError("INVALID", "this receipt is not of a collection network; reconcile it with its own source");
    const network: CollectionNetwork = fields.network;
    const [{ loanIds, applied }, holidays] = await Promise.all([customerLoans(deps, ctx, request.customerId), loadHolidays(deps.connector)]);
    const batches = await candidateBatches(deps, ctx, network, candidateBusinessDates(fields.paidAtLocal, holidays));
    const decision = decideSettlement({ reading: { ...fields, network }, customerId: request.customerId, loanIds, applied, batches });
    const ids = await record(deps, request, decision.result, settlementDetails(request, fields, decision));
    deps.log.info("reconcile.decided", { worldId: request.worldId, complaintId: request.complaintId, source: "SETTLEMENT", result: decision.result, batches: decision.reviewed.length });
    return { result: decision.result, ...ids, source: "SETTLEMENT", decision };
  }

  if (request.movementId === undefined) throw new ToolError("INVALID", "a wallet or transfer reconciliation needs the movementId");
  const fields = await readingOf(deps, request);
  const { loanIds, applied } = await customerLoans(deps, ctx, request.customerId);
  const to = localDateAr(request.simNow);
  const from = localDateAr(new Date(request.simNow.getTime() - MOVEMENT_LOOKBACK_DAYS * 86_400_000));
  const list = await deps.core.call("listOperations", ctx, { params: { customerId: request.customerId }, query: { from, to } });
  const decision = decideMovement({ source: request.source, movementId: request.movementId, operations: list.operations, loanIds, applied, ...(fields ? { reading: { operationCode: fields.operationCode, amount: fields.amount } } : {}) });
  const details = { result: decision.result, source: request.source, movementId: request.movementId, ...(request.readingId ? { readingId: request.readingId } : {}), ...(fields ? { operationCode: fields.operationCode } : {}), ...decisionFacts(decision) };
  const ids = await record(deps, request, decision.result, details);
  deps.log.info("reconcile.decided", { worldId: request.worldId, complaintId: request.complaintId, source: request.source, result: decision.result });
  return { result: decision.result, ...ids, source: request.source, decision };
}

function decisionFacts(decision: MovementDecision): Record<string, unknown> {
  if (decision.result === "MATCHED" || decision.result === "AMOUNT_MISMATCH") return { movement: decision.movement };
  if (decision.result === "ALREADY_APPLIED") return { appliedAtSim: decision.appliedAtSim, loanId: decision.loanId };
  return {};
}
