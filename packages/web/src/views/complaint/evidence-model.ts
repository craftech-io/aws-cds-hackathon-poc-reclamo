// What the evidence block does with the case's evidence (docs/design-brief.md §9 "Caso"; FL-017):
// the bytes of a receipt image as a `Blob` (the console shows it from a `blob:` URL it made itself, so
// neither a presigned URL nor the seed's bucket ever lands in an <img>), the reading of a receipt
// parsed with the reader's own schema, next to its image (the rows of every other piece are
// evidence-rows.ts). Pure but for `loadEvidenceBlob`, which fetches a presigned GET.
import { ReceiptReadingDetails } from "@reclamo/bff/receipts/schema";
import type { RouterOutputs } from "../../lib/trpc-router";
import type { CaseView } from "./api";

export type EvidenceView = CaseView["evidence"][number];
export type EvidenceFile = RouterOutputs["complaints"]["evidenceUrl"];

const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

export function bytesOfBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The image of an inline answer as a Blob of the content type the server fixed (PNG or JPEG only). */
export function inlineBlob(file: Extract<EvidenceFile, { kind: "INLINE" }>): Blob {
  if (!IMAGE_TYPES.has(file.contentType)) throw new Error("not an image");
  const bytes = bytesOfBase64(file.dataBase64);
  return new Blob([bytes.buffer as ArrayBuffer], { type: file.contentType });
}

/** The bytes behind an `evidenceUrl` answer: inline, or the 5-minute GET of `Media`. */
export async function loadEvidenceBlob(file: EvidenceFile, signal: AbortSignal): Promise<Blob> {
  if (file.kind === "INLINE") return inlineBlob(file);
  if (!IMAGE_TYPES.has(file.contentType)) throw new Error("not an image");
  const response = await fetch(file.url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`image ${response.status}`);
  const blob = await response.blob();
  return new Blob([blob], { type: file.contentType });
}

export type ReceiptReading = ReceiptReadingDetails;

/** The reading of a `RECEIPT_READING` evidence, or undefined when its details are not one. */
export function readingOf(evidence: Pick<EvidenceView, "kind" | "details">): ReceiptReading | undefined {
  if (evidence.kind !== "RECEIPT_READING") return undefined;
  const parsed = ReceiptReadingDetails.safeParse(evidence.details);
  return parsed.success ? parsed.data : undefined;
}

export interface EvidenceGroup {
  readonly evidence: EvidenceView;
  /** The readings of this receipt image, shown next to it. */
  readonly readings: readonly EvidenceView[];
}

/**
 * The evidence in the order the case shows it: each receipt image with its own readings right after
 * it (a reading names its image), every other piece in its place; a reading whose image is not in the
 * case stands alone.
 */
export function evidenceGroups(evidence: readonly EvidenceView[]): EvidenceGroup[] {
  const images = new Set(evidence.filter((item) => item.kind === "RECEIPT_IMAGE").map((item) => item.evidenceId));
  const imageOf = (item: EvidenceView) => readingOf(item)?.imageEvidenceId;
  return evidence.flatMap((item) => {
    if (item.kind === "RECEIPT_IMAGE") return [{ evidence: item, readings: evidence.filter((other) => imageOf(other) === item.evidenceId) }];
    const image = imageOf(item);
    return image !== undefined && images.has(image) ? [] : [{ evidence: item, readings: [] }];
  });
}
