// One JSON line per request of the core mock. Only ids and outcomes: operation, status, contract
// code, caller, world and the caller's correlation id; never a body, an amount, a name or an
// address. A `CALLER_WORLD_DENIED` line carries `audit: true` (the mock writes no table but `Core`,
// so its audit trail of a denied cross-world call is this line).
import type { CoreEvent } from "./app";

export function coreLogLine(message: string, event: Partial<CoreEvent>, requestId?: string): string {
  const level = event.audit === true || (event.status ?? 0) >= 500 ? "warn" : "info";
  return JSON.stringify({
    level,
    message,
    service: "core-mock",
    correlationId: event.correlationId ?? requestId ?? "none",
    ...(requestId === undefined ? {} : { requestId }),
    operation: event.operation,
    status: event.status,
    ...(event.code === undefined ? {} : { code: event.code }),
    ...(event.caller === undefined ? {} : { caller: event.caller }),
    ...(event.worldId === undefined ? {} : { worldId: event.worldId }),
    ...(event.audit === true ? { audit: true, metric: "CoreCallerDenied" } : {}),
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  });
}
