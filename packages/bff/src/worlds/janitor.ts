// What `WorldJanitor` accepts and what it does with it (docs/architecture.md §9.3 and §10,
// docs/architecture-guests.md §5-§6). Two kinds of input, both validated with zod:
//
//   - asynchronous invocations with ONLY `{kind, worldId, requestId}`: `WORLD_CREATE` (a self-signup
//     world, ticket `PROVISIONREQ#`), `WORLD_RESET` (a reset or an expiry, ticket `RESETREQ#`) and
//     `MEMORY_PURGE` (the next passes of a purge, ticket `PURGEREQ#`). The ticket in the world's own
//     partition is the only authorization; nothing else in the payload is trusted;
//   - the scheduled passes, with a constant input: `PROVISION_PASS` (every 5 minutes), `HOURLY_PASS`
//     and `NIGHTLY_PASS` (04:00 ART) (worlds/passes.ts).
import type { Budget, WorldsDeps } from "./deps";
import { JanitorEvent } from "./janitor-event";
import { type ProvisionResult, handleWorldCreate } from "./guest-provision";
import { type PurgeRequestResult, handlePurgeRequest } from "./memory-purge";
import { runHourlyPass, runNightlyPass, runProvisionPass } from "./passes";
import { type ResetWorkResult, runWorldReset } from "./reset-work";

export type JanitorResult =
  | { readonly kind: "INVALID" }
  | { readonly kind: "WORLD_CREATE"; readonly result: ProvisionResult }
  | { readonly kind: "WORLD_RESET"; readonly result: ResetWorkResult }
  | { readonly kind: "MEMORY_PURGE"; readonly result: PurgeRequestResult }
  | { readonly kind: "PROVISION_PASS" | "HOURLY_PASS" | "NIGHTLY_PASS"; readonly counts: Record<string, number> };

/** Runs one input of `WorldJanitor`; an input that is not one of the above is refused and logged. */
export async function runJanitor(deps: WorldsDeps, raw: unknown, budget: Budget): Promise<JanitorResult> {
  const parsed = JanitorEvent.safeParse(raw);
  if (!parsed.success) {
    deps.log.warn("janitor.invalid_event", { issues: parsed.error.issues.length });
    return { kind: "INVALID" };
  }
  const event = parsed.data;
  switch (event.kind) {
    case "WORLD_CREATE":
      return { kind: event.kind, result: await handleWorldCreate(deps, event, budget) };
    case "WORLD_RESET":
      return { kind: event.kind, result: await runWorldReset(deps, event, budget) };
    case "MEMORY_PURGE":
      return { kind: event.kind, result: await handlePurgeRequest(deps, event, budget) };
    case "PROVISION_PASS":
      return { kind: event.kind, counts: await runProvisionPass(deps) };
    case "HOURLY_PASS":
      return { kind: event.kind, counts: await runHourlyPass(deps, budget) };
    case "NIGHTLY_PASS":
      return { kind: event.kind, counts: await runNightlyPass(deps, budget) };
  }
}
