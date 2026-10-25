// Bounded reads of an image object in S3, shared by the receipt reader (receipts/linked.ts) and media
// intake (media-intake/objects.ts): a HEAD first, so an object over the limit is never downloaded,
// and the bytes counted again after the GET. One client per container, with timeouts and the SDK's
// retries; S3 answers a 3.75 MB object well within them.
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";

export const S3_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 8_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

let client: S3Client | undefined;

/** The container's S3 client for images. */
export function imageS3Client(): S3Client {
  client ??= new S3Client(awsClientConfig(S3_TIMEOUTS));
  return client;
}

/** A missing object (`HeadObject` answers `NotFound`, `GetObject` `NoSuchKey`). */
export function isNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "NotFound" || name === "NoSuchKey";
}

export type BoundedObject = Uint8Array | "TOO_LARGE" | undefined;

/** The whole object, `TOO_LARGE` above `maxBytes` (never downloaded whole), `undefined` when gone. */
export async function getBoundedObject(s3: Pick<S3Client, "send">, bucket: string, key: string, maxBytes: number): Promise<BoundedObject> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if ((head.ContentLength ?? 0) > maxBytes) return "TOO_LARGE";
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await object.Body?.transformToByteArray();
    if (bytes === undefined) return undefined;
    return bytes.byteLength > maxBytes ? "TOO_LARGE" : bytes;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}
