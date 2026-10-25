// Bodies of the documents about the complaint itself: the acknowledgement (`ACK`), the written
// answer (`ANSWER`) and the confirmations of a closure (`CLOSURE`) or a data change (`DATA_CHANGE`).
// `ACK` prints the hash of the complaint's `FILED` register entry and `ANSWER` the hashes of `FILED`
// and `FINAL_ANSWER`, so a delivered PDF can be checked against the register (ADR-0014).
import { formatPesos } from "@reclamo/shared";
import {
  COMPLAINT_OUTCOME_LABEL,
  COMPLAINT_TYPE_LABEL,
  DATA_CHANGE_FIELD_LABEL,
  PDF_CHANNEL_LABEL,
  PDF_COMMON,
  PDF_DOC,
  capitalize,
  fill,
} from "../copy";
import { dateAr, dateTimeAr } from "./format";
import { bullets, field, hashRow, heading, paragraph, table, textRow } from "./layout";
import type { DocumentInputOf } from "./schemas";
import type { PdfRow } from "./writer";

/** What each document builder returns: its body and the values of its `Subject` placeholders. */
export interface DocumentBody {
  readonly body: readonly PdfRow[];
  readonly subject: string;
}

export function ackBody(input: DocumentInputOf<"ACK">): DocumentBody {
  const texts = PDF_DOC.ACK;
  return {
    subject: fill(texts.SUBJECT, { complaintNumber: input.complaintNumber }),
    body: [
      ...field(PDF_COMMON.COMPLAINT_TYPE, capitalize(COMPLAINT_TYPE_LABEL[input.type])),
      ...field(PDF_COMMON.FILED_AT, dateTimeAr(input.filedAtSim)),
      ...field(PDF_COMMON.CHANNEL, PDF_CHANNEL_LABEL[input.channel]),
      ...field(texts.DEADLINE, fill(texts.DEADLINE_VALUE, { deadlineText: dateAr(input.deadlineSim) })),
      ...heading(texts.NEXT_STEPS_TITLE),
      ...paragraph(texts.NEXT_STEPS),
      ...heading(texts.REGISTER_HASH),
      hashRow(input.filedHash),
    ],
  };
}

export function answerBody(input: DocumentInputOf<"ANSWER">): DocumentBody {
  const texts = PDF_DOC.ANSWER;
  const actions =
    input.actions.length === 0
      ? paragraph(texts.NO_ACTIONS)
      : table(
          [
            { header: "", width: 343 },
            { header: PDF_DOC.STATEMENT.AMOUNT, width: 140, align: "right" },
          ],
          input.actions.map((action) => [action.label, formatPesos(action.amountCents)]),
        );
  const attachments = input.attachments.length === 0 ? [] : [...heading(texts.ATTACHMENTS), ...bullets(input.attachments.map((kind) => PDF_DOC[kind].TITLE))];
  return {
    subject: fill(texts.SUBJECT, { complaintNumber: input.complaintNumber }),
    body: [
      ...field(PDF_COMMON.COMPLAINT_TYPE, capitalize(COMPLAINT_TYPE_LABEL[input.type])),
      ...field(PDF_COMMON.FILED_AT, dateTimeAr(input.filedAtSim)),
      ...field(texts.OUTCOME, COMPLAINT_OUTCOME_LABEL[input.outcome]),
      ...heading(texts.FACTS),
      ...bullets(input.facts),
      ...heading(texts.RESOLUTION),
      ...paragraph(input.resolution),
      ...heading(texts.ACTIONS),
      ...actions,
      ...attachments,
      ...paragraph(PDF_COMMON.BCRA_RIGHT, { gapBefore: 14 }),
      textRow(PDF_COMMON.SIGNATURE, { font: "bold", gapBefore: 14 }),
      ...heading(texts.REGISTER_HASHES),
      hashRow(input.registerHashes.filed, "FILED"),
      hashRow(input.registerHashes.finalAnswer, "FINAL_ANSWER"),
    ],
  };
}

export function closureBody(input: DocumentInputOf<"CLOSURE">): DocumentBody {
  const texts = PDF_DOC.CLOSURE;
  return {
    subject: fill(texts.SUBJECT, { complaintNumber: input.complaintNumber }),
    body: [
      ...field(texts.REQUESTED_AT, dateTimeAr(input.requestedAtSim)),
      ...field(texts.ACCOUNT_STATUS, texts.CLOSING),
      ...(input.conditions.length === 0 ? [] : [...heading(texts.CONDITIONS), ...bullets(input.conditions)]),
    ],
  };
}

export function dataChangeBody(input: DocumentInputOf<"DATA_CHANGE">): DocumentBody {
  const texts = PDF_DOC.DATA_CHANGE;
  return {
    subject: fill(texts.SUBJECT, { complaintNumber: input.complaintNumber }),
    body: [
      ...field(texts.FIELD, capitalize(DATA_CHANGE_FIELD_LABEL[input.field])),
      ...field(texts.REQUESTED_AT, dateTimeAr(input.requestedAtSim)),
      ...field(texts.STATUS, texts[input.status]),
    ],
  };
}
