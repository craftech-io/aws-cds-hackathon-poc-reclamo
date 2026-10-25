// Input of each PDF document (docs/architecture-integrations.md §8), validated with zod before
// anything is laid out. Facts, amounts, dates and hashes come from the core, the register and the
// complaint (the caller reads them); the fixed texts come from copy/pdf-texts.ts. Totals are not an
// input: the documents add them up. The formal debt notice takes no free text at all.
import { z } from "zod";
import { CalendarDate, Channel, ComplaintNumber, ComplaintOutcome, ComplaintType, IsoInstant } from "@reclamo/shared";
import { DataChangeField } from "../copy";
import { HexHash, Id } from "../domain/common";

const NO_CONTROL = /^[^\p{Cc}]*$/u;

/** One line of text from code (a label, a name, a condition): no control characters. */
const Line = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL, "control characters are not allowed");

/** A paragraph that may span several lines (the resolution of a written answer). */
const Paragraphs = z
  .string()
  .trim()
  .min(1)
  .max(6_000)
  .refine((text) => NO_CONTROL.test(text.replace(/\r?\n/g, "")), "control characters other than line breaks are not allowed");

const Cents = z.number().int().min(0).max(10_000_000_000);
const PositiveCents = Cents.min(1);
const InstalmentNumber = z.number().int().min(1).max(18);

/** CUIT check digit (mod 11 with the weights 5432765432): `undefined` when the prefix has none. */
export function cuitCheckDigit(firstTen: string): number | undefined {
  if (!/^\d{10}$/.test(firstTen)) return undefined;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = [...firstTen].reduce((total, digit, index) => total + Number(digit) * (weights[index] ?? 0), 0);
  const digit = 11 - (sum % 11);
  return digit === 11 ? 0 : digit === 10 ? undefined : digit;
}

/** `30-99999999-5`: a CUIT with a valid check digit (the lender's is synthetic, docs/seed-spec.md §2). */
export const Cuit = z
  .string()
  .regex(/^\d{2}-\d{8}-\d$/, "expected NN-NNNNNNNN-N")
  .refine((cuit) => cuitCheckDigit(cuit.replaceAll("-", "").slice(0, 10)) === Number(cuit.slice(-1)), "invalid CUIT check digit");

/** Fields every document of a complaint carries. */
const Common = {
  complaintNumber: ComplaintNumber,
  /** Simulated instant of issue, in the world's clock: the only thing that may change the bytes. */
  issuedAtSim: IsoInstant,
  customerName: Line(120).optional(),
};

const Loan = { label: Line(80) };

export const AckInput = z
  .object({
    docKind: z.literal("ACK"),
    ...Common,
    type: ComplaintType,
    channel: Channel,
    filedAtSim: IsoInstant,
    deadlineSim: IsoInstant,
    /** `hash` of the complaint's `FILED` register entry. */
    filedHash: HexHash,
  })
  .strict();

/** Documents a written answer can attach (complaints/answer.ts decides which). */
export const AnswerAttachmentKind = z.enum(["PAYOFF_CERTIFICATE", "CREDIT_NOTE", "STATEMENT", "CLOSURE", "DATA_CHANGE"]);
export type AnswerAttachmentKind = z.infer<typeof AnswerAttachmentKind>;

export const AnswerInput = z
  .object({
    docKind: z.literal("ANSWER"),
    ...Common,
    type: ComplaintType,
    filedAtSim: IsoInstant,
    outcome: ComplaintOutcome,
    /** What the evidence shows, one fact per line (built by code from the tool results). */
    facts: z.array(Line(400)).min(1).max(20),
    /** The answer's body, already through G2 and outbound verification. */
    resolution: Paragraphs,
    actions: z.array(z.object({ label: Line(160), amountCents: PositiveCents }).strict()).max(10),
    attachments: z.array(AnswerAttachmentKind).max(4),
    registerHashes: z.object({ filed: HexHash, finalAnswer: HexHash }).strict(),
  })
  .strict();

export const PayoffCertificateInput = z
  .object({
    docKind: z.literal("PAYOFF_CERTIFICATE"),
    ...Common,
    loan: z.object({ ...Loan, principalCents: PositiveCents, cancelledAtSim: IsoInstant }).strict(),
  })
  .strict();

export const CreditNoteInput = z
  .object({
    docKind: z.literal("CREDIT_NOTE"),
    ...Common,
    creditNoteId: Id,
    concept: Line(160),
    amountCents: PositiveCents,
    interestCents: Cents,
    /** Synthetic compensatory rate (a fraction: 0.95 is 95 % a year), shown as an assumption. */
    annualRate: z.number().min(0).max(10),
    creditedAtSim: IsoInstant,
  })
  .strict();

export const InstalmentStatus = z.enum(["DUE", "PAID", "PARTIALLY_PAID", "OVERDUE"]);

export const StatementInput = z
  .object({
    docKind: z.literal("STATEMENT"),
    ...Common,
    loan: z.object({ ...Loan, outstandingCents: Cents }).strict(),
    instalments: z
      .array(
        z
          .object({ number: InstalmentNumber, dueDate: CalendarDate, amountCents: Cents, paidCents: Cents, outstandingCents: Cents, status: InstalmentStatus })
          .strict(),
      )
      .min(1)
      .max(18),
    payments: z.array(z.object({ instalment: InstalmentNumber, appliedAtSim: IsoInstant, amountCents: PositiveCents }).strict()).max(60),
  })
  .strict();

export const ClosureInput = z
  .object({
    docKind: z.literal("CLOSURE"),
    ...Common,
    requestedAtSim: IsoInstant,
    /** Conditions of the closure as the core states them (balance moved, products closed). */
    conditions: z.array(Line(200)).max(10),
  })
  .strict();

export const DataChangeInput = z
  .object({
    docKind: z.literal("DATA_CHANGE"),
    ...Common,
    field: DataChangeField,
    requestedAtSim: IsoInstant,
    status: z.enum(["PENDING_CONFIRMATION", "REFERRED"]),
  })
  .strict();

export const CollectionNoticeInput = z
  .object({
    docKind: z.literal("COLLECTION_NOTICE"),
    /** Present when the notice belongs to a complaint; an operator reroute from a customer card has none. */
    complaintNumber: ComplaintNumber.optional(),
    issuedAtSim: IsoInstant,
    customerName: Line(120).optional(),
    /** The lender's synthetic identification, from `Reference` (docs/seed-spec.md §2). */
    creditor: z.object({ cuit: Cuit, address: Line(120) }).strict(),
    loan: z.object(Loan).strict(),
    overdue: z.array(z.object({ number: InstalmentNumber, dueDate: CalendarDate, amountCents: PositiveCents }).strict()).min(1).max(18),
  })
  .strict();

export const DocumentInput = z.discriminatedUnion("docKind", [
  AckInput,
  AnswerInput,
  PayoffCertificateInput,
  CreditNoteInput,
  StatementInput,
  ClosureInput,
  DataChangeInput,
  CollectionNoticeInput,
]);
export type DocumentInput = z.infer<typeof DocumentInput>;
export type DocumentInputOf<K extends DocumentInput["docKind"]> = Extract<DocumentInput, { docKind: K }>;
