/// <reference path="../../sst-env.d.ts" />
// The anchors of the three hash chains outside the tables (docs/architecture.md §8.3, ADR-0014):
//
//   - the request a writer sends, after its commit, to `AnchorWriter` by an asynchronous invocation
//     (`{worldId, epoch, chain, entries: [{seq, pk, sk}]}`, up to 100 entries): only keys, never a
//     hash, so a forged request can only make `AnchorWriter` copy what is already stored;
//   - the record `AnchorWriter` puts in the stream `<worldId>-e<epoch>-<chain>` of the anchor log
//     group (`{worldId, epoch, chain, seq, hash, atReal}`);
//   - the reader of the verification: `FilterLogEvents` by stream prefix, keeping the
//     `ingestionTime` CloudWatch Logs assigns (the client-chosen `timestamp` is never trusted).
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { WorldId } from "@reclamo/shared";
import { ChainKind } from "../domain/ledger";
import { awsClientConfig } from "../lib/clients";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";

/** Entries one asynchronous invocation carries at most. */
export const MAX_ANCHOR_ENTRIES = 100;

const Epoch = z.number().int().nonnegative();
const Seq = z.number().int().positive();

export const AnchorRequestEntry = z.object({ seq: Seq, pk: z.string().min(1).max(256), sk: z.string().min(1).max(256) }).strict();

/** What `AnchorWriter` accepts: keys of committed entries of one world, epoch and chain. */
export const AnchorRequest = z
  .object({ worldId: WorldId, epoch: Epoch, chain: ChainKind, entries: z.array(AnchorRequestEntry).min(1).max(MAX_ANCHOR_ENTRIES) })
  .strict();
export type AnchorRequest = z.infer<typeof AnchorRequest>;

/** One anchor as `AnchorWriter` writes it: the stored hash of a committed entry. */
export const AnchorRecord = z
  .object({ worldId: WorldId, epoch: Epoch, chain: ChainKind, seq: Seq, hash: z.string().min(1).max(128), atReal: z.string().min(1).max(40) })
  .strict();
export type AnchorRecord = z.infer<typeof AnchorRecord>;

/** An anchor event as read back: its stream, `ingestionTime` (CloudWatch's) and raw message. */
export interface AnchorEvent {
  readonly stream: string;
  readonly ingestionTime: number;
  /** Client-chosen; kept only to show it, never to order. */
  readonly timestamp?: number;
  readonly eventId?: string;
  readonly message: string;
}

/** `<worldId>-e<epoch>-<chain>`: the only stream an anchor of this chain may live in. */
export function anchorStreamName(worldId: string, epoch: number, chain: ChainKind): string {
  return `${worldId}-e${epoch}-${chain}`;
}

/** Prefix of every stream of a world and epoch (`FilterLogEvents`). */
export function anchorStreamPrefix(worldId: string, epoch: number): string {
  return `${worldId}-e${epoch}-`;
}

/** Sends the request to `AnchorWriter`; never waits for the anchor itself. */
export interface AnchorRequester {
  request(request: AnchorRequest): Promise<void>;
}

/** Reads every anchor event of a world and epoch (all its chains). */
export interface AnchorReader {
  read(worldId: string, epoch: number): Promise<AnchorEvent[]>;
}

const LinkedName = z.object({ name: z.string().min(1) });

const ANCHOR_INVOKE_TIMEOUTS = { requestTimeoutMs: 2_000, connectionTimeoutMs: 1_000, maxAttempts: 2 } as const;
const ANCHOR_READ_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

/** `InvocationType: Event` of the linked `AnchorWriter`; a missing link is logged and skipped (the entry stays `partial`). */
export function lambdaAnchorRequester(log: Logger, client?: LambdaClient): AnchorRequester {
  let lambda = client;
  return {
    async request(request) {
      const payload = AnchorRequest.parse(request);
      let functionName: string;
      try {
        functionName = readLinked("AnchorWriter", LinkedName).name;
      } catch {
        log.warn("register.anchor_writer_not_linked", { chain: payload.chain });
        return;
      }
      lambda ??= new LambdaClient(awsClientConfig(ANCHOR_INVOKE_TIMEOUTS));
      const command = new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(payload)) });
      await lambda.send(command);
    },
  };
}

/** Pages of `FilterLogEvents` read at most (a world's epoch has a few thousand anchors at most). */
export const MAX_ANCHOR_PAGES = 200;

/** `FilterLogEvents` on the linked `RegisterAnchors` log group, every page, with `ingestionTime`. */
export function cloudWatchAnchorReader(client?: CloudWatchLogsClient, logGroupName?: string): AnchorReader {
  let logs = client;
  return {
    async read(worldId, epoch) {
      logs ??= new CloudWatchLogsClient(awsClientConfig(ANCHOR_READ_TIMEOUTS));
      const group = logGroupName ?? readLinked("RegisterAnchors", LinkedName).name;
      const events: AnchorEvent[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_ANCHOR_PAGES; page += 1) {
        const command = new FilterLogEventsCommand({ logGroupName: group, logStreamNamePrefix: anchorStreamPrefix(worldId, epoch), ...(nextToken ? { nextToken } : {}) });
        const output = await logs.send(command);
        for (const event of output.events ?? []) {
          if (event.logStreamName === undefined || event.ingestionTime === undefined || event.message === undefined) continue;
          events.push({
            stream: event.logStreamName,
            ingestionTime: event.ingestionTime,
            message: event.message,
            ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
            ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
          });
        }
        nextToken = output.nextToken;
        if (!nextToken) return events;
      }
      throw new RangeError(`more than ${MAX_ANCHOR_PAGES} pages of anchors`);
    },
  };
}
