// `Media` as MediaIntake uses it (schema.ts `MediaObjects`), over S3 with timeouts and the SDK's
// retries. Every call names the REAL key of the registry (`s3Key`), never its announce key. The
// quarantine copies the object under `quarantine/` (a prefix no world's key starts with, so a scan
// result of the copy is never attributed: keys.ts `scanTargetOf`) and deletes the original.
import { CopyObjectCommand, DeleteObjectCommand, GetObjectTaggingCommand, type S3Client } from "@aws-sdk/client-s3";
import { getBoundedObject, imageS3Client, isNotFound } from "../receipts/s3-object";
import { SCAN_STATUS_TAG, type MediaObjects } from "./schema";

export const QUARANTINE_PREFIX = "quarantine/";

/** S3's copy source: the bucket and the key with each segment URL-encoded. */
function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function s3MediaObjects(bucket: string, client?: Pick<S3Client, "send">): MediaObjects {
  const send = client ?? imageS3Client();
  return {
    get: (key, maxBytes) => getBoundedObject(send, bucket, key, maxBytes),
    async scanTag(key) {
      try {
        const tagging = await send.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
        return tagging.TagSet?.find((tag) => tag.Key === SCAN_STATUS_TAG)?.Value;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async quarantine(key) {
      try {
        await send.send(new CopyObjectCommand({ Bucket: bucket, Key: `${QUARANTINE_PREFIX}${key}`, CopySource: copySource(bucket, key) }));
      } catch (error) {
        // Already moved by an earlier attempt: nothing left to copy.
        if (isNotFound(error)) return;
        throw error;
      }
      await send.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async remove(key) {
      await send.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
