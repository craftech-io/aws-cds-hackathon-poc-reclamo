// The agent's side of the guided tour's replay (docs/seed-spec.md §14, invariants 18 to 22): a plan
// source for the scripted Harness of the local flows (tests/flows/support/scripted-harness.ts) that
// answers each turn of the tour's personas the way the system prompt asks the model to, through the
// same Gateway, Cedar statements and tool fences as the stage. It decides nothing the code decides:
// amounts, caps, eligibility, the reconciliation of a reading and the written answer's attachments
// stay with the tools and the worker's obligations; the plan only chooses which tool to call next.
//
//   not identified        the challenge the preloaded `identify_customer` asks (fixed text of copy/)
//   the challenge answer  `verify_challenge`, then the investigation of the complaint's type:
//                         a receipt is read (the code reconciles it), a charge is checked and reversed,
//                         a duplicate debit is checked and, above the cap, sent for approval
//   a settlement          `reconcile_payment` → `apply_payment` → RESOLVED → an update to the customer
//   an approval decided   RESOLVED → an update (the worker executed the action re-reading the approval)
//   ANSWER_DUE            the written answer and the resolution notice
import { PERSONA_SCRIPTS } from "@reclamo/bff/copy/persona-scripts";
import type { CallResult, PlanSource, PlannedCall, ScriptedTurn } from "../../tests/flows/support/scripted-harness";

/** A tool's successful output, or an empty record when it failed (the next call then fails loudly in its own result). */
function outputOf(result: CallResult | undefined): Readonly<Record<string, unknown>> {
  if (result?.answer.kind !== "RESULT" || !result.answer.response.ok) return {};
  return result.answer.response as Readonly<Record<string, unknown>>;
}

function lastOf(earlier: readonly CallResult[], tool: string): Readonly<Record<string, unknown>> {
  return outputOf([...earlier].reverse().find((result) => result.tool === tool));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface Preloaded {
  readonly status?: string;
  readonly challenge?: { readonly promptText?: string };
}

/** A date as a customer types it ("5/10", "10/9"): the only answer the challenge of the tour asks. */
const CHALLENGE_ANSWER = /^\d{1,2}\/\d{1,2}$/;

const UPDATE_TEXT = "Ya revisamos tu reclamo y quedó resuelto. Te mandamos la respuesta escrita por email.";
const RESOLUTION_TEXT = "Tu reclamo fue resuelto. Te mandamos la respuesta escrita por email.";
const ANSWER_DRAFT: Readonly<Record<string, string>> = {
  PAYMENT_NOT_REFLECTED: "Revisamos tu reclamo: tu pago ya figura imputado en tu préstamo. Adjuntamos el estado de cuenta.",
  UNRECOGNIZED_CHARGE: "Revisamos tu reclamo: el cargo no correspondía y lo revertimos. Adjuntamos la nota de crédito.",
  DUPLICATE_DEBIT: "Revisamos tu reclamo: el débito estaba duplicado y te reintegramos el importe. Adjuntamos la nota de crédito.",
};

/** The fact the worker put in the envelope about the turn's complaint. */
function complaintFact(turn: ScriptedTurn): Readonly<Record<string, string>> {
  return turn.facts.find((fact) => fact.name === "complaint")?.attributes ?? {};
}

function sendUpdate(kind: "COMPLAINT_UPDATE" | "RESOLUTION_NOTICE", body: string): PlannedCall {
  return { tool: "send_whatsapp", input: { kind, text: body } };
}

/** Receipt variants the scenario knows to be invalid: the model hands them to a person without accusing anyone (FL-020). */
const DOUBTFUL_VARIANTS: ReadonlySet<string> = new Set(["fake-check"]);

/** The receipt variant of the persona whose script message this is, if it carries one. */
function scriptVariantOf(inbound: string | undefined): string | undefined {
  const message = PERSONA_SCRIPTS.flatMap((script) => script.messages).find((candidate) => candidate.text === inbound);
  return message?.attachment?.kind === "RECEIPT_IMAGE" ? message.attachment.variant : undefined;
}

/** The investigation of a complaint once the customer is identified, by its type. */
function investigation(type: string, evidence: readonly string[], variant: string | undefined): PlannedCall[] {
  if (type === "PAYMENT_NOT_REFLECTED") {
    const reads: PlannedCall[] = evidence.map((evidenceId) => ({ tool: "read_receipt", input: { evidenceId } }));
    if (variant === undefined || !DOUBTFUL_VARIANTS.has(variant)) return reads;
    return [...reads, { tool: "escalate_to_human", input: { reason: "RECEIPT_DOUBT", summary: "El comprobante no pasó la validación: lo revisa una persona." } }];
  }
  if (type === "UNRECOGNIZED_CHARGE") {
    return [
      { tool: "list_operations", input: { kind: "CHARGE" } },
      {
        tool: "check_charge",
        input: (earlier) => {
          const operations = (lastOf(earlier, "list_operations").operations ?? []) as readonly { readonly ref?: { readonly chargeId?: string } }[];
          return { chargeId: operations.map((operation) => operation.ref?.chargeId).find((chargeId) => chargeId !== undefined) ?? "" };
        },
      },
      { tool: "reverse_charge", input: (earlier) => ({ chargeCheckId: text(lastOf(earlier, "check_charge").chargeCheckId) }) },
      { tool: "update_complaint", input: { status: "RESOLVED", outcome: "IN_FAVOUR" } },
      sendUpdate("COMPLAINT_UPDATE", UPDATE_TEXT),
    ];
  }
  if (type === "DUPLICATE_DEBIT") {
    return [
      { tool: "check_duplicate_debit", input: {} },
      { tool: "refund_duplicate_debit", input: (earlier) => ({ duplicateCheckId: text(lastOf(earlier, "check_duplicate_debit").duplicateCheckId) }) },
      {
        tool: "request_operator_approval",
        input: (earlier) => ({ evidenceId: text(lastOf(earlier, "check_duplicate_debit").evidenceId), justification: "Débito duplicado de la misma cuota, por encima del tope del agente." }),
      },
    ];
  }
  return [];
}

/** The reading of the last receipt of a complaint the replay read, from the Harness's results so far. */
function readingOf(results: readonly CallResult[], evidenceIds: ReadonlySet<string>): string {
  const read = [...results].reverse().find((result) => result.tool === "read_receipt" && evidenceIds.has(text(result.input.evidenceId)));
  return text(outputOf(read).readingId);
}

/**
 * A fresh plan source for one replay over `results` (the scripted Harness's calls so far): it
 * remembers, per complaint number, the receipt images still to read and the ones it read, whose
 * reading the settlement's turn reconciles.
 */
export function tourAutopilot(results: () => readonly CallResult[]): PlanSource {
  const pendingOf = new Map<string, string[]>();
  const readOf = new Map<string, Set<string>>();
  const variantOf = new Map<string, string>();

  return (turn) => {
    const complaint = complaintFact(turn);
    const number = complaint.number ?? "";
    const pending = pendingOf.get(number) ?? [];
    for (const attachment of turn.attachments) if (attachment.evidenceId !== undefined && attachment.status === "PENDING_READ") pending.push(attachment.evidenceId);
    pendingOf.set(number, pending);
    const identity = turn.preloaded.identify_customer as Preloaded | undefined;
    const type = complaint.type ?? "";
    const variant = scriptVariantOf(turn.inbound);
    if (variant !== undefined && !variantOf.has(number)) variantOf.set(number, variant);

    switch (turn.event.type) {
      case "CUSTOMER_MESSAGE":
      case "RECEIPT_RECEIVED": {
        if (identity?.status !== "NEEDS_CHALLENGE") return [];
        if (turn.inbound !== undefined && CHALLENGE_ANSWER.test(turn.inbound)) {
          const read = readOf.get(number) ?? new Set<string>();
          for (const evidenceId of pending) read.add(evidenceId);
          readOf.set(number, read);
          pendingOf.set(number, []);
          return { calls: [{ tool: "verify_challenge", input: { answer: turn.inbound } }, ...investigation(type, pending, variantOf.get(number))], note: `investigating ${number}` };
        }
        return [{ tool: "send_whatsapp", input: { kind: "IDENTITY_CHALLENGE", text: identity.challenge?.promptText ?? "" } }];
      }
      case "SETTLEMENT_PUBLISHED":
      case "RECONCILE_DUE":
        return [
          { tool: "reconcile_payment", input: () => ({ source: "SETTLEMENT", readingId: readingOf(results(), readOf.get(number) ?? new Set()) }) },
          { tool: "apply_payment", input: (earlier) => ({ reconciliationId: text(lastOf(earlier, "reconcile_payment").reconciliationId) }) },
          { tool: "update_complaint", input: { status: "RESOLVED", outcome: "IN_FAVOUR" } },
          sendUpdate("COMPLAINT_UPDATE", UPDATE_TEXT),
        ];
      case "APPROVAL_DECIDED":
        return [{ tool: "update_complaint", input: { status: "RESOLVED", outcome: "IN_FAVOUR" } }, sendUpdate("COMPLAINT_UPDATE", UPDATE_TEXT)];
      case "ANSWER_DUE":
        return [
          { tool: "answer_complaint_in_writing", input: { outcome: "IN_FAVOUR", draftBody: ANSWER_DRAFT[type] ?? UPDATE_TEXT } },
          sendUpdate("RESOLUTION_NOTICE", RESOLUTION_TEXT),
        ];
      default:
        return [];
    }
  };
}
