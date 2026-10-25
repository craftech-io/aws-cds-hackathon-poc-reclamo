// The `Settlements` bucket (docs/architecture.md §6): the mock writes each published settlement file
// once, as UTF-8 CSV with its SHA-256 checked by S3 on arrival. Rewriting the same key with the same
// bytes is harmless, so a publication retried after a failed status update is idempotent.
import { createHash } from "node:crypto";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { NetworkUnavailableError } from "../errors";
import type { SettlementObjects } from "./port";

export function createS3SettlementObjects(options: { readonly client: Pick<S3Client, "send">; readonly bucket: string }): SettlementObjects {
  return {
    async put(key, body) {
      const bytes = Buffer.from(body, "utf8");
      try {
        await options.client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: key,
            Body: bytes,
            ContentType: "text/csv; charset=utf-8",
            ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
          }),
        );
      } catch (error) {
        throw new NetworkUnavailableError("the settlements bucket is unavailable", { cause: error });
      }
    },
  };
}
