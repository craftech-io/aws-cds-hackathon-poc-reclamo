// The reads every turn starts with, run by the worker before the Harness (ADR-0021 §7): the Harness runs
// the tool calls of one model response one after the other, each a round trip of the Gateway, Cedar and a
// Lambda, so what every turn needs is read by code first. Each read goes through its target IN PROCESS,
// with the turn's own `sessionToken` and the `WORKER` caller of `createToolHandler`: the same session, the
// same `LAM-*` fences and the same `Runtime/W#<w>#TURN#<turnId>/RESULT#…` row as a Gateway call, so what
// the model reads in the envelope grounds G2 and the outbound verification exactly as if it had called
// the tool itself.
//
//   every turn                 identify_customer
//   identified session only    get_account, list_operations (the last 30 days of the world clock, ≤ 50 rows)
//   an open charge complaint   list_operations of kind CHARGE over the widest window (90 days): a disputed
//                              charge can be older than the 30 days, and the window is decided here, not
//                              left to the model
//
// They run in parallel. A read that fails (or answers `NOT_IDENTIFIED`) is left out of the envelope and
// the model asks for it as before; it never stops the turn. A turn cut by a cap or the kill switch never
// gets here (worker/run-turn.ts), so it spends nothing.
import { type Caller, addCalendarDays } from "@reclamo/shared";
import type { ToolResponse } from "../agent-tools/common/context";
import type { GatewayTargetRuntime } from "../agent-tools/common/handler";
import type { PreloadedResult } from "../agent/envelope";
import { isoAr } from "../complaints/sla";
import type { Logger } from "../lib/log";

/** The two targets the preloaded reads live in, in process. */
export interface TurnReads {
  readonly identity: Pick<GatewayTargetRuntime, "invoke">;
  readonly account: Pick<GatewayTargetRuntime, "invoke">;
}

/** Days of operations the turn starts with, counted on the world clock. */
export const PRELOAD_OPERATIONS_DAYS = 30;
/** Days of charges a turn with an open `UNRECOGNIZED_CHARGE` complaint starts with (`MAX_OPERATIONS_DAYS`). */
export const PRELOAD_CHARGES_DAYS = 90;

export interface PlannedRead {
  readonly target: keyof TurnReads;
  readonly tool: "identify_customer" | "get_account" | "list_operations";
  readonly input: Readonly<Record<string, string>>;
}

export interface PreloadInput {
  readonly sessionToken: string;
  readonly worldId: string;
  readonly eventId: string;
  /** The session is identified (`identifiedUntilReal` ahead of the real clock). */
  readonly identified: boolean;
  /** Simulated instant of the event: the window of `list_operations` ends on its Argentine date. */
  readonly eventAtSim: string;
  /** The session carries an open `UNRECOGNIZED_CHARGE` complaint: its charges are read 90 days back. */
  readonly chargeComplaintOpen?: boolean;
}

/** What the turn reads before the Harness, in the order the envelope carries it. */
export function planReads(identified: boolean, eventAtSim: string, chargeComplaintOpen = false): PlannedRead[] {
  const reads: PlannedRead[] = [{ target: "identity", tool: "identify_customer", input: {} }];
  if (!identified) return reads;
  const toDate = isoAr(new Date(eventAtSim)).slice(0, 10);
  return [
    ...reads,
    { target: "account", tool: "get_account", input: {} },
    { target: "account", tool: "list_operations", input: { fromDate: addCalendarDays(toDate, -PRELOAD_OPERATIONS_DAYS), toDate } },
    ...(chargeComplaintOpen ? [{ target: "account", tool: "list_operations", input: { kind: "CHARGE", fromDate: addCalendarDays(toDate, -PRELOAD_CHARGES_DAYS), toDate } } satisfies PlannedRead] : []),
  ];
}

function failureOf(answer: ToolResponse): { readonly code: string; readonly reason?: string } | undefined {
  if (answer.ok) return undefined;
  return { code: answer.error.code, ...(answer.error.reason === undefined ? {} : { reason: answer.error.reason }) };
}

/** Runs the turn's reads together; only the answers that came back `ok` reach the envelope. */
export async function preloadReads(reads: TurnReads, input: PreloadInput, log: Logger): Promise<PreloadedResult[]> {
  const planned = planReads(input.identified, input.eventAtSim, input.chargeComplaintOpen === true);
  const caller: Caller = { kind: "WORKER", worldId: input.worldId, eventId: input.eventId };
  const answers = await Promise.all(
    planned.map(async (read): Promise<ToolResponse | undefined> => {
      try {
        return await reads[read.target].invoke(read.tool, { ...read.input, sessionToken: input.sessionToken }, caller);
      } catch (error) {
        log.warn("turn.preload_failed", { tool: read.tool, errorName: error instanceof Error ? error.name : "unknown" });
        return undefined;
      }
    }),
  );
  const preloaded: PreloadedResult[] = [];
  answers.forEach((answer, index) => {
    const tool = planned[index]?.tool;
    if (answer === undefined || tool === undefined) return;
    const failure = failureOf(answer);
    if (failure === undefined) preloaded.push({ tool, output: answer });
    else log.warn("turn.preload_failed", { tool, code: failure.code, reason: failure.reason });
  });
  return preloaded;
}
