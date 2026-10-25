// What the timers need to fire and to keep their schedules (docs/architecture.md §10): the connector,
// the producer of the customer queues, the networks client (publication and scheduled transfer
// changes go through `NetworkMock`'s Function URL), the Scheduler (only where the role holds TIMERS),
// a logger, the real clock (audit stamps, schedules and the early-fire window; never business time)
// and an id generator. Every port is injected, so tests and local flows run without AWS.
import type { Connector } from "../connector/port";
import { ulid } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { NetworkClient } from "../networks/client";
import type { TimerEventSink } from "./events";
import type { SchedulerPort } from "./scheduler-client";

export interface TimerDeps {
  readonly connector: Connector;
  readonly sink: TimerEventSink;
  /** Absent where the caller cannot reach `NetworkMock`: a publication or a transfer change fails closed. */
  readonly networks?: Pick<NetworkClient, "publishSettlement" | "transitionTransfer">;
  /** Absent where the role has no TIMERS: no schedule is created, moved or deleted from there. */
  readonly scheduler?: SchedulerPort;
  readonly log: Logger;
  readonly realNow: () => Date;
  /** New ids (`aud-…`, `note-…`); deterministic in tests. */
  readonly newId?: (prefix: string) => string;
}

export function newIdOf(deps: Pick<TimerDeps, "newId" | "realNow">, prefix: string): string {
  return deps.newId ? deps.newId(prefix) : `${prefix}-${ulid(deps.realNow().getTime()).toLowerCase()}`;
}

/** The name an error is logged under: never its message (it may carry data). */
export function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
