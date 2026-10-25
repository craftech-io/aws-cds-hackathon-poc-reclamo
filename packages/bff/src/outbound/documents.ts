// The PDFs of `Documents` the gate attaches (docs/architecture.md §6, docs/architecture-integrations.md
// §8): it reads back the ones a caller rendered (the gate checks their SHA-256), and renders and
// stores the `COLLECTION_NOTICE` of a formal debt notice itself (pdf/ from the core's detail and the
// lender's synthetic identification of `Reference`), so no caller can hand over a debt document.
// The notice is stored under `<root>customers/<customerId>/`.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { ToolError } from "@reclamo/shared";
import { EMAIL_STORE_TIMEOUTS, worldObjectRoot } from "../channels/email/config";
import type { Connector } from "../connector/port";
import { awsClientConfig } from "../lib/clients";
import { withDeadline } from "../lib/deadline";
import { withRetry } from "../lib/retry";
import { renderDocument } from "../pdf/documents";
import { attachmentFileName } from "./attachments";
import type { DocumentStore } from "./deps";

/** `Reference/LENDER#AR/creditor`: the fictitious lender's synthetic CUIT and address (docs/seed-spec.md §2). */
export const CREDITOR_REFERENCE = { type: "LENDER", scope: "AR", key: "creditor" } as const;
export const CreditorRecord = z.object({ cuit: z.string().min(1).max(20), address: z.string().min(1).max(120) });

const DEADLINE_MS = 8_000;
const RETRYABLE = /Throttl|SlowDown|InternalError|ServiceUnavailable|TimeoutError/;

/** Where a collection notice of a customer is stored (it belongs to the customer, not to a complaint). */
export function collectionNoticeKey(worldId: string, customerId: string, sha256: string): string {
  return `${worldObjectRoot(worldId)}customers/${customerId}/COLLECTION_NOTICE-${sha256.slice(0, 16)}.pdf`;
}

export interface S3DocumentStoreDeps {
  readonly bucket: string;
  readonly reference: Pick<Connector, "reference">;
  readonly client?: S3Client;
}

export function s3DocumentStore(deps: S3DocumentStoreDeps): DocumentStore {
  const client = deps.client ?? new S3Client(awsClientConfig(EMAIL_STORE_TIMEOUTS));
  const call = <T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    withDeadline(operation, DEADLINE_MS, (signal) => withRetry(() => run(signal), { attempts: 2, baseDelayMs: 100, shouldRetry: (error) => error instanceof Error && RETRYABLE.test(error.name) }));

  return {
    async read(s3Key) {
      return call("documents.get", async (signal) => {
        const output = await client.send(new GetObjectCommand({ Bucket: deps.bucket, Key: s3Key }), { abortSignal: signal });
        if (output.Body === undefined) throw new ToolError("NOT_FOUND", "the document is not stored");
        return output.Body.transformToByteArray();
      });
    },

    async collectionNotice(input) {
      const creditor = await deps.reference.reference.get(CreditorRecord, CREDITOR_REFERENCE.type, CREDITOR_REFERENCE.scope, CREDITOR_REFERENCE.key);
      if (creditor === undefined) throw new ToolError("UNAVAILABLE", "the lender's identification is not in Reference");
      const rendered = renderDocument({
        docKind: "COLLECTION_NOTICE",
        ...(input.complaintNumber === undefined ? {} : { complaintNumber: input.complaintNumber }),
        issuedAtSim: input.issuedAtSim,
        customerName: input.customerName,
        creditor,
        loan: { label: input.debt.loanLabel },
        overdue: input.debt.overdue.map((row) => ({ number: row.instalment, dueDate: row.dueDate, amountCents: row.amountCents })),
      });
      const s3Key = collectionNoticeKey(input.worldId, input.customerId, rendered.sha256);
      await call("documents.put", (signal) => client.send(new PutObjectCommand({ Bucket: deps.bucket, Key: s3Key, Body: rendered.bytes, ContentType: rendered.contentType }), { abortSignal: signal }));
      return { docKind: "COLLECTION_NOTICE", s3Key, sha256: rendered.sha256, bytes: rendered.bytes, fileName: attachmentFileName("COLLECTION_NOTICE", input.complaintNumber) };
    },
  };
}
