// JSON log lines of the network mock, one per request, with the caller's correlation id. Only ids,
// operation names, outcomes and the caller's role are logged: never a body, an amount or a header.
import { CorrelationId } from "@reclamo/core-contract";

export type NetworkLogLevel = "info" | "warn" | "error";

export interface NetworkLogLine {
  readonly level: NetworkLogLevel;
  readonly message: string;
  readonly correlationId: string;
  readonly operation?: string;
  readonly worldId?: string;
  readonly role?: string;
  readonly status?: number;
  readonly code?: string;
  /** Set on the lines that count as an audit event (`CALLER_WORLD_DENIED`), for the metric filters. */
  readonly audit?: string;
  readonly errorName?: string;
}

export type NetworkLogSink = (line: NetworkLogLine & { readonly time: string; readonly service: "network-mock" }) => void;

export const stdoutSink: NetworkLogSink = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/** The caller's `X-Correlation-Id` when it is a valid id, else the transport's request id. */
export function correlationIdOf(header: string | undefined, requestId: string | undefined): string {
  if (header !== undefined && CorrelationId.safeParse(header).success) return header;
  return requestId !== undefined && CorrelationId.safeParse(requestId).success ? requestId : "none";
}
