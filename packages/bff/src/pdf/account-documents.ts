// Bodies of the documents about the loan and the account: the debt-free certificate
// (`PAYOFF_CERTIFICATE`), the credit note of a reversal or refund (`CREDIT_NOTE`), the loan statement
// (`STATEMENT`) and the formal debt notice (`COLLECTION_NOTICE`, only from an operator's reroute,
// with no free text: every line is a fixed text or a figure of the core). Totals are added up here.
import { formatPesos } from "@reclamo/shared";
import { PDF_COMMON, PDF_DOC, PDF_INSTALMENT_STATUS, fill } from "../copy";
import { sumCents } from "../services/money";
import type { DocumentBody } from "./complaint-documents";
import { calendarDate, dateAr, dateTimeAr, percent } from "./format";
import { field, heading, paragraph, table } from "./layout";
import type { DocumentInputOf } from "./schemas";

export function payoffCertificateBody(input: DocumentInputOf<"PAYOFF_CERTIFICATE">): DocumentBody {
  const texts = PDF_DOC.PAYOFF_CERTIFICATE;
  return {
    subject: fill(texts.SUBJECT, { loanLabel: input.loan.label }),
    body: [
      ...field(texts.LOAN, input.loan.label),
      ...field(texts.PRINCIPAL, formatPesos(input.loan.principalCents)),
      ...field(texts.CANCELLED_AT, dateAr(input.loan.cancelledAtSim)),
      ...paragraph(texts.STATEMENT, { font: "bold", gapBefore: 16 }),
    ],
  };
}

export function creditNoteBody(input: DocumentInputOf<"CREDIT_NOTE">): DocumentBody {
  const texts = PDF_DOC.CREDIT_NOTE;
  return {
    subject: fill(texts.SUBJECT, { creditNoteId: input.creditNoteId }),
    body: [
      ...field(PDF_COMMON.DOCUMENT, input.creditNoteId),
      ...field(texts.CONCEPT, input.concept),
      ...field(texts.AMOUNT, formatPesos(input.amountCents)),
      ...field(texts.COMPENSATORY_INTEREST, formatPesos(input.interestCents)),
      ...paragraph(fill(texts.RATE, { rate: percent(input.annualRate) })),
      ...field(texts.TOTAL, formatPesos(sumCents([input.amountCents, input.interestCents]))),
      ...field(texts.CREDITED_AT, dateAr(input.creditedAtSim)),
    ],
  };
}

export function statementBody(input: DocumentInputOf<"STATEMENT">): DocumentBody {
  const texts = PDF_DOC.STATEMENT;
  const instalments = table(
    [
      { header: texts.INSTALMENT, width: 48 },
      { header: texts.DUE_DATE, width: 82 },
      { header: texts.AMOUNT, width: 88, align: "right" },
      { header: texts.PAID, width: 88, align: "right" },
      { header: texts.OUTSTANDING, width: 88, align: "right" },
      { header: texts.STATUS, width: 89 },
    ],
    [...input.instalments]
      .sort((a, b) => a.number - b.number)
      .map((row) => [
        String(row.number),
        calendarDate(row.dueDate),
        formatPesos(row.amountCents),
        formatPesos(row.paidCents),
        formatPesos(row.outstandingCents),
        PDF_INSTALMENT_STATUS[row.status],
      ]),
  );
  const payments =
    input.payments.length === 0
      ? []
      : [
          ...heading(texts.PAYMENTS),
          ...table(
            [
              { header: texts.INSTALMENT, width: 48 },
              { header: texts.APPLIED_AT, width: 130 },
              { header: texts.AMOUNT, width: 120, align: "right" },
            ],
            [...input.payments]
              .sort((a, b) => Date.parse(a.appliedAtSim) - Date.parse(b.appliedAtSim) || a.instalment - b.instalment)
              .map((payment) => [String(payment.instalment), dateTimeAr(payment.appliedAtSim), formatPesos(payment.amountCents)]),
          ),
        ];
  return {
    subject: fill(texts.SUBJECT, { loanLabel: input.loan.label }),
    body: [
      ...field(PDF_DOC.PAYOFF_CERTIFICATE.LOAN, input.loan.label),
      ...instalments,
      ...payments,
      ...field(texts.LOAN_OUTSTANDING, formatPesos(input.loan.outstandingCents)).map((row, index) => (index === 0 ? { ...row, gapBefore: 12 } : row)),
    ],
  };
}

export function collectionNoticeBody(input: DocumentInputOf<"COLLECTION_NOTICE">): DocumentBody {
  const texts = PDF_DOC.COLLECTION_NOTICE;
  const overdue = [...input.overdue].sort((a, b) => a.number - b.number);
  const total = sumCents(overdue.map((row) => row.amountCents));
  return {
    subject: fill(texts.SUBJECT, { loanLabel: input.loan.label }),
    body: [
      ...field(texts.CREDITOR, fill(PDF_COMMON.CREDITOR_IDENTIFICATION, { cuit: input.creditor.cuit, address: input.creditor.address })),
      ...field(texts.LOAN, input.loan.label),
      ...heading(texts.OVERDUE_INSTALMENTS),
      ...table(
        [
          { header: PDF_DOC.STATEMENT.INSTALMENT, width: 60 },
          { header: texts.DUE_DATE, width: 120 },
          { header: texts.AMOUNT, width: 140, align: "right" },
        ],
        overdue.map((row) => [String(row.number), calendarDate(row.dueDate), formatPesos(row.amountCents)]),
      ),
      ...field(fill(texts.TOTAL, { dateText: dateAr(input.issuedAtSim) }), formatPesos(total)).map((row, index) => (index === 0 ? { ...row, gapBefore: 10 } : row)),
      ...paragraph(texts.SERVICE_CHANNELS, { gapBefore: 14 }),
      ...paragraph(texts.RIGHTS),
    ],
  };
}
