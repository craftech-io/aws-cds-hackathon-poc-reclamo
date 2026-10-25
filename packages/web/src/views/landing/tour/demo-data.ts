// The synthetic case the landing's renders draw (docs/landing-spec.md §3.1): Valeria Quiroga (`C01`)
// and her complaint `R-2026-000123` of the `demo` world, and the blocked collection attempt for Martín
// Olmedo (`C09`), with the figures of docs/seed-spec.md §8 and docs/flows-catalog.md FL-010/FL-064.
// Every text a customer or an operator reads comes from packages/bff/src/copy (the same source the
// gate, the emails and the console use) with its English gloss; nothing here is a new product text.
import { buttonGloss } from "@reclamo/bff/copy/buttons";
import { COMPLAINT_TYPE_GLOSS, EMAIL_GLOSS, MESSAGE_KIND_GLOSS, REROUTE_GLOSS, SLA_STATE_GLOSS, STAFF_GLOSS, WHATSAPP_GLOSS } from "@reclamo/bff/copy/en-gloss";
import { COMPLAINT_TYPE_LABEL, EMAIL_TEXT, MESSAGE_KIND_LABEL, STAFF_TEXT, WHATSAPP_TEXT } from "@reclamo/bff/copy/es-AR";
import { REROUTE_LABEL } from "@reclamo/bff/copy/block-reasons";
import { fill } from "@reclamo/bff/copy/helpers";
import { PDF_COMMON, PDF_DOC } from "@reclamo/bff/copy/pdf-texts";
import type { Glossed } from "@reclamo/bff/copy/types";
import { pesosFromCents, type Money } from "@reclamo/shared";
import type { TapeRowEntry } from "../../../components/TapeRow";
import { CUSTOMER_MESSAGE, CUSTOMER_NAME } from "./main-story";

export const COMPLAINT_NUMBER = "R-2026-000123";
const DEADLINE: Glossed = { es: "jueves 22/10", en: "Thursday 22/10" };
const COMPLAINT_TYPE: Glossed = { es: COMPLAINT_TYPE_LABEL.PAYMENT_NOT_REFLECTED, en: COMPLAINT_TYPE_GLOSS.PAYMENT_NOT_REFLECTED };
const FILED_AT = "07/10/2026";

/** Both halves of a fixed text filled with the same values (the gloss keeps the Spanish placeholders' names). */
function filled(es: string, en: string, params: Readonly<Record<string, Glossed | string>>): Glossed {
  const pick = (lang: keyof Glossed) => Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value === "string" ? value : value[lang]]));
  return { es: fill(es, pick("es")), en: fill(en, pick("en")) };
}

export const SIMULATOR_LABEL: Glossed = { es: STAFF_TEXT.SIMULATOR_LABEL, en: STAFF_GLOSS.SIMULATOR_LABEL };

export { CUSTOMER_MESSAGE, CUSTOMER_NAME };

/** The automated-assistant line the gate puts before the first outbound message. */
export const DISCLOSURE: Glossed = { es: WHATSAPP_TEXT.AUTOMATED_DISCLOSURE, en: WHATSAPP_GLOSS.AUTOMATED_DISCLOSURE };

export const ACK_MESSAGE: Glossed = filled(WHATSAPP_TEXT.COMPLAINT_ACK, WHATSAPP_GLOSS.COMPLAINT_ACK, {
  complaintNumber: COMPLAINT_NUMBER,
  complaintType: COMPLAINT_TYPE,
  deadlineText: DEADLINE,
});

export const ACK_BUTTONS: readonly Glossed[] = [buttonGloss("ACCEPT_EMAIL", "INTERACTIVE"), buttonGloss("TALK_TO_HUMAN", "INTERACTIVE")];

export const COMPLAINT_TYPE_TEXT = COMPLAINT_TYPE;
export const DEADLINE_TEXT = DEADLINE;
export const BUSINESS_DAYS_LEFT = 10;
/** The English half of the console's SLA chip ("En plazo · 10 días hábiles"). */
export const SLA_GLOSS = `${SLA_STATE_GLOSS.ON_TIME} · ${BUSINESS_DAYS_LEFT} business days`;

const INSTALMENT: Money = pesosFromCents(11_864_000);

/** The receipt as the reader returns it, and the line of the published settlement file it matches. */
export const EVIDENCE = {
  network: "Red de cobro Norte",
  paidAt: "06/10/2026 18:40",
  amount: INSTALMENT,
  code: "NTE-20261006-004817",
  settlement: { batch: "NORTE · 07/10/2026", customer: CUSTOMER_NAME, loan: "L-0001", amount: INSTALMENT, code: "NTE-20261006-004817" },
} as const;

/** Written answer by email (FL-017): the fixed parts of copy/es-AR.ts; the agent's draft goes in between. */
export const ANSWER_EMAIL = {
  from: { es: EMAIL_TEXT.FROM_NAME, en: EMAIL_GLOSS.FROM_NAME } satisfies Glossed,
  to: "v•••@…",
  subject: filled(EMAIL_TEXT.SUBJECT_ANSWER, EMAIL_GLOSS.SUBJECT_ANSWER, { complaintNumber: COMPLAINT_NUMBER }),
  greeting: filled(EMAIL_TEXT.GREETING, EMAIL_GLOSS.GREETING, { firstName: "Valeria" }),
  intro: filled(EMAIL_TEXT.ANSWER_INTRO, EMAIL_GLOSS.ANSWER_INTRO, { complaintNumber: COMPLAINT_NUMBER, complaintType: COMPLAINT_TYPE, filedAtText: FILED_AT }),
  attachments: { es: EMAIL_TEXT.ANSWER_ATTACHMENTS, en: EMAIL_GLOSS.ANSWER_ATTACHMENTS } satisfies Glossed,
  footer: { es: EMAIL_TEXT.FOOTER_SYNTHETIC, en: EMAIL_GLOSS.FOOTER_SYNTHETIC } satisfies Glossed,
  pdfName: `respuesta-${COMPLAINT_NUMBER}.pdf`,
} as const;

/** The first page of the answer PDF: letterhead, title and the register hashes printed on it. */
export const ANSWER_PDF = {
  letterhead: PDF_COMMON.LETTERHEAD,
  title: PDF_DOC.ANSWER.TITLE,
  hashesLabel: PDF_DOC.ANSWER.REGISTER_HASHES,
  hashes: ["3f9a1c07…b62e", "a41d77e2…09c5"],
  legend: PDF_COMMON.SYNTHETIC_LEGEND,
} as const;

/** The operator's "Recordatorio de mora" on WhatsApp for C09, blocked, rerouted and sent by email. */
export const TAPE_ENTRIES: readonly TapeRowEntry[] = [
  { decision: "BLOCKED", sender: "operator-02", channel: "WHATSAPP", kind: "COLLECTION_REMINDER", ruleIds: ["CH-WA-NO-COLLECTION"], atText: "07/10 10:42" },
  { decision: "REROUTED", sender: "operator-02", channel: "EMAIL", kind: "COLLECTION_NOTICE_EMAIL", ruleIds: ["CH-WA-NO-COLLECTION", "CH-KIND-CHANNEL"], atText: "07/10 10:42" },
  { decision: "ALLOWED", sender: "operator-02", channel: "EMAIL", kind: "COLLECTION_NOTICE_EMAIL", ruleIds: ["CH-KIND-CHANNEL", "CH-FORMAL-CONTENT"], atText: "07/10 10:43" },
];

export const TAPE_KIND_LABEL: Readonly<Record<string, Glossed>> = {
  COLLECTION_REMINDER: { es: MESSAGE_KIND_LABEL.COLLECTION_REMINDER, en: MESSAGE_KIND_GLOSS.COLLECTION_REMINDER },
  COLLECTION_NOTICE_EMAIL: { es: MESSAGE_KIND_LABEL.COLLECTION_NOTICE_EMAIL, en: MESSAGE_KIND_GLOSS.COLLECTION_NOTICE_EMAIL },
};

export const TAPE_TARGET = "Martín Olmedo";

export const REROUTE_TEXT: Glossed = { es: REROUTE_LABEL.FORMAL_EMAIL, en: REROUTE_GLOSS.FORMAL_EMAIL };

/** Entries of the complaint register for R-2026-000123: filed and finally answered, both anchored. */
export const REGISTER_ROWS = [
  { seq: 123, number: COMPLAINT_NUMBER, event: "FILED", hash: "3f9a1c07…b62e", anchored: true },
  { seq: 131, number: COMPLAINT_NUMBER, event: "FINAL_ANSWER", hash: "a41d77e2…09c5", anchored: true },
] as const;

/** Channel rules that let the written answer out by email. */
export const ANSWER_RULES = ["CH-KIND-CHANNEL", "CH-FORMAL-CONTENT", "CH-RECIPIENT-FENCE"] as const;
