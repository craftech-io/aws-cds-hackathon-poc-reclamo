// The networks client and the settlement-file reader of a Lambda, wired from what SST links into it
// (through lib/resource.ts, never `process.env`):
//
//   NetworkMock   `url`: the Function URL of the networks (functions with capability `MOCK_NETWORK`)
//   Settlements   the bucket of the published files (read by the investigation tool)
//
// One instance per container, reused across invocations.
import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { awsClientConfig } from "../lib/clients";
import { bucketName, readLinked } from "../lib/resource";
import { type NetworkClient, createNetworkClient } from "./client";
import { type SettlementFileReader, createSettlementFileReader } from "./settlement-files";
import { sigV4Signer } from "../core/signer";

const NetworkMockLink = z.object({ url: z.url() });

/** S3 answers a 1 MB object well within these; past them the reconciliation retries later. */
const S3_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

let client: NetworkClient | undefined;
let reader: SettlementFileReader | undefined;

export function linkedNetworkClient(): NetworkClient {
  client ??= createNetworkClient({ endpoint: readLinked("NetworkMock", NetworkMockLink).url, sign: sigV4Signer() });
  return client;
}

export function linkedSettlementFileReader(): SettlementFileReader {
  reader ??= createSettlementFileReader({ s3: new S3Client(awsClientConfig(S3_TIMEOUTS)), bucket: bucketName("Settlements") });
  return reader;
}
