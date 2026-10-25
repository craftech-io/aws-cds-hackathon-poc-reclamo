/// <reference path="../../sst-env.d.ts" />
// What every module of complaints/ needs to write: the connector, the chain key, the anchor
// requester, the milestone scheduler (WP-30 implements it), a logger, the real clock for `atReal`
// and stamps, an id generator and the retry seams. Business time never comes from here: every
// function receives the simulated instant of its event (ADR-0011).
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import { ulid } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import type { RetryOptions } from "../lib/retry";
import { keySecret } from "../lib/secrets";
import { type AnchorRequester, lambdaAnchorRequester } from "./anchors";

/** Schedules and deletes the Scheduler schedules of timers (timers/, WP-30); absent → nothing to do. */
export interface MilestoneScheduler {
  /** Called after the commit that created the timers: creates their schedules when the world runs. */
  schedule(worldId: string, timerIds: readonly { kind: string; timerId: string }[]): Promise<void>;
  /** Called after the commit that cancelled the timers: deletes the schedules they had. */
  cancel(worldId: string, scheduleNames: readonly string[]): Promise<void>;
}

export interface ComplaintsDeps {
  readonly connector: Connector;
  /** `RegisterChainKey`, the HMAC key of the three hash chains (ADR-0014). */
  readonly chainKey: string;
  readonly anchors: AnchorRequester;
  readonly log: Logger;
  readonly milestones?: MilestoneScheduler;
  /** Real clock: `atReal` of entries and audit stamps; never business time. */
  readonly realNow?: () => Date;
  /** New ids (`cmp-…`, `note-…`, `aud-…`); deterministic in tests. */
  readonly newId?: (prefix: string) => string;
  /** Backoff seams of the optimistic retries (tests run them without waiting). */
  readonly retry?: Pick<RetryOptions, "sleep" | "random">;
}

/** Attempts of an optimistic write (re-read and retry after a cancelled transaction, §8.1-§8.3). */
export const OPTIMISTIC_ATTEMPTS = 5;

export function realNowOf(deps: Pick<ComplaintsDeps, "realNow">): Date {
  return deps.realNow ? deps.realNow() : new Date();
}

export function newIdOf(deps: Pick<ComplaintsDeps, "newId" | "realNow">, prefix: string): string {
  return deps.newId ? deps.newId(prefix) : `${prefix}-${ulid(realNowOf(deps).getTime()).toLowerCase()}`;
}

/** The deps inside a Lambda of the stage: DynamoDB, the linked `RegisterChainKey` and `AnchorWriter`. */
export function stageComplaintsDeps(options: { log?: Logger; milestones?: MilestoneScheduler } = {}): ComplaintsDeps {
  const log = options.log ?? createLogger({ bindings: { service: "complaints" } });
  return {
    connector: dynamoConnector(),
    chainKey: keySecret("RegisterChainKey"),
    anchors: lambdaAnchorRequester(log),
    log,
    ...(options.milestones ? { milestones: options.milestones } : {}),
  };
}
