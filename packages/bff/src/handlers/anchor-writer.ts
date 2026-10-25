/// <reference path="../../sst-env.d.ts" />
// `AnchorWriter` (docs/architecture.md §8.3, §14; ADR-0014): the ONLY writer of the anchor log group.
// Invoked asynchronously (2 retries, failure destination → `AnchorWriteFailed`) by every role that
// commits a chained entry, with `{worldId, epoch, chain, entries: [{seq, pk, sk}]}`. For each entry it
// re-reads the committed item (strongly consistent), requires that its key, world, epoch and `seq`
// match the request, and writes `{worldId, epoch, chain, seq, hash, atReal}` with the STORED hash in
// the stream `<worldId>-e<epoch>-<chain>` built from the re-read entry. A forged request can only
// repeat what the table already holds; it never chooses a hash or a stream. Its role reads `Register`
// and `ComplianceTape` and writes the anchors, nothing else.
import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import { AnchorRequest, type AnchorRecord, anchorStreamName } from "../complaints/anchors";
import { dynamoConnector } from "../connector/dynamo/connector";
import { keys, worldKey } from "../connector/keys";
import type { Connector } from "../connector/port";
import type { RefundEntry, RegisterEntry, TapeEntry } from "../domain/ledger";
import { awsClientConfig } from "../lib/clients";
import { type Logger, createLogger } from "../lib/log";
import { readLinked } from "../lib/resource";

/** Where the anchors go: one stream per world, epoch and chain. */
export interface AnchorSink {
  ensureStream(stream: string): Promise<void>;
  put(stream: string, events: readonly { timestamp: number; message: string }[]): Promise<void>;
}

export interface AnchorWriterDeps {
  readonly connector: Connector;
  readonly sink: AnchorSink;
  readonly log: Logger;
  /** Real clock (`atReal` and the event timestamp). */
  readonly now: () => Date;
}

export type AnchorSkip = "ENTRY_MISSING" | "KEY_MISMATCH" | "ENTRY_MISMATCH";

export interface AnchorWriterResult {
  readonly anchored: readonly number[];
  readonly skipped: readonly { readonly seq: number; readonly reason: AnchorSkip }[];
}

/** The key a chain's entry of this world, epoch and `seq` must have (the tape: a day partition of the world). */
function keyMatches(request: AnchorRequest, entry: AnchorRequest["entries"][number]): boolean {
  if (request.chain === "REG") return sameKey(entry, keys.register(request.worldId, request.epoch, entry.seq));
  if (request.chain === "RRI") return sameKey(entry, keys.refund(request.worldId, request.epoch, entry.seq));
  return entry.pk.startsWith(worldKey(request.worldId, "TAPE", ""));
}

function sameKey(a: { pk: string; sk: string }, b: { pk: string; sk: string }): boolean {
  return a.pk === b.pk && a.sk === b.sk;
}

type StoredEntry = RegisterEntry | RefundEntry | TapeEntry;

/** Re-reads every requested entry and anchors the stored hash of those that match the request. */
export async function writeAnchors(raw: unknown, deps: AnchorWriterDeps): Promise<AnchorWriterResult> {
  const parsed = AnchorRequest.safeParse(raw);
  if (!parsed.success) {
    // Nothing a retry could fix: refused and logged, never anchored.
    deps.log.warn("anchor.invalid_request", {});
    return { anchored: [], skipped: [] };
  }
  const request = parsed.data;
  const skipped: { seq: number; reason: AnchorSkip }[] = [];
  const records: AnchorRecord[] = [];
  for (const requested of request.entries) {
    if (!keyMatches(request, requested)) {
      skipped.push({ seq: requested.seq, reason: "KEY_MISMATCH" });
      continue;
    }
    const entry: StoredEntry | undefined = await deps.connector.chains.getEntry(request.chain, { pk: requested.pk, sk: requested.sk });
    if (!entry) {
      skipped.push({ seq: requested.seq, reason: "ENTRY_MISSING" });
      continue;
    }
    if (entry.worldId !== request.worldId || entry.epoch !== request.epoch || entry.seq !== requested.seq) {
      skipped.push({ seq: requested.seq, reason: "ENTRY_MISMATCH" });
      continue;
    }
    records.push({ worldId: entry.worldId, epoch: entry.epoch, chain: request.chain, seq: entry.seq, hash: entry.hash, atReal: deps.now().toISOString() });
  }
  for (const item of skipped) deps.log.warn("anchor.skipped", { chain: request.chain, worldId: request.worldId, epoch: request.epoch, seq: item.seq, reason: item.reason });
  if (records.length === 0) return { anchored: [], skipped };
  // Every record comes from a re-read entry of the request's world, epoch and chain: one stream.
  const stream = anchorStreamName(request.worldId, request.epoch, request.chain);
  const timestamp = deps.now().getTime();
  await deps.sink.ensureStream(stream);
  await deps.sink.put(
    stream,
    records.sort((a, b) => a.seq - b.seq).map((record) => ({ timestamp, message: JSON.stringify(record) })),
  );
  deps.log.info("anchor.written", { chain: request.chain, worldId: request.worldId, epoch: request.epoch, count: records.length });
  return { anchored: records.map((record) => record.seq), skipped };
}

const LOGS_TIMEOUTS = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

/** The anchor log group (`Resource.RegisterAnchors.name`) through CloudWatch Logs. */
export function cloudWatchAnchorSink(logGroupName: string, client: CloudWatchLogsClient = new CloudWatchLogsClient(awsClientConfig(LOGS_TIMEOUTS))): AnchorSink {
  return {
    async ensureStream(stream) {
      try {
        await client.send(new CreateLogStreamCommand({ logGroupName, logStreamName: stream }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "ResourceAlreadyExistsException")) throw error;
      }
    },
    async put(stream, events) {
      await client.send(new PutLogEventsCommand({ logGroupName, logStreamName: stream, logEvents: [...events] }));
    },
  };
}

let shared: Omit<AnchorWriterDeps, "log"> | undefined;

function stageDeps(): AnchorWriterDeps {
  shared ??= {
    connector: dynamoConnector(),
    sink: cloudWatchAnchorSink(readLinked("RegisterAnchors", z.object({ name: z.string().min(1) })).name),
    now: () => new Date(),
  };
  return { ...shared, log: createLogger({ bindings: { service: "anchor-writer" } }) };
}

/** Lambda entry. A storage or CloudWatch failure throws, so the asynchronous invocation retries. */
export async function handler(event: unknown): Promise<AnchorWriterResult> {
  const deps = stageDeps();
  try {
    return await writeAnchors(event, deps);
  } catch (error) {
    deps.log.error("anchor.failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    throw error;
  }
}
