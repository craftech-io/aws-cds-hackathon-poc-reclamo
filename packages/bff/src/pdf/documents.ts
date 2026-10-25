// The eight PDF documents of the product (docs/architecture-integrations.md §8). `renderDocument`
// validates its input, lays out the document and writes it. Every page carries the lender's
// letterhead ("prestamista ficticio"), the product line, the complaint number, the issue date in the
// world's time and the synthetic-data legend; the metadata are fixed (`Title`, `Subject`,
// `Producer`, no author, no dates). Same input, same bytes: only `issuedAtSim` moves the date
// printed on the page, and it is always written with the same width.
import { type DocKind, PDF_COMMON, PDF_DOC, fill } from "../copy";
import { sha256Hex } from "../lib/crypto";
import { collectionNoticeBody, creditNoteBody, payoffCertificateBody, statementBody } from "./account-documents";
import { type DocumentBody, ackBody, answerBody, closureBody, dataChangeBody } from "./complaint-documents";
import { dateTimeAr } from "./format";
import { field, textRow, title } from "./layout";
import { textWidth } from "./metrics";
import { DocumentInput } from "./schemas";
import { CONTENT_WIDTH, MARGIN_X, type PdfRow, writePdf } from "./writer";

export interface RenderedDocument {
  readonly docKind: DocKind;
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex: what the email record and the snapshot show. */
  readonly sha256: string;
  /** Attachment name: the complaint number and the document's title, ASCII only. */
  readonly fileName: string;
  readonly contentType: "application/pdf";
  readonly title: string;
  readonly subject: string;
  readonly pageCount: number;
}

const FOOTER_SIZE = 8;

function bodyOf(input: DocumentInput): DocumentBody {
  switch (input.docKind) {
    case "ACK":
      return ackBody(input);
    case "ANSWER":
      return answerBody(input);
    case "PAYOFF_CERTIFICATE":
      return payoffCertificateBody(input);
    case "CREDIT_NOTE":
      return creditNoteBody(input);
    case "STATEMENT":
      return statementBody(input);
    case "CLOSURE":
      return closureBody(input);
    case "DATA_CHANGE":
      return dataChangeBody(input);
    case "COLLECTION_NOTICE":
      return collectionNoticeBody(input);
  }
}

const HEADER: readonly PdfRow[] = [
  textRow(PDF_COMMON.LETTERHEAD, { font: "bold", size: 11 }),
  textRow(PDF_COMMON.BRAND, { size: 8.5, muted: true, rule: true }),
];

function footer(page: number, pages: number): PdfRow[] {
  const pageText = fill(PDF_COMMON.PAGE, { page: String(page), pages: String(pages) });
  const pageX = MARGIN_X + CONTENT_WIDTH - textWidth(pageText, "regular", FOOTER_SIZE);
  return [
    {
      runs: [
        { text: PDF_COMMON.SYNTHETIC_LEGEND, x: MARGIN_X, font: "bold", size: FOOTER_SIZE, muted: true },
        { text: pageText, x: pageX, font: "regular", size: FOOTER_SIZE, muted: true },
      ],
      height: FOOTER_SIZE + 4,
    },
  ];
}

/** "R-2026-000001-acuse-de-recibo.pdf": ASCII, no spaces, from the number and the title. */
export function documentFileName(docTitle: string, complaintNumber?: string): string {
  const slug = docTitle
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${complaintNumber === undefined ? "" : `${complaintNumber}-`}${slug}.pdf`;
}

/**
 * Validates `raw` against the input of its `docKind` (zod; a `ZodError` on anything else) and
 * returns the PDF.
 */
export function renderDocument(raw: unknown): RenderedDocument {
  const input = DocumentInput.parse(raw);
  const docTitle = PDF_DOC[input.docKind].TITLE;
  const { body, subject } = bodyOf(input);
  const preamble = [
    ...title(docTitle),
    ...(input.complaintNumber === undefined ? [] : field(PDF_COMMON.COMPLAINT_NUMBER, input.complaintNumber)),
    ...field(PDF_COMMON.ISSUED_AT, dateTimeAr(input.issuedAtSim)),
    ...(input.customerName === undefined ? [] : field(PDF_COMMON.CUSTOMER, input.customerName)),
  ];
  const { bytes, pageCount } = writePdf({
    info: [
      ["Title", docTitle],
      ["Subject", subject],
      ["Producer", PDF_COMMON.PRODUCER],
    ],
    header: HEADER,
    footer,
    body: [...preamble, ...body.map((row, index) => (index === 0 ? { ...row, gapBefore: Math.max(row.gapBefore ?? 0, 10) } : row))],
  });
  return {
    docKind: input.docKind,
    bytes,
    sha256: sha256Hex(bytes),
    fileName: documentFileName(docTitle, input.complaintNumber),
    contentType: "application/pdf",
    title: docTitle,
    subject,
    pageCount,
  };
}
