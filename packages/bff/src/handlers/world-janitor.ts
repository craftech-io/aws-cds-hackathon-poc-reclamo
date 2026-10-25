// Lambda entry of `WorldJanitor` (docs/architecture.md §10, docs/architecture-guests.md §5-§6; timeout
// 900 s, infra/bff.ts): the asynchronous creations, resets, expiries and Memory purges, each with its
// ticket, and the scheduled passes. The whole logic lives in worlds/janitor.ts; this file only builds
// the stage's deps (a continuation invokes this same function by the ARN of the running invocation),
// the logger and the budget from the invocation's remaining time.
import type { Context } from "aws-lambda";
import { type Budget, UNLIMITED, type WorldsDeps } from "../worlds/deps";
import { type JanitorResult, runJanitor } from "../worlds/janitor";
import { stageWorldsDeps } from "../worlds/stage";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";

type Invocation = Pick<Context, "getRemainingTimeInMillis" | "invokedFunctionArn">;

export type WorldJanitorHandler = (event: unknown, context?: Invocation) => Promise<JanitorResult>;

export function createWorldJanitorHandler(
  depsFor: (log: Logger, context: Invocation | undefined) => WorldsDeps,
  newLog: () => Logger = () => createLogger({ correlationId: newCorrelationId(), bindings: { service: "world-janitor" } }),
): WorldJanitorHandler {
  return async (event, context) => {
    const log = newLog();
    const budget: Budget = context ? { remainingMs: () => context.getRemainingTimeInMillis() } : UNLIMITED;
    const result = await runJanitor(depsFor(log, context), event, budget);
    log.info("janitor.done", { kind: result.kind, ...("result" in result ? { status: result.result.status } : {}) });
    return result;
  };
}

export const handler: WorldJanitorHandler = createWorldJanitorHandler((log, context) => stageWorldsDeps({ log, ...(context ? { selfArn: context.invokedFunctionArn } : {}) }));
