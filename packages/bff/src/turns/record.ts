// What a turn leaves behind besides its tools' effects (docs/architecture.md §9.1 and §12):
//
//   TurnNote    the final text of the Harness (an internal note, never sent), or a fixed code when its
//               text must not be kept (a guardrail's sentinel, a failed turn); `refs` lists what the turn
//               was about (the event, or the operator's messages of a release, FL-086)
//   Metrics     the turn's tokens (`metadata.usage`) on the KPI row of its complaint: `WORLD`, or `BATCH`
//               with the batch id in a `sim-*` world; `agentMode` says whether the Harness was real or the
//               scripted one of the local flows
//   log lines   `TurnLatency` (dimension `withImage`) and `TurnErrors` (dimension `stopReason`, including
//               `max_tokens`), read by the metric filters (observability is logs only, ADR-0021 §11)
import { worldKindOf } from "@reclamo/shared";
import type { Connector } from "../connector/port";
import { isConflict } from "../connector/errors";
import type { Complaint } from "../domain/complaint";
import type { TokenUsage } from "../agent/harness-client";
import type { Logger } from "../lib/log";
import { maskSensitive } from "../lib/mask";
import type { TurnEvent } from "../worker/events";

export const TURN_METRICS = { latency: "TurnLatency", errors: "TurnErrors" } as const;

/** Fixed notes of the turns that left no text of the model. */
export const FIXED_NOTES = {
  guardrail: "GUARDRAIL_BLOCK",
  failed: "TURN_FAILED",
  silent: "TURN_FORCED_SILENT",
} as const;

export type AgentMode = "REAL" | "SCRIPTED";

export interface TurnRecordDeps {
  readonly data: Pick<Connector, "conversations" | "metrics" | "write">;
  readonly agentMode: AgentMode;
  readonly log: Logger;
}

export interface NoteInput {
  readonly event: TurnEvent;
  readonly turnId: string;
  readonly text: string;
  readonly refs: readonly string[];
  readonly stopReason?: string;
}

/** Appends the note once; a retried event that already wrote it keeps the first one. */
export async function writeTurnNote(deps: TurnRecordDeps, input: NoteInput): Promise<void> {
  const text = maskSensitive(input.text).trim() || FIXED_NOTES.failed;
  const op = deps.data.conversations.putTurnNoteOp({
    worldId: input.event.worldId,
    customerId: input.event.customerId,
    turnId: input.turnId,
    atSim: input.event.eventAtSim,
    trigger: input.event.type,
    text: [...text].slice(0, 4_000).join(""),
    refs: input.refs.slice(0, 50).map((ref) => ref.slice(0, 200)),
    ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason.slice(0, 40) }),
  });
  try {
    await deps.data.write(op);
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

/** The turn's tokens on its complaint's KPI row (created on the first turn of the complaint). */
export async function recordUsage(deps: TurnRecordDeps, event: TurnEvent, complaint: Complaint | undefined, usage: TokenUsage): Promise<void> {
  if (complaint === undefined) {
    deps.log.info("turn.usage_without_complaint", { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    return;
  }
  const batch = worldKindOf(event.worldId) === "SIM";
  const source = batch ? "BATCH" : "WORLD";
  const runId = batch ? event.worldId : "world";
  const rows = await deps.data.metrics.list(event.worldId, { source, runId });
  const row = rows.find((candidate) => candidate.complaintId === complaint.complaintId);
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens;
  await deps.data.metrics.put({
    worldId: event.worldId,
    source,
    runId,
    complaintId: complaint.complaintId,
    complaintType: complaint.type,
    origin: complaint.origin,
    humanActions: row?.humanActions ?? [],
    messages: row?.messages ?? { wa: 0, email: 0 },
    ...(row === undefined ? {} : stripTokens(row)),
    // The agent that ran this turn decides the row's mode, whatever the acknowledgement wrote first.
    agentMode: deps.agentMode,
    tokens: { in: (row?.tokens.in ?? 0) + usage.inputTokens, out: (row?.tokens.out ?? 0) + usage.outputTokens, cached: (row?.tokens.cached ?? 0) + cached },
  });
}

function stripTokens<T extends { readonly tokens: unknown; readonly createdAt?: unknown; readonly updatedAt?: unknown }>(row: T): Omit<T, "tokens" | "createdAt" | "updatedAt"> {
  const { tokens: _tokens, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = row;
  return rest;
}

/** `TurnLatency` (real ms of the Harness call) for the metric filter. */
export function logTurnLatency(log: Logger, latencyMs: number, fields: { readonly trigger: string; readonly withImage: boolean; readonly toolUses: number; readonly outcome: string }): void {
  log.info("turn.latency", { metric: TURN_METRICS.latency, latencyMs, ...fields });
}

/** `TurnErrors` by cause and stop reason (`max_tokens` must never appear, `SC-01`). */
export function logTurnError(log: Logger, fields: { readonly trigger: string; readonly cause: string; readonly stopReason?: string }): void {
  log.warn("turn.error", { metric: TURN_METRICS.errors, ...fields });
}
