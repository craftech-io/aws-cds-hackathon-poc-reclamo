// The local pipeline of the simulated load (docs/seed-spec.md §13, docs/test-plan.md `LF`): one
// presentation at a time through the real code, in process, over the memory connector:
//
//   classifier   the deterministic rules of the intake (intake/rules.ts): the scripted classifier
//   number       acknowledge_complaint: number, `FILED`, three milestones, in one transaction
//   ack          `COMPLAINT_ACK` by WhatsApp (simulated) through the real gate: policy, render, fence, tape
//   consent      the customer accepts the written answer by email (the current consent text)
//   agent        the scripted agent: one evidence that founds the case, `INVESTIGATING` → `RESOLVED`
//                with the outcome its type decides, and the written answer (`FORMAL_ANSWER`, letter PDF)
//                through the real gate after the network's delay; `ANSWERED` cancels the milestones
//
// The gate's G2 is the scripted one of the gate's kit (it passes), SES is the kit's recording stand-in
// fenced to the simulator's mailboxes, and every customer is synthetic (`cus-sl-NNN`, a number in the
// unassignable range). Nothing here reaches AWS.
import type { ComplaintOutcome, ComplaintType } from "@reclamo/shared";
import { storeAnswerDocuments } from "../../packages/bff/src/agent-tools/complaints/answer-documents";
import { ackMessage } from "../../packages/bff/src/agent-tools/complaints/register-tool";
import { derivedMessageId } from "../../packages/bff/src/agent-tools/messaging/outbound";
import { type AckSender, acknowledgeComplaint, recordEmailConsent } from "../../packages/bff/src/complaints/acknowledge";
import { beginAnswer, completeAnswer } from "../../packages/bff/src/complaints/answer";
import { foundingEvidenceKinds } from "../../packages/bff/src/complaints/foundation";
import { transition } from "../../packages/bff/src/complaints/state-machine";
import { emailKit } from "../../packages/bff/src/channels/email/testing";
import { TEST_NOW } from "../../packages/bff/src/connector/testing";
import { CURRENT_EMAIL_CONSENT, EMAIL_TEXT, fill } from "../../packages/bff/src/copy";
import { applyRules } from "../../packages/bff/src/intake/rules";
import { isoAr } from "../../packages/bff/src/complaints/sla";
import { nthBusinessDay } from "../../packages/bff/src/services/business-days";
import type { ActionKind } from "../../packages/bff/src/domain/case-items";
import type { Actor } from "../../packages/bff/src/domain/common";
import type { Complaint } from "../../packages/bff/src/domain/complaint";
import type { ComplaintKpi } from "../../packages/bff/src/domain/metrics";
import type { LoadInput } from "../../packages/bff/src/metrics/inputs";
import { SIMULATED_LOAD_WORLD } from "../../packages/bff/src/metrics/types";
import type { CustomerFacts, OutboundDeps } from "../../packages/bff/src/outbound/deps";
import { createOutboundGate } from "../../packages/bff/src/outbound/gate";
import { agentTurn, call, customerWrote, gateRig } from "../../packages/bff/src/outbound/testing";
import type { OutboundGate } from "../../packages/bff/src/outbound/types";

/**
 * Real seconds between two presentations: the load runs on a real clock that moves, so the abuse caps
 * on the real clock (200 emails per world and real hour, channels/email/outbound.ts) see a steady
 * 100 presentations an hour instead of three months in one instant.
 */
export const REAL_SECONDS_PER_PRESENTATION = 36;

/** The resolution the scripted agent's investigation reaches for each type (the code decides it in a real case). */
const OUTCOME_OF: Readonly<Record<ComplaintType, ComplaintOutcome>> = {
  PAYMENT_NOT_REFLECTED: "IN_FAVOUR",
  PAYOFF_CERTIFICATE: "INFORMATIONAL",
  UNRECOGNIZED_CHARGE: "IN_FAVOUR",
  DUPLICATE_DEBIT: "IN_FAVOUR",
  TRANSFER_NOT_CREDITED: "INFORMATIONAL",
  DISBURSEMENT_NOT_RECEIVED: "INFORMATIONAL",
  UNKNOWN_OPERATION: "PARTIALLY_IN_FAVOUR",
  ACCOUNT_BLOCKED: "INFORMATIONAL",
  CLOSURE_OR_EARLY_PAYOFF: "INFORMATIONAL",
  DATA_CHANGE: "IN_FAVOUR",
  INFORMATION_REQUEST: "INFORMATIONAL",
};

/** The action that founds a type no evidence founds (complaints/foundation.ts); a blocked account only a person resolves. */
const SCRIPTED_ACTION: Readonly<Partial<Record<ComplaintType, ActionKind>>> = { UNKNOWN_OPERATION: "FREEZE_OUTGOING", DATA_CHANGE: "DATA_CHANGE" };
const SCRIPTED_OPERATOR: Actor = "OPERATOR:stf-sl-operator";

/** A short Spanish answer with no figures: the scripted agent never states an amount it did not read. */
const ANSWER_BODY = "Hola. Revisamos tu presentación con la información de tu cuenta y de las operaciones involucradas. Te dejamos adjunta la respuesta escrita con el detalle de lo que resolvimos. Si necesitás algo más, respondé este mensaje y lo vemos.";

export interface PresentationOutcome {
  readonly input: LoadInput;
  readonly classifiedByRule: boolean;
  readonly complaint?: Complaint;
  /** The gate's decision on the acknowledgement and on the written answer. */
  readonly ack: string;
  readonly answer: string;
  readonly row?: Omit<ComplaintKpi, "worldId" | "source" | "runId">;
}

export interface Pipeline {
  readonly rig: Awaited<ReturnType<typeof gateRig>>;
  readonly gate: OutboundGate;
  run(input: LoadInput, index: number): Promise<PresentationOutcome>;
}

const customerIdOf = (index: number) => `cus-sl-${String(index + 1).padStart(3, "0")}`;
const phoneOf = (index: number) => `+54911000020${String(index + 1).padStart(3, "0")}`;

function customerFacts(customerId: string): CustomerFacts {
  return { customerId, firstName: "Cliente", emailMasked: "s***@simulator.amazonses.com", whatsapp: { optedIn: true, optedInAtSim: "2025-03-01T10:00:00-03:00", optInMedium: "SIGNED_ONBOARDING", optInTextVersion: "v001", optedOut: false }, loans: [{ loanId: `L-${customerId.slice(4)}`, label: "Préstamo personal" }] };
}

/** The instant the scripted agent answers: the network's delay in business days, then 11:00. */
export function answerInstant(input: LoadInput, holidays: readonly string[]): string {
  return isoAr(nthBusinessDay(new Date(input.filedAtSim), Math.max(1, input.params.networkDelayBusinessDays), "11:00:00", holidays));
}

/** The pipeline over one memory world `sim-load` at epoch 1. */
export async function createPipeline(holidays: readonly string[]): Promise<Pipeline> {
  const rig = await gateRig({ worldId: SIMULATED_LOAD_WORLD });
  const phones = new Map<string, string>();
  let realNow = new Date(TEST_NOW.getTime());
  const deps: OutboundDeps = {
    ...rig.deps,
    email: emailKit({ connector: rig.kit.connector, now: () => realNow }).client,
    customers: { get: async (_worldId, customerId) => (phones.has(customerId) ? customerFacts(customerId) : undefined) },
    recipients: { whatsAppNumber: async (_worldId, customerId, mode) => (mode === "simulated" ? phones.get(customerId) : undefined) },
  };
  const gate = createOutboundGate(deps);
  const complaints = rig.kit.deps;
  const { connector } = rig.kit;
  for (const date of holidays) await rig.kit.store.write({ kind: "put", table: "Reference", item: { pk: "REF#HOLIDAY#AR", sk: date, date } });

  async function acknowledge(input: LoadInput, customerId: string, type: ComplaintType, inboundId: string): Promise<{ complaint: Complaint; ack: string }> {
    let ack = "NOT_SENT";
    const sendAck: AckSender = async (request) => {
      const system = ackMessage(request, customerFacts(customerId).emailMasked);
      const messageId = derivedMessageId(SIMULATED_LOAD_WORLD, system.kind, ...(system.idParts ?? [request.complaintId, request.eventId]));
      const outcome = await gate({ worldId: SIMULATED_LOAD_WORLD, customerId, complaintId: request.complaintId, sender: "SYSTEM", channel: "WHATSAPP", kind: system.kind, ...(system.text === undefined ? {} : { text: system.text }), ...(system.buttons === undefined ? {} : { buttons: system.buttons }), refs: { source: "SIMULATED_LOAD" }, triggerEventId: inboundId, messageId }, call(rig));
      ack = outcome.decision ?? (outcome.ok ? "ALLOWED" : outcome.failure.error.code);
      return outcome.messageId === undefined ? {} : { messageId: outcome.messageId };
    };
    const { complaint } = await acknowledgeComplaint(
      complaints,
      { worldId: SIMULATED_LOAD_WORLD, customerId, kind: input.kind, type, channel: "WHATSAPP", summary: input.message, sourceMessageId: inboundId, eventId: `sl-reg-${input.id}`, presenter: { docType: "DNI", docNumberMasked: "••••0000" }, filedAtSim: input.filedAtSim, holidays, actor: "SYSTEM" },
      sendAck,
    );
    return { complaint, ack };
  }

  /** What founds `RESOLVED` as the code demands: the type's own evidence, its action, or a person; answers who resolves. */
  async function found(complaint: Complaint, index: number, atSim: string): Promise<Actor> {
    const base = { worldId: SIMULATED_LOAD_WORLD, complaintId: complaint.complaintId, atSim, actor: "AGENT" as const };
    const [kind] = foundingEvidenceKinds(complaint.type);
    if (kind !== undefined) {
      await connector.caseItems.putEvidence({ ...base, evidenceId: `evd-sl-${index + 1}`, kind, details: { scripted: true, type: complaint.type } });
      return "AGENT";
    }
    const action = SCRIPTED_ACTION[complaint.type];
    if (action === undefined) return SCRIPTED_OPERATOR;
    await connector.caseItems.putAction({ ...base, actionId: `act-sl-${index + 1}`, kind: action, status: "EXECUTED", idempotencyKey: `sl-${index + 1}`, ...(action === "DATA_CHANGE" ? { dataChangeField: "ADDRESS" as const } : {}) });
    return "AGENT";
  }

  async function answer(complaint: Complaint, input: LoadInput, customerId: string, index: number): Promise<{ complaint: Complaint; answer: string }> {
    const atSim = answerInstant(input, holidays);
    rig.simNow = atSim;
    const outcome = OUTCOME_OF[complaint.type];
    const resolver = await found(complaint, index, atSim);
    let current = (await transition(complaints, { worldId: SIMULATED_LOAD_WORLD, complaintId: complaint.complaintId, to: "INVESTIGATING", cause: "SCRIPTED_AGENT", actor: "AGENT", atSim, holidays })).complaint;
    if (resolver !== "AGENT") current = (await transition(complaints, { worldId: SIMULATED_LOAD_WORLD, complaintId: complaint.complaintId, complaint: current, to: "HUMAN_REVIEW", cause: "SCRIPTED_HANDOFF", actor: "AGENT", atSim, holidays })).complaint;
    current = (await transition(complaints, { worldId: SIMULATED_LOAD_WORLD, complaintId: complaint.complaintId, complaint: current, to: "RESOLVED", cause: "SCRIPTED_AGENT", actor: resolver, atSim, holidays, patch: { outcome } })).complaint;
    const turnId = `turn-sl-${index + 1}`;
    await agentTurn(rig, customerId, turnId, [{ complaintNumber: complaint.complaintNumber }]);
    const messageId = derivedMessageId(SIMULATED_LOAD_WORLD, "FORMAL_ANSWER", complaint.complaintId, turnId);
    const begun = await beginAnswer(complaints, { worldId: SIMULATED_LOAD_WORLD, complaintId: complaint.complaintId, messageId, body: ANSWER_BODY, outcome, actor: "AGENT", atSim });
    const settings = await connector.worlds.getSettings(SIMULATED_LOAD_WORLD);
    const attachments = await storeAnswerDocuments(
      { documents: () => ({ put: async (key: string, bytes: Uint8Array) => void rig.documents.set(key, bytes) }) },
      { complaint: begun.complaint, file: await connector.caseItems.caseFile(SIMULATED_LOAD_WORLD, complaint.complaintId), refunds: [], settings: settings!, attachments: [], body: ANSWER_BODY, outcome, issuedAtSim: atSim, registerHashes: { ...(begun.filedHash === undefined ? {} : { filed: begun.filedHash }), finalAnswer: begun.finalAnswerHash } },
    );
    const sent = await gate({ worldId: SIMULATED_LOAD_WORLD, customerId, complaintId: complaint.complaintId, sender: "AGENT", channel: "EMAIL", kind: "FORMAL_ANSWER", text: ANSWER_BODY, subject: fill(EMAIL_TEXT.SUBJECT_ANSWER, { complaintNumber: complaint.complaintNumber }), attachments, refs: { source: "SIMULATED_LOAD", complaintNumber: complaint.complaintNumber }, turnId, messageId }, call(rig, "AGENT"));
    if (!sent.ok || sent.decision !== "ALLOWED" || sent.mailId === undefined) return { complaint: current, answer: sent.decision ?? (sent.ok ? "NO_MAIL" : sent.failure.error.code) };
    const done = await completeAnswer(complaints, { worldId: SIMULATED_LOAD_WORLD, complaintId: complaint.complaintId, messageId, mailId: sent.mailId, sentAtSim: atSim, outcome, actor: "AGENT", holidays });
    return { complaint: done.complaint, answer: "ALLOWED" };
  }

  return {
    rig,
    gate,
    async run(input, index) {
      const customerId = customerIdOf(index);
      phones.set(customerId, phoneOf(index));
      realNow = new Date(TEST_NOW.getTime() + index * REAL_SECONDS_PER_PRESENTATION * 1_000);
      rig.simNow = input.filedAtSim;
      const inboundId = `in-sl-${index + 1}`;
      await customerWrote(rig, customerId, input.filedAtSim);
      const rule = applyRules({ text: input.message, hasImage: input.receiptVariant !== undefined, openComplaints: [] });
      const classifiedByRule = input.kind === "CONSULTA" || (rule?.kind === "RECLAMO" && rule.type === input.type);
      // A presentation the rules miss goes, in the stage, to the model; the scripted model answers the file's type.
      const filed = await acknowledge(input, customerId, input.kind === "CONSULTA" ? "INFORMATION_REQUEST" : input.type, inboundId);
      await recordEmailConsent(complaints, { worldId: SIMULATED_LOAD_WORLD, complaintId: filed.complaint.complaintId, decision: "ACCEPTED", textVersion: CURRENT_EMAIL_CONSENT.version, atSim: input.filedAtSim, actor: "SYSTEM" });
      const answered = await answer(filed.complaint, input, customerId, index);
      const sentAt = answered.complaint.answer?.sentAtSim;
      return {
        input,
        classifiedByRule,
        complaint: answered.complaint,
        ack: filed.ack,
        answer: answered.answer,
        row: {
          complaintId: answered.complaint.complaintId,
          complaintType: answered.complaint.type,
          agentMode: "SCRIPTED",
          origin: "LIVE",
          ...(sentAt === undefined ? {} : { answeredOnTime: Date.parse(sentAt) <= Date.parse(answered.complaint.deadlineSim), resolvedWithoutHuman: true }),
          ...(answered.complaint.answer?.deliveryProof === undefined ? {} : { deliveryProof: answered.complaint.answer.deliveryProof }),
          humanActions: [],
          tokens: { in: 0, out: 0, cached: 0 },
          messages: { wa: 1, email: sentAt === undefined ? 0 : 1 },
          atSim: input.filedAtSim,
        },
      };
    },
  };
}
