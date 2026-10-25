// One complaint as the KPIs read it, from the complaint itself ("Este mundo") or from its KPI row (the
// batch and the simulated load, whose complaints live in `sim-*` worlds). Definitions of
// docs/design-brief.md §11:
//
//   answered          the written answer went out (`answer.sentAtSim`): the regulatory clock stopped
//   decided           answered, or `OVERDUE` without an answer: the "% en plazo" knows its outcome
//   onTime            answered at or before the deadline
//   withProof         the answer's email has the `DELIVERED` proof of the SES events
//   human             a person was involved: `HUMAN_REVIEW`, an approval (`AWAITING_APPROVAL`), a
//                     take-over (control `OPERATOR` or an operator in the history) or a hand-off
//   resolvedWithoutHuman  answered and no person involved (only answered complaints count)
import type { ComplaintType } from "@reclamo/shared";
import type { Complaint } from "../domain/complaint";
import type { ComplaintKpi } from "../domain/metrics";

export interface ComplaintFacts {
  readonly complaintId: string;
  readonly type?: ComplaintType;
  readonly ackLatencyMs?: number;
  readonly coldStart?: boolean;
  readonly answered: boolean;
  readonly decided: boolean;
  readonly onTime: boolean;
  readonly withProof: boolean;
  /** `undefined` until the complaint is answered. */
  readonly resolvedWithoutHuman?: boolean;
  readonly humanActions: readonly string[];
  readonly tokens: { readonly in: number; readonly out: number; readonly cached: number };
  readonly messages: { readonly wa: number; readonly email: number };
  readonly costUsd?: number;
}

const HUMAN_STATUSES = new Set(["HUMAN_REVIEW", "AWAITING_APPROVAL"]);

function involvedHuman(complaint: Complaint): boolean {
  if (complaint.handoff !== undefined || complaint.control === "OPERATOR") return true;
  return complaint.statusHistory.some((change) => HUMAN_STATUSES.has(change.to) || change.actor.startsWith("OPERATOR:"));
}

function usageOf(row: ComplaintKpi | undefined): Pick<ComplaintFacts, "ackLatencyMs" | "coldStart" | "humanActions" | "tokens" | "messages" | "costUsd"> {
  return {
    ...(row?.ackLatencyMs === undefined ? {} : { ackLatencyMs: row.ackLatencyMs }),
    ...(row?.coldStart === undefined ? {} : { coldStart: row.coldStart }),
    humanActions: row?.humanActions ?? [],
    tokens: row?.tokens ?? { in: 0, out: 0, cached: 0 },
    messages: row?.messages ?? { wa: 0, email: 0 },
    ...(row?.costUsd === undefined ? {} : { costUsd: row.costUsd }),
  };
}

/** A complaint of the world with its KPI row (latency, tokens, messages), when it has one. */
export function factsOfComplaint(complaint: Complaint, row?: ComplaintKpi): ComplaintFacts {
  const sentAt = complaint.answer?.sentAtSim;
  const answered = sentAt !== undefined;
  const onTime = answered && Date.parse(sentAt) <= Date.parse(complaint.deadlineSim);
  return {
    complaintId: complaint.complaintId,
    type: complaint.type,
    answered,
    decided: answered || complaint.slaState === "OVERDUE",
    onTime,
    withProof: complaint.answer?.deliveryProof === "DELIVERED",
    ...(answered ? { resolvedWithoutHuman: !involvedHuman(complaint) } : {}),
    ...usageOf(row),
  };
}

/** A complaint of a batch or of the simulated load, from its KPI row alone. */
export function factsOfRow(row: ComplaintKpi): ComplaintFacts {
  const answered = row.answeredOnTime !== undefined;
  return {
    complaintId: row.complaintId,
    ...(row.complaintType === undefined ? {} : { type: row.complaintType }),
    answered,
    decided: answered,
    onTime: row.answeredOnTime === true,
    withProof: row.deliveryProof === "DELIVERED",
    ...(row.resolvedWithoutHuman === undefined ? {} : { resolvedWithoutHuman: row.resolvedWithoutHuman }),
    ...usageOf(row),
  };
}

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `part / whole` in percent, or `null` without a denominator. */
export function pct(part: number, whole: number): number | null {
  return whole === 0 ? null : round((part / whole) * 100);
}
