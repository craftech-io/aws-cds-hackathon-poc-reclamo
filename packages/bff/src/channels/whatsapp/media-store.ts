// The `Media` bucket as the WhatsApp adapter uses it (transport.ts `MediaBucket`), over S3 with the
// timeouts of config.ts: list the objects under a live media prefix, read an upload's size, delete an
// object over the limit and copy a seed receipt server-side into the world's root. Bucket names come
// from the SST link (lib/resource.ts), never from the environment.
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { awsClientConfig } from "../../lib/clients";
import { bucketName } from "../../lib/resource";
import { S3_TIMEOUTS } from "./config";
import type { MediaBucket } from "./transport";

export interface S3MediaBucketOptions {
  readonly mediaBucket: string;
  readonly seedBucket: string;
  readonly client?: S3Client;
}

let s3: S3Client | undefined;

function isNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "NotFound" || name === "NoSuchKey";
}

export function s3MediaBucket(options: S3MediaBucketOptions): MediaBucket {
  const client = options.client ?? (s3 ??= new S3Client(awsClientConfig(S3_TIMEOUTS)));
  return {
    async list(prefix, max) {
      const page = await client.send(new ListObjectsV2Command({ Bucket: options.mediaBucket, Prefix: prefix, MaxKeys: max }));
      return (page.Contents ?? []).flatMap((object) => (object.Key === undefined ? [] : [{ key: object.Key, sizeBytes: object.Size ?? 0 }]));
    },
    async head(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: options.mediaBucket, Key: key }));
        return { sizeBytes: head.ContentLength ?? 0, ...(head.ContentType === undefined ? {} : { contentType: head.ContentType }) };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.mediaBucket, Key: key }));
    },
    async copyFromSeed(seedKey, mediaKey, contentType) {
      await client.send(
        new CopyObjectCommand({ Bucket: options.mediaBucket, Key: mediaKey, CopySource: `${options.seedBucket}/${seedKey}`, ContentType: contentType, MetadataDirective: "REPLACE" }),
      );
    },
  };
}

/** The bucket of a Lambda that has `Media` and `Seed` linked. */
export function linkedMediaBucket(): MediaBucket {
  return s3MediaBucket({ mediaBucket: bucketName("Media"), seedBucket: bucketName("Seed") });
}
