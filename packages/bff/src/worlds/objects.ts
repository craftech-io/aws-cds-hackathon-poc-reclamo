// The S3 side of a world (docs/architecture.md §6) for the factory and the wipe: the published
// settlement files of the template copied server-side from `Seed/` into `Settlements/<world root>`, and
// every object under a world prefix deleted from `Media`, `Documents`, `Emails` and `Settlements`
// (never `Exports`). Bucket names come from the links (`Resource.<Bucket>.name`); every call has a
// deadline and a retry with backoff.
import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { ConnectorError } from "@reclamo/shared";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import type { Logger } from "../lib/log";
import { type BucketName, bucketName } from "../lib/resource";
import { withRetry } from "../lib/retry";
import type { WorldObjects } from "./deps";

const WORLD_BUCKETS = ["Media", "Documents", "Emails", "Settlements"] as const satisfies readonly BucketName[];

// A copy of a settlement file or a page of deletions answers in well under a few seconds.
const S3_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 10_000, connectionTimeoutMs: 2_000, maxAttempts: 3 };
const RETRYABLE = /Throttl|SlowDown|InternalError|ServiceUnavailable|TimeoutError|RequestTimeout/;

/** S3 keeps at most 1 000 keys per page and per `DeleteObjects`. */
const S3_PAGE = 1_000;

function retrying<T>(run: () => Promise<T>): Promise<T> {
  return withRetry(run, { attempts: 3, baseDelayMs: 200, shouldRetry: (error) => error instanceof Error && RETRYABLE.test(error.name) });
}

export interface S3WorldObjectsOptions {
  readonly log: Logger;
  readonly client?: Pick<S3Client, "send">;
  readonly bucket?: (bucket: BucketName) => string;
}

function linkedOrUndefined(name: (bucket: BucketName) => string, bucket: BucketName): string | undefined {
  try {
    return name(bucket);
  } catch {
    return undefined;
  }
}

export function s3WorldObjects(options: S3WorldObjectsOptions): WorldObjects {
  let client = options.client;
  const s3 = (): Pick<S3Client, "send"> => (client ??= new S3Client(awsClientConfig(S3_TIMEOUTS)));
  const name = options.bucket ?? bucketName;

  async function deleteIn(bucket: string, prefix: string, limit: number): Promise<number> {
    const listed = await retrying(() => s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: Math.min(limit, S3_PAGE) })));
    const objects = (listed.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
    if (objects.length === 0) return 0;
    const result = await retrying(() => s3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } })));
    if ((result.Errors ?? []).length > 0) throw new ConnectorError("UNAVAILABLE", `${result.Errors?.length ?? 0} objects could not be deleted`, "S3");
    return objects.length;
  }

  return {
    async copySettlement(seedKey, key) {
      const seed = name("Seed");
      const settlements = name("Settlements");
      await retrying(() => s3().send(new CopyObjectCommand({ Bucket: settlements, Key: key, CopySource: `${seed}/${seedKey.split("/").map(encodeURIComponent).join("/")}` })));
    },

    async deleteUnder(prefix, limit) {
      if (!/^(W|qa|up|wa)\/[a-z0-9-]+\//.test(prefix)) throw new ConnectorError("VALIDATION", "a world prefix is required", "S3");
      let deleted = 0;
      for (const bucket of WORLD_BUCKETS) {
        const physical = linkedOrUndefined(name, bucket);
        if (physical === undefined) {
          options.log.warn("worlds.bucket_not_linked", { resource: bucket });
          continue;
        }
        deleted += await deleteIn(physical, prefix, limit - deleted);
        if (deleted >= limit) break;
      }
      return deleted;
    },
  };
}
