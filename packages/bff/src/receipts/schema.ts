// Shapes of the receipt reading (docs/architecture-integrations.md §7, ADR-0007): the forced tool
// Bedrock answers with (`record_receipt`), the fields a valid reading carries, and the evidence the
// reading and the image leave on the complaint. Everything that enters from Bedrock or from a stored
// row is parsed here before any rule looks at it.
//
// Amounts are integer centavos everywhere past the edge; the printed receipt and the PNG chunk carry
// pesos with two decimals, Bedrock answers a number of pesos.
import { z } from "zod";
import { IsoInstant, ReceiptResult } from "@reclamo/shared";
import { Id } from "../domain/common";

/** The most `Converse` accepts per image, and the cap of every entry path (docs/architecture.md §6). */
export const MAX_IMAGE_BYTES = 3_932_160;
/** Pixels per side `Converse` accepts. */
export const MAX_IMAGE_SIDE = 8_000;
/** Largest amount a receipt may carry: $ 5.000.000,00. */
export const MAX_RECEIPT_CENTS = 500_000_000;

export const IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
export const ImageType = z.enum(IMAGE_TYPES);
export type ImageType = z.infer<typeof ImageType>;

/** Networks a receipt can name (the shared `Network` minus nothing: a transfer has no code of ours). */
export const ReceiptNetwork = z.enum(["NORTE", "SUR", "TRANSFER", "WALLET"]);
export type ReceiptNetwork = z.infer<typeof ReceiptNetwork>;

export const Legibility = z.enum(["CLEAR", "PARTIAL", "ILLEGIBLE"]);
export type Legibility = z.infer<typeof Legibility>;

/** `source` of a `RECEIPT_READING` (docs/architecture-integrations.md §7, step 5). */
export const ReadingSource = z.enum(["BEDROCK", "FALLBACK", "BOTH_AGREE", "DISAGREE"]);
export type ReadingSource = z.infer<typeof ReadingSource>;

export const RECORD_RECEIPT_TOOL = "record_receipt";

// A type alias, not an interface: the SDK's `DocumentType` needs an index-signature-compatible shape.
type JsonSchemaObject = {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
};

/** JSON schema of the only tool Bedrock may call (`toolChoice` forces it). */
export const RECORD_RECEIPT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    isReceipt: { type: "boolean" },
    network: { type: "string", description: "NORTE | SUR | TRANSFER | WALLET | UNKNOWN" },
    operationCode: { type: "string" },
    amount: { type: "number" },
    currency: { type: "string" },
    paidAtLocal: { type: "string", description: "YYYY-MM-DDTHH:mm as printed" },
    payerReference: { type: "string", description: "customer or loan reference as printed, never an account number" },
    legibility: { type: "string", description: "CLEAR | PARTIAL | ILLEGIBLE" },
    suspiciousText: { type: "boolean" },
    notes: { type: "string", description: "max 200 chars" },
  },
  required: ["isReceipt", "legibility", "suspiciousText"],
};

/** An optional printed text, trimmed to `max` characters (upper-cased for codes and networks). */
const trimmed = (max: number, upper = false) =>
  z
    .string()
    .transform((value) => {
      const text = value.trim().slice(0, max);
      return upper ? text.toUpperCase() : text;
    })
    .optional();

/**
 * What Bedrock wrote into `record_receipt`, parsed leniently (a model may add keys or case): the
 * types are checked here, the meaning in validate.ts. `notes` is kept only to be dropped: it never
 * goes back to the Harness nor into a log.
 */
export const RawReading = z.object({
  isReceipt: z.boolean(),
  network: trimmed(20, true),
  operationCode: trimmed(64, true),
  amount: z.number().finite().optional(),
  currency: trimmed(8),
  paidAtLocal: trimmed(32),
  payerReference: trimmed(64),
  legibility: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(Legibility),
  suspiciousText: z.boolean(),
  notes: trimmed(200),
});
export type RawReading = z.infer<typeof RawReading>;

export const PAID_AT_LOCAL = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** The fields of a valid reading: what reconciliation compares, never what decides alone. */
export const ReceiptFields = z.object({
  network: ReceiptNetwork,
  operationCode: z.string().regex(/^(NTE|SUR|BIL)-\d{8}-\d{6}-\d$/),
  /** Integer centavos. */
  amount: z.number().int().positive().max(MAX_RECEIPT_CENTS),
  /** Local time in Argentina as printed (`YYYY-MM-DDTHH:mm`). */
  paidAtLocal: z.string().regex(PAID_AT_LOCAL),
  /** Customer or loan reference as printed: kept as evidence, never compared with the session. */
  payerReference: z.string().max(64).optional(),
});
export type ReceiptFields = z.infer<typeof ReceiptFields>;

/** Why a reading that has text is not `READ` (`INVALID_RECEIPT`), or why it is incomplete. */
export const ReadingProblem = z.enum(["INVALID_CHECK_DIGIT", "INVALID_FORMAT", "NETWORK_MISMATCH", "FUTURE_DATE", "AMOUNT_OUT_OF_RANGE", "INCOMPLETE", "INVALID_OUTPUT"]);
export type ReadingProblem = z.infer<typeof ReadingProblem>;

/** The result of the reader, before the duplicate check of the service. */
export const ReaderResult = ReceiptResult.exclude(["DUPLICATE_OF"]);
export type ReaderResult = z.infer<typeof ReaderResult>;

/** One side of a disagreement: only what was compared. */
export const DisagreeingRead = z.object({ operationCode: z.string().max(64), amount: z.number().int() });
export type DisagreeingRead = z.infer<typeof DisagreeingRead>;

/** `details` of a `RECEIPT_READING` evidence. The image and Bedrock's notes are never in it. */
export const ReceiptReadingDetails = z.object({
  result: ReceiptResult,
  source: ReadingSource,
  fields: ReceiptFields.optional(),
  problem: ReadingProblem.optional(),
  suspiciousText: z.boolean().default(false),
  imageEvidenceId: Id.optional(),
  /** What Bedrock said about the image (absent when it was not available or not called). */
  bedrock: z.object({ legibility: Legibility.optional(), isReceipt: z.boolean().optional(), unavailable: z.string().max(40).optional() }).optional(),
  /** Whether the image carried the deterministic chunk and whether it agreed. */
  fallback: z.object({ present: z.boolean(), agrees: z.boolean().optional() }).optional(),
  /** `DISAGREE`: both readings, kept for the person who reviews it; neither is ever chosen. */
  disagreement: z.object({ bedrock: DisagreeingRead, fallback: DisagreeingRead.optional() }).optional(),
  duplicateOf: z.string().max(40).optional(),
  readAtReal: IsoInstant.optional(),
});
export type ReceiptReadingDetails = z.infer<typeof ReceiptReadingDetails>;

/** A checked image in `Media` (media-intake): what the worker turns into a `RECEIPT_IMAGE` evidence. */
export const MediaImageDetails = z.object({
  s3Key: z.string().min(1).max(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: ImageType,
  sizeBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  width: z.number().int().positive().max(MAX_IMAGE_SIDE).optional(),
  height: z.number().int().positive().max(MAX_IMAGE_SIDE).optional(),
  /** `NO_THREATS_FOUND`, or `SEED_SKIPPED` for a server-side copy of a seed receipt with a known hash. */
  scan: z.enum(["NO_THREATS_FOUND", "SEED_SKIPPED"]),
  messageId: Id.optional(),
  source: z.enum(["SIMULATOR", "WHATSAPP", "SEED_COPY"]).optional(),
});
export type MediaImageDetails = z.infer<typeof MediaImageDetails>;

/** Where the image of a `RECEIPT_IMAGE` evidence lives: a `Media` object, or a seed receipt. */
export const ReceiptImageDetails = z.union([
  MediaImageDetails,
  // Written by the seed: the receipt stays in `Seed/receipts/…`, its hash is in `Reference`.
  z.object({ seedKey: z.string().regex(/^receipts\/[a-z-]+\/[A-Za-z0-9._-]+\.(png|jpe?g)$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), contentType: ImageType }),
]);
export type ReceiptImageDetails = z.infer<typeof ReceiptImageDetails>;
