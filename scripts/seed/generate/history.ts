// The historical register of a template (docs/seed-spec.md §10): complaints `origin SEED` with their
// state, status history, evidence and deadlines, the chained register entries (`FILED`, `STATUS`,
// `FINAL_ANSWER`, `DELIVERY_PROOF`), the SLA timers of the open ones and the automatic closing of
// the answered ones. Money outcomes (reversals, approvals, the refund register) are history-money.ts.
import { deadline, milestones } from "@reclamo/bff/services/business-days";
import { COMPLAINT_TYPE_LABEL, CURRENT_EMAIL_CONSENT } from "@reclamo/bff/copy/index";
import { type ComplaintStatus, complaintNumber } from "@reclamo/shared";
import { chain } from "../lib/chain";
import { EPOCH_PLACEHOLDER, WORLD_PLACEHOLDER } from "../lib/constants";
import { sha256Hex } from "../lib/json";
import { addMinutes, businessDaysAfter, localOf, splitLocal, utcOf } from "./calendar";
import { HOLIDAY_DATES } from "./holidays";
import type { PlannedComplaint } from "./history-plan";
import { resolutionInstant } from "./history-plan";

export type Json = Record<string, unknown>;

export interface HistoryComplaint {
  readonly complaintId: string;
  readonly number: string;
  readonly plan: PlannedComplaint;
  readonly kind: "CONSULTA" | "RECLAMO";
  readonly deadline: string;
  readonly resolvedAt?: string;
  readonly answeredAt?: string;
  readonly closedAt?: string;
  readonly meta: Json;
  readonly documentMasked: string;
}

export interface HistoryBundle {
  readonly complaints: HistoryComplaint[];
  readonly evidence: Json[];
  readonly register: Json[];
  readonly timers: Json[];
}

interface Transition {
  readonly from: ComplaintStatus | null;
  readonly to: ComplaintStatus;
  readonly atSim: string;
  readonly cause: string;
  readonly actor: string;
}

function transitions(plan: PlannedComplaint, resolvedAt: string | undefined, answeredAt: string | undefined, closedAt: string | undefined): Transition[] {
  const out: Transition[] = [{ from: null, to: "REGISTERED", atSim: plan.filedAt, cause: "FILED", actor: "SYSTEM" }];
  const investigating = addMinutes(plan.filedAt, 3);
  out.push({ from: "REGISTERED", to: "INVESTIGATING", atSim: investigating, cause: "IDENTIFIED", actor: "AGENT" });
  if (plan.handoff) out.push({ from: "INVESTIGATING", to: "HUMAN_REVIEW", atSim: addMinutes(investigating, 6), cause: `HANDOFF_${plan.handoff}`, actor: "AGENT" });
  if (resolvedAt) out.push({ from: plan.handoff ? "HUMAN_REVIEW" : "INVESTIGATING", to: "RESOLVED", atSim: resolvedAt, cause: "RESOLVED", actor: plan.handoff ? "OPERATOR:stf-operator-01" : "AGENT" });
  if (answeredAt) out.push({ from: "RESOLVED", to: "ANSWERED", atSim: answeredAt, cause: "ANSWER_SENT", actor: "SYSTEM" });
  if (closedAt) out.push({ from: "ANSWERED", to: "CLOSED", atSim: closedAt, cause: "AUTO_CLOSE", actor: "SYSTEM" });
  return out;
}

const EVIDENCE_KIND: Readonly<Record<string, string>> = {
  PAYMENT_NOT_REFLECTED: "SETTLEMENT_MATCH",
  UNRECOGNIZED_CHARGE: "CHARGE_CHECK",
  DUPLICATE_DEBIT: "DUPLICATE_CHECK",
  TRANSFER_NOT_CREDITED: "TRANSFER_STATUS",
  DISBURSEMENT_NOT_RECEIVED: "DISBURSEMENT",
};

/** Body of the written answer the history's `FINAL_ANSWER` entries hash (the PDF itself is not seeded). */
function answerBody(number: string, type: string, outcome: string): string {
  return `${number}|${type}|${outcome}|respuesta escrita sembrada`;
}

export function buildHistory(plans: readonly PlannedComplaint[], documents: ReadonlyMap<string, string>): HistoryBundle {
  const complaints: HistoryComplaint[] = [];
  const evidence: Json[] = [];
  const events: Array<{ at: string; order: number; entry: Json }> = [];
  const timers: Json[] = [];
  plans.forEach((plan, index) => {
    const number = complaintNumber(2026, index + 1);
    const complaintId = `cmp-h${String(index + 1).padStart(6, "0")}`;
    const kind = plan.type === "INFORMATION_REQUEST" ? "CONSULTA" : "RECLAMO";
    const due = localOf(deadline(new Date(plan.filedAt), HOLIDAY_DATES));
    const open = plan.state === "HUMAN_REVIEW";
    const resolvedAt = open ? undefined : resolutionInstant(plan);
    const answeredAt = resolvedAt ? addMinutes(resolvedAt, 15) : undefined;
    const closedAt = plan.state === "CLOSED" && answeredAt ? `${businessDaysAfter(answeredAt.slice(0, 10), 5)}T${splitLocal(answeredAt).time}:00-03:00` : undefined;
    const steps = transitions(plan, resolvedAt, answeredAt, closedAt);
    const status = steps.at(-1)?.to ?? "REGISTERED";
    const documentMasked = `••••${(documents.get(plan.customerId) ?? "00000000").slice(-4)}`;
    const meta: Json = {
      worldId: WORLD_PLACEHOLDER,
      complaintId,
      complaintNumber: number,
      epoch: EPOCH_PLACEHOLDER,
      customerId: plan.customerId,
      kind,
      type: plan.type,
      status,
      ...(plan.outcome && !open ? { outcome: plan.outcome } : {}),
      priority: plan.handoff === "FRAUD" ? "HIGH" : "NORMAL",
      origin: "SEED",
      control: "AGENT",
      channel: "WHATSAPP",
      summary: `${COMPLAINT_TYPE_LABEL[plan.type].charAt(0).toUpperCase()}${COMPLAINT_TYPE_LABEL[plan.type].slice(1)}`,
      filedAtSim: plan.filedAt,
      deadlineSim: due,
      slaState: "ON_TIME",
      emailAnswerConsent: { status: "ACCEPTED", atSim: addMinutes(plan.filedAt, 1), textVersion: CURRENT_EMAIL_CONSENT.version },
      ...(answeredAt ? { answer: { messageId: `msg-${complaintId}-answer`, mailId: `mail-${complaintId}-answer`, sentAtSim: answeredAt, deliveryProof: "DELIVERED" } } : {}),
      ...(plan.handoff ? { handoff: { reason: plan.handoff, atSim: steps.find((step) => step.to === "HUMAN_REVIEW")?.atSim ?? plan.filedAt } } : {}),
      statusHistory: steps,
      version: steps.length,
      synthetic: true,
    };
    complaints.push({ complaintId, number, plan, kind, deadline: due, ...(resolvedAt ? { resolvedAt } : {}), ...(answeredAt ? { answeredAt } : {}), ...(closedAt ? { closedAt } : {}), meta, documentMasked });
    const base = { worldId: WORLD_PLACEHOLDER, epoch: EPOCH_PLACEHOLDER, complaintId, complaintNumber: number, kind, type: plan.type, channel: "WHATSAPP", origin: "SEED", synthetic: true };
    events.push({ at: plan.filedAt, order: 0, entry: { ...base, eventType: "FILED", atSim: plan.filedAt, reason: COMPLAINT_TYPE_LABEL[plan.type], presenter: { docType: "DNI", docNumberMasked: documentMasked } } });
    steps.slice(1).forEach((step, stepIndex) => events.push({ at: step.atSim, order: 1 + stepIndex, entry: { ...base, eventType: "STATUS", atSim: step.atSim, status: step.to } }));
    if (answeredAt && plan.outcome) {
      const finalAt = addMinutes(answeredAt, -2);
      events.push({ at: finalAt, order: 10, entry: { ...base, eventType: "FINAL_ANSWER", atSim: finalAt, answerRef: `doc-${complaintId}-answer`, bodySha256: sha256Hex(answerBody(number, plan.type, plan.outcome)) } });
      const proofAt = addMinutes(answeredAt, 4);
      events.push({ at: proofAt, order: 11, entry: { ...base, eventType: "DELIVERY_PROOF", atSim: proofAt, reason: "DELIVERED" } });
    }
    evidence.push({
      worldId: WORLD_PLACEHOLDER,
      complaintId,
      evidenceId: `evd-${complaintId.slice(4)}-1`,
      kind: EVIDENCE_KIND[plan.type] ?? "TERMS_CLAUSE",
      atSim: addMinutes(plan.filedAt, 5),
      actor: "AGENT",
      details: { seeded: true, summary: COMPLAINT_TYPE_LABEL[plan.type] },
      synthetic: true,
    });
    if (open) {
      const dates = milestones(new Date(plan.filedAt), HOLIDAY_DATES);
      for (const [milestone, at] of Object.entries(dates)) {
        timers.push(timer("SLA", `${complaintId}-${milestone}`, localOf(at), `CMP#${complaintId}`, { complaintId, milestone, complaintNumber: number, deadlineSim: due }));
      }
    }
    if (plan.state === "ANSWERED" && answeredAt) {
      const autoClose = `${businessDaysAfter(answeredAt.slice(0, 10), 5)}T${splitLocal(answeredAt).time}:00-03:00`;
      timers.push(timer("AUTO_CLOSE", `${complaintId}-AUTO_CLOSE`, autoClose, `CMP#${complaintId}`, { complaintId }));
    }
  });
  const ordered = events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || compareText(String(a.entry.complaintNumber), String(b.entry.complaintNumber)) || a.order - b.order);
  const register: Json[] = chain(ordered.map(({ entry }): Json => ({ ...entry, atReal: utcOf(String(entry.atSim)) })));
  return { complaints, evidence, register, timers };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function timer(kind: string, timerId: string, dueAtSim: string, ownerKey: string, payload: Json): Json {
  return { worldId: WORLD_PLACEHOLDER, kind, timerId, dueAtSim, seq: 0, status: "SCHEDULED", epoch: EPOCH_PLACEHOLDER, ownerKey, payload, version: 1, synthetic: true };
}
