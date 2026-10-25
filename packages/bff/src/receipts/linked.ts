/// <reference path="../../sst-env.d.ts" />
// The receipt reader of a Lambda, wired from what SST links into it (lib/resource.ts, never
// `process.env`):
//
//   ReceiptReader   `modelId`: the inference profile of `receiptModelId` (infra/agentcore.ts, WP-31),
//                   whose `BEDROCK_READ` grant comes with the link
//   Media, Seed     the buckets of scanned images and of the seed receipts
//
// One S3 and one Bedrock client per container.
import type { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { Logger } from "../lib/log";
import { bucketName, readLinked } from "../lib/resource";
import { type BedrockReceiptReader, createBedrockReceiptReader, sdkConverseSend } from "./bedrock-reader";
import { getBoundedObject, imageS3Client } from "./s3-object";
import type { ImageStore } from "./service";

const ReceiptReaderLink = z.object({ modelId: z.string().min(1).max(256) });

/** `ImageStore` over S3: a HEAD first, so an object over the limit is never downloaded. */
export function s3ImageStore(buckets: { readonly Media: string; readonly Seed: string }, client?: Pick<S3Client, "send">): ImageStore {
  const send = client ?? imageS3Client();
  return { get: (location, maxBytes) => getBoundedObject(send, buckets[location.bucket], location.key, maxBytes) };
}

/** A reader bound to the invocation's logger, over the container's single Bedrock client. */
export function linkedBedrockReceiptReader(log: Logger): BedrockReceiptReader {
  return createBedrockReceiptReader({ modelId: readLinked("ReceiptReader", ReceiptReaderLink).modelId, send: sdkConverseSend(), log });
}

export function linkedImageStore(): ImageStore {
  return s3ImageStore({ Media: bucketName("Media"), Seed: bucketName("Seed") });
}
