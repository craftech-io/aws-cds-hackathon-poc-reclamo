// The PDFs an email carries (docs/architecture-integrations.md §1 "Adjuntos", §8): the ones the caller
// rendered and stored (`Documents`), read back and checked against the SHA-256 the request names, and
// for the formal debt notice the `COLLECTION_NOTICE` the code renders from the core's detail (never a
// document a caller hands over). At most five, 2 MB in total; anything else is refused before the tape.
import { ToolError } from "@reclamo/shared";
import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES } from "../channels/email/config";
import { sha256Hex } from "../lib/crypto";
import type { SendContext } from "./context";
import type { AttachableDocument, DebtDetail, OutboundDeps } from "./deps";
import { GATE_REASON, type OutboundRequest } from "./types";

function invalid(message: string): ToolError {
  return new ToolError("INVALID", message, GATE_REASON.CONTENT_INVALID);
}

/** `R-2026-000123-answer.pdf`: ASCII only, what the email client's filename rule accepts. */
export function attachmentFileName(docKind: string, complaintNumber: string | undefined): string {
  return `${complaintNumber ?? "jarilla"}-${docKind.toLowerCase().replace(/_/g, "-")}.pdf`;
}

async function stored(deps: Pick<OutboundDeps, "documents">, request: OutboundRequest, ctx: SendContext): Promise<AttachableDocument[]> {
  return Promise.all(
    (request.attachments ?? []).map(async (file) => {
      const bytes = await deps.documents.read(file.s3Key);
      if (sha256Hex(bytes) !== file.sha256) throw invalid(`the stored ${file.docKind} is not the document the request names`);
      return { ...file, bytes, fileName: attachmentFileName(file.docKind, ctx.complaint?.complaintNumber) };
    }),
  );
}

/** The attachments of an email, read and checked (or rendered, for the formal debt notice). */
export async function attachmentsOf(deps: Pick<OutboundDeps, "documents">, request: OutboundRequest, ctx: SendContext, debt: DebtDetail | undefined): Promise<AttachableDocument[]> {
  if (request.channel !== "EMAIL") return [];
  let files: AttachableDocument[];
  if (request.kind === "COLLECTION_NOTICE_EMAIL") {
    if ((request.attachments?.length ?? 0) > 0) throw invalid("the formal debt notice carries only the document the code renders");
    if (debt === undefined || ctx.customer === undefined) throw invalid("the formal debt notice needs the core's detail");
    files = [
      await deps.documents.collectionNotice({
        worldId: request.worldId,
        customerId: request.customerId,
        customerName: ctx.customer.firstName,
        debt,
        issuedAtSim: ctx.simNow.toISOString(),
        ...(ctx.complaint === undefined ? {} : { complaintNumber: ctx.complaint.complaintNumber }),
      }),
    ];
  } else {
    files = await stored(deps, request, ctx);
  }
  if (files.length > MAX_ATTACHMENTS) throw invalid(`an email carries at most ${MAX_ATTACHMENTS} documents`);
  if (files.reduce((total, file) => total + file.bytes.byteLength, 0) > MAX_ATTACHMENTS_BYTES) throw invalid("the documents of an email weigh at most 2 MB in total");
  return files;
}
