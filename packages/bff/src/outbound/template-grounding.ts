// Template parameters grounded by KIND (docs/architecture-integrations.md §4 step 4): the tool's own
// pre-check (agent-tools/messaging/send-whatsapp.ts) and the gate's verification (outbound/verify.ts)
// apply the same rules over the same facts (this turn's results and the message's complaint), so a value
// one lets through the other never refuses, and a fragment of a value never passes either:
//
//   COMPLAINT_NUMBER  `R-AAAA-NNNNNN` and EXACTLY a `complaintNumber` a tool returned this turn, or the
//                     number of the complaint the message is about
//   DEADLINE_TEXT     `<weekday> DD/MM` and EXACTLY a `deadlineText` a tool returned this turn, or the
//                     deadline of the complaint the message is about
//   EMAIL_MASKED      exactly an `emailMasked` the core returned
//   FIRST_NAME        exactly a `firstName` the core returned (identify_customer, get_customer)
//   STATUS_PHRASE     never compared: the closed list decides it
//
// Values are compared normalized (NFC, trimmed, spaces collapsed, lower case).
import { deadlineText } from "../complaints/sla";
import type { TemplateParamKind } from "../copy/types";

export const COMPLAINT_NUMBER_FORMAT = /^R-\d{4}-\d{6}$/;
/** How `complaints/sla.ts deadlineText` writes a deadline: "jueves 22/10". */
export const DEADLINE_TEXT_FORMAT = /^(lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d{2}\/\d{2}$/;

/** The result field each grounded parameter is copied from. */
const SOURCE_FIELD: Readonly<Partial<Record<TemplateParamKind, string>>> = { COMPLAINT_NUMBER: "complaintNumber", DEADLINE_TEXT: "deadlineText", EMAIL_MASKED: "emailMasked", FIRST_NAME: "firstName" };
const SOURCE_FIELDS: ReadonlySet<string> = new Set(Object.values(SOURCE_FIELD));
/** The format a value must have before it is looked up: the number as written, the deadline normalized. */
function hasFormat(kind: TemplateParamKind, value: string, normalized: string): boolean {
  if (kind === "COMPLAINT_NUMBER") return COMPLAINT_NUMBER_FORMAT.test(value.trim());
  if (kind === "DEADLINE_TEXT") return DEADLINE_TEXT_FORMAT.test(normalized);
  return true;
}
const MAX_DEPTH = 12;

export interface GroundingFacts {
  /** Values of the source fields (`complaintNumber`, `deadlineText`, `emailMasked`, `firstName`), normalized. */
  readonly byField: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The complaint a message is about, as both checks read it. */
export interface MessageComplaint {
  readonly complaintNumber: string;
  readonly deadlineSim: string;
}

export function normalizedValue(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The message's complaint as a grounding fact: its number and its deadline, as the tools write them. */
export function complaintFactsOf(complaint: MessageComplaint | undefined): readonly { readonly complaint: { readonly complaintNumber: string; readonly deadlineText: string } }[] {
  return complaint === undefined ? [] : [{ complaint: { complaintNumber: complaint.complaintNumber, deadlineText: deadlineText(complaint.deadlineSim) } }];
}

/** What the results and the message's complaint ground a template parameter with. */
export function groundingFactsOf(results: readonly unknown[], complaint?: MessageComplaint): GroundingFacts {
  const byField = new Map<string, Set<string>>();
  const addField = (field: string, value: string) => {
    const set = byField.get(field) ?? new Set<string>();
    set.add(normalizedValue(value));
    byField.set(field, set);
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && SOURCE_FIELDS.has(key)) addField(key, item);
      walk(item, depth + 1);
    }
  };
  for (const result of results) walk(result, 0);
  if (complaint !== undefined) {
    addField("complaintNumber", complaint.complaintNumber);
    addField("deadlineText", deadlineText(complaint.deadlineSim));
  }
  return { byField };
}

/** Whether a template parameter of `kind` is grounded in the facts. */
export function templateParamGrounded(kind: TemplateParamKind, value: string, facts: GroundingFacts): boolean {
  if (kind === "STATUS_PHRASE") return true;
  const wanted = normalizedValue(value);
  if (wanted === "") return false;
  if (!hasFormat(kind, value, wanted)) return false;
  const field = SOURCE_FIELD[kind];
  return field !== undefined && (facts.byField.get(field)?.has(wanted) ?? false);
}
