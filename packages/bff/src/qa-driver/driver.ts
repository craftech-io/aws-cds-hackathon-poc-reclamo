// The `QaDriver` (ADR-0009, docs/test-plan.md §4): one Lambda with a closed set of actions, invoked only
// by the bootstrap's `qa-runner` role. Every request goes through the same steps:
//
//   1. envelope and input parsed with zod (`.strict()`: an unknown key is INVALID);
//   2. the world derived from the input and fenced (guard.ts): `qa-*` of the key's own run, the closed
//      lists of `qamin`, `sim-*` and `gprobe`; anything else is FORBIDDEN before a byte is read;
//   3. a changing action already done under the same idempotency key answers its first result
//      (`replayed: true`); provider ids derive from the key, so a lost answer retried produces one effect.
//      The mark keeps a digest of the action and its input: the same key with another call is CONFLICT
//      `IDEMPOTENCY_KEY_REUSED` and nothing runs. A probe answer still working (`state` in
//      INTERIM_STATES) is never remembered: the next call continues the work;
//   4. the action runs; a failure comes back as `{ ok: false, error }`, never as a thrown error.
import { z } from "zod";
import { ToolError, toToolFailure } from "@reclamo/shared";
import type { JsonObject } from "../domain/common";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { procedureKind } from "./console";
import { INTERIM_STATES, QA_REASON, QaRequest, type QaActionName, type QaResponse, UNREMEMBERED_ACTIONS, markIdOf } from "./contract";
import { guard } from "./guard";
import { ACTION_INPUTS, type QaInput } from "./inputs";
import type { ActionContext, ActionHandler, QaPorts } from "./ports";

/** Source of the driver's marks: `Runtime/W#<world>#IDEMP#QA#<markId>`. */
export const QA_MARK_SOURCE = "QA";
/** A result larger than this is not kept for replay: the action runs again (its effects are keyed). */
export const MAX_REPLAY_BYTES = 64 * 1024;

export type ActionHandlers = { readonly [A in QaActionName]: ActionHandler<QaInput<A>> };

export interface QaDriverDeps {
  readonly ports: QaPorts;
  readonly handlers: ActionHandlers;
  readonly loggerFor: (correlationId: string) => Logger;
}

function changes(action: QaActionName, input: unknown): boolean {
  if (action === "console") return procedureKind((input as QaInput<"console">).procedure) === "mutation";
  return !UNREMEMBERED_ACTIONS.has(action);
}

function interim(result: unknown): boolean {
  const state = typeof result === "object" && result !== null ? (result as { readonly state?: unknown }).state : undefined;
  return typeof state === "string" && INTERIM_STATES.has(state);
}

function failureOf(error: unknown): QaResponse {
  if (error instanceof z.ZodError) {
    const where = error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ");
    return { ok: false, error: { code: "INVALID", message: `invalid input: ${where}`, reason: "VALIDATION" } };
  }
  const failure = toToolFailure(error).error;
  return { ok: false, error: { code: failure.code, message: failure.message, ...(failure.reason === undefined ? {} : { reason: failure.reason }) } };
}

/** What a mark is bound to: the action and its parsed input. */
export function callDigest(action: QaActionName, input: unknown): string {
  return sha256Hex(JSON.stringify({ action, input: input ?? null }));
}

type Replay = { readonly found: false } | { readonly found: true; readonly result: unknown };

async function replayOf(ports: QaPorts, worldId: string, key: string, digest: string): Promise<Replay> {
  const mark = await ports.data.claims.getIdempotency(worldId, QA_MARK_SOURCE, markIdOf(key));
  if (mark?.result === undefined) return { found: false };
  if (mark.result["digest"] !== digest) throw new ToolError("CONFLICT", "this idempotency key was used by another action or input", QA_REASON.IDEMPOTENCY_KEY_REUSED);
  if (mark.result["oversize"] === true) return { found: false };
  return { found: true, result: mark.result["value"] ?? null };
}

async function remember(ports: QaPorts, worldId: string, key: string, digest: string, result: unknown): Promise<void> {
  const json = JSON.stringify(result ?? null);
  const stored: JsonObject = json.length > MAX_REPLAY_BYTES ? { digest, oversize: true } : { digest, value: JSON.parse(json) as JsonObject[string] };
  // A concurrent twin of this call may have written first: its effect is the same one (ids derive from the key).
  await ports.data.claims.claimOnce(worldId, QA_MARK_SOURCE, markIdOf(key), stored);
}

export function createQaDriver(deps: QaDriverDeps) {
  return async function run(raw: unknown): Promise<QaResponse> {
    const startedAt = deps.ports.now().getTime();
    const envelope = QaRequest.safeParse(raw);
    if (!envelope.success) return failureOf(envelope.error);
    const { action, idempotencyKey } = envelope.data;
    const log = deps.loggerFor(idempotencyKey.replaceAll("/", "-")).child({ service: "qa-driver", action });
    try {
      const input: unknown = ACTION_INPUTS[action].parse(envelope.data.input ?? {});
      const scope = guard(action, input, idempotencyKey);
      const mutating = changes(action, input) && scope.worldId !== undefined;
      const digest = mutating ? callDigest(action, input) : "";
      if (mutating && scope.worldId !== undefined) {
        const replay = await replayOf(deps.ports, scope.worldId, idempotencyKey, digest);
        if (replay.found) {
          log.info("qa_driver.replayed", { worldId: scope.worldId });
          return { ok: true, replayed: true, result: replay.result };
        }
      }
      const ctx: ActionContext = { key: idempotencyKey, ...(scope.worldId === undefined ? {} : { worldId: scope.worldId }), ports: deps.ports, log, startedAt };
      const handler = deps.handlers[action] as ActionHandler<unknown>;
      const result = await handler(input, ctx);
      if (mutating && scope.worldId !== undefined && !interim(result)) await remember(deps.ports, scope.worldId, idempotencyKey, digest, result);
      log.info("qa_driver.done", { worldId: scope.worldId ?? null, ms: deps.ports.now().getTime() - startedAt });
      return { ok: true, replayed: false, result };
    } catch (error) {
      const failure = failureOf(error);
      const fields = { code: failure.ok ? null : failure.error.code, reason: failure.ok ? null : (failure.error.reason ?? null), ms: deps.ports.now().getTime() - startedAt };
      if (error instanceof ToolError || error instanceof z.ZodError) log.warn("qa_driver.refused", fields);
      else log.error("qa_driver.failed", { ...fields, errorName: error instanceof Error ? error.name : "unknown" });
      return failure;
    }
  };
}

export type QaDriver = ReturnType<typeof createQaDriver>;
