// Reading a published settlement file from `Settlements` (docs/architecture-integrations.md §6.1),
// for the reconciliation: the file named by a `PUBLISHED` batch is downloaded, checked against the
// batch's SHA-256 and line count, and parsed all-or-nothing with the contract's codec (5,000 lines,
// 1 MB). A file that does not match what the network declared proves nothing: it is an error, never
// "no line found".
import { createHash } from "node:crypto";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { SETTLEMENT_CSV_MAX_BYTES, SettlementCsvError, type SettlementBatch, type SettlementLine, parseSettlementCsv } from "@reclamo/core-contract";

export const SETTLEMENT_FILE_FAILURES = ["NOT_PUBLISHED", "TOO_LARGE", "SHA_MISMATCH", "INVALID_FILE", "UNAVAILABLE"] as const;
export type SettlementFileFailure = (typeof SETTLEMENT_FILE_FAILURES)[number];

export class SettlementFileError extends Error {
  override readonly name = "SettlementFileError";
  constructor(
    readonly code: SettlementFileFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type SettlementFileReader = (batch: SettlementBatch) => Promise<SettlementLine[]>;

export function createSettlementFileReader(options: { readonly s3: Pick<S3Client, "send">; readonly bucket: string }): SettlementFileReader {
  return async (batch) => {
    if (batch.status !== "PUBLISHED" || batch.s3Key === undefined || batch.sha256 === undefined) {
      throw new SettlementFileError("NOT_PUBLISHED", "the batch has no published file");
    }
    let bytes: Uint8Array;
    try {
      const object = await options.s3.send(new GetObjectCommand({ Bucket: options.bucket, Key: batch.s3Key }));
      if ((object.ContentLength ?? 0) > SETTLEMENT_CSV_MAX_BYTES) throw new SettlementFileError("TOO_LARGE", "settlement file larger than 1 MB");
      if (object.Body === undefined) throw new SettlementFileError("UNAVAILABLE", "empty answer from the bucket");
      bytes = await object.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof SettlementFileError) throw error;
      throw new SettlementFileError("UNAVAILABLE", "the settlements bucket is unavailable", { cause: error });
    }
    if (bytes.byteLength > SETTLEMENT_CSV_MAX_BYTES) throw new SettlementFileError("TOO_LARGE", "settlement file larger than 1 MB");
    if (createHash("sha256").update(bytes).digest("hex") !== batch.sha256) throw new SettlementFileError("SHA_MISMATCH", "the file is not the one the network published");
    try {
      const lines = parseSettlementCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { network: batch.network, businessDate: batch.businessDate });
      if (batch.lineCount !== undefined && lines.length !== batch.lineCount) throw new SettlementFileError("INVALID_FILE", "the file does not have the declared lines");
      return lines;
    } catch (error) {
      if (error instanceof SettlementFileError) throw error;
      throw new SettlementFileError("INVALID_FILE", error instanceof SettlementCsvError ? error.message : "the file is not UTF-8 text", { cause: error });
    }
  };
}
