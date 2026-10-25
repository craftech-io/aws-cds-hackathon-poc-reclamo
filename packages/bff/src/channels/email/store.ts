// The `Emails` bucket (docs/architecture.md §6): `<root>/<yyyy-mm-dd>/<mailId>.eml` is the exact raw
// MIME sent and `…/<mailId>.json` the view the console's email viewer renders (headers, parts,
// attachments). Both are written BEFORE `SendEmail`: an email that left is always in the bucket.
// The date folder is the Argentine date of the world's simulated send instant.
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { maskEmail } from "@reclamo/shared";
import { awsClientConfig } from "../../lib/clients";
import { withDeadline } from "../../lib/deadline";
import { withRetry } from "../../lib/retry";
import { localDateAr } from "../../services/business-days";
import { EMAIL_STORE_TIMEOUTS, worldObjectRoot } from "./config";

export interface EmailObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface EmailObjectKeys {
  readonly raw: string;
  readonly render: string;
}

export function emailObjectKeys(worldId: string, sentAtSim: string, mailId: string): EmailObjectKeys {
  const folder = `${worldObjectRoot(worldId)}${localDateAr(new Date(sentAtSim))}/${mailId}`;
  return { raw: `${folder}.eml`, render: `${folder}.json` };
}

export interface EmailView {
  readonly mailId: string;
  readonly worldId: string;
  readonly headers: { readonly from: string; readonly toMasked: string; readonly subject: string; readonly date: string };
  readonly text: string;
  readonly html: string;
  readonly attachments: readonly { readonly filename: string; readonly docKind: string; readonly sha256: string; readonly bytes: number }[];
  readonly rawSha256: string;
}

/** The viewer's JSON: the recipient masked (the exact address stays only in the `.eml`). */
export function emailView(input: Omit<EmailView, "headers"> & { readonly headers: { readonly from: string; readonly to: string; readonly subject: string; readonly date: string } }): EmailView {
  const { to, ...headers } = input.headers;
  return { ...input, headers: { ...headers, toMasked: maskEmail(to) } };
}

const STORE_DEADLINE_MS = 8_000;

/** `PutObject` into the linked `Emails` bucket, with a deadline and backoff on retryable failures. */
export function s3EmailObjectStore(bucket: string, client: S3Client = new S3Client(awsClientConfig(EMAIL_STORE_TIMEOUTS))): EmailObjectStore {
  return {
    async put(key, body, contentType) {
      await withDeadline("emails.put", STORE_DEADLINE_MS, (signal) =>
        withRetry(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }), { abortSignal: signal }), {
          attempts: 2,
          baseDelayMs: 100,
          shouldRetry: (error) => error instanceof Error && /Throttl|SlowDown|InternalError|ServiceUnavailable|TimeoutError/.test(error.name),
        }),
      );
    },
  };
}
