// The fence of the `QaDriver` (docs/tool-catalog.md "Acciones del QaDriver", docs/architecture.md §14
// "Cerca del QaDriver", ADR-0009). Before an action reads or writes anything, the guard derives the one
// world it touches from its parsed input (never from a stored row the input points at) and checks it:
//
//   qa-<runId>-…, qa-live-<runId>   every action but `batch.run`, and only worlds of the key's own run
//   qamin                           the closed list QAMIN_ACTIONS
//   sim-<batch>                     `batch.run` only
//   gprobe                          `fence.probe({kind: WORLD_PATHS})` only (it reads, IAM gives it no write)
//   demo, gNN, gtest, gs-*, others  nothing: FORBIDDEN `QA_FENCE`
//
// Console calls run the real appRouter as a server-built principal; `GUEST` only in a `qa-*` world (the
// in-process principal refuses it elsewhere too, auth/principal.ts). This is one layer: IAM (LeadingKeys,
// the QA queue, `qa/*`, `tm-qa-*`, `qa-*` anchor streams) and every Lambda the driver can invoke close the
// same worlds again on their side.
import { type StaffRole, ToolError, WorldId, worldKindOf } from "@reclamo/shared";
import { QA_REASON, type IdempotencyKey, type QaActionName, keyParts } from "./contract";
import type { QaInput } from "./inputs";

/** What `qamin` admits (SC-18 and the KPIs read it and reset it; nothing else moves it). */
export const QAMIN_ACTIONS: readonly string[] = ["wa.inbound", "snapshot", "conv.settleProbe", "memory.inspect", "console.clock.reset", "console.clock.resetStatus", "metrics.get"];

/** Actions that touch no world: they read the stack (probes) or the QA dead-letter queue. */
export const WORLDLESS_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>(["probe.edge", "notice.probe", "guardrail.probe", "dlq.find", "dlq.delete", "alarm.history", "probe.malwarePlan"]);

/** Global buckets `caps.prime` names without a world (`GLOBALCAP#QA#…`, `SIGNUPCAP#QA#…`, the guest capacity). */
const WORLDLESS_BUCKETS: ReadonlySet<string> = new Set(["GLOBALCAP_QA", "SIGNUP_QA", "GUESTCAP_QA"]);

export type WorldClass = "QA" | "QAMIN" | "SIM" | "GPROBE" | "OTHER";

/** What an action touches, derived from its parsed input. */
export interface Scope {
  /** The action, or `console.<procedure>` (the name the closed lists use). */
  readonly name: string;
  /** `undefined` only for the world-less actions. */
  readonly worldId?: string;
  /** The role a console call runs as. */
  readonly role?: StaffRole;
}

export function forbidden(message: string): ToolError {
  return new ToolError("FORBIDDEN", message, QA_REASON.QA_FENCE);
}

/** The class of a world for the fence: from its id only (packages/shared world-kind.ts). */
export function worldClassOf(worldId: string): WorldClass {
  if (worldId === "qamin") return "QAMIN";
  if (worldId === "gprobe") return "GPROBE";
  const kind = worldKindOf(worldId);
  if (kind === "QA" && worldId.startsWith("qa-")) return "QA";
  if (kind === "SIM") return "SIM";
  return "OTHER";
}

/** `qa-<runId>-<scenario>` (or `qa-live-<runId>` with `live`): the world of a scenario. */
export function scenarioWorldId(runId: string, scenario: string, live = false): string {
  return WorldId.parse(live ? `qa-live-${runId}` : `qa-${runId}-${scenario}`);
}

/** `qa-<runId>-su<n>`: the only `W#qa-*` world a self-signup of the runner produces. */
export function signupWorldId(runId: string, key: string): string {
  return WorldId.parse(`qa-${runId}-${key}`);
}

/** `sim-<runId>-<batchId>`: the root of a metrics batch (its worlds are `<root>-<n>`). */
export function batchWorldId(runId: string, batchId: string): string {
  return WorldId.parse(`sim-${runId}-${batchId}`);
}

/** The run a QA world belongs to (`qa-<runId>-…` or `qa-live-<runId>`). */
function runOfWorld(worldId: string): string | undefined {
  const match = /^qa-(?:live-)?(\d{1,20}-\d{1,3})(?:-|$)/.exec(worldId);
  return match?.[1];
}

/** The fence proper, over a derived scope (pure: guard.test.ts drives it case by case). */
export function checkFence(scope: Scope, key: IdempotencyKey): void {
  if (scope.worldId === undefined) {
    if (!WORLDLESS_ACTIONS.has(scope.name as QaActionName) && scope.name !== "caps.prime") throw forbidden(`${scope.name} needs a world`);
    return;
  }
  const worldClass = worldClassOf(scope.worldId);
  switch (worldClass) {
    case "QA": {
      if (scope.name === "batch.run") throw forbidden("batch.run builds its own sim-* worlds");
      if (runOfWorld(scope.worldId) !== keyParts(key).runId) throw forbidden(`${scope.worldId} belongs to another run`);
      return;
    }
    case "QAMIN":
      if (!QAMIN_ACTIONS.includes(scope.name)) throw forbidden(`${scope.name} is not allowed on qamin`);
      if (scope.role === "GUEST") throw forbidden("GUEST acts only in a qa-* world");
      return;
    case "SIM":
      if (scope.name !== "batch.run") throw forbidden(`only batch.run acts on a batch world (${scope.worldId})`);
      return;
    case "GPROBE":
      if (scope.name !== "fence.probe") throw forbidden("gprobe is only read by fence.probe({kind: WORLD_PATHS})");
      return;
    case "OTHER":
      throw forbidden(`the QA driver never acts on ${scope.worldId}`);
  }
}

/** `world.create` is idempotent by run and scenario: its key must be of the same run and scenario. */
function checkWorldKey(key: IdempotencyKey, input: QaInput<"world.create">): void {
  const parts = keyParts(key);
  if (parts.runId !== input.runId || parts.scenario.split("-")[0] !== input.scenario.split("-")[0]) {
    throw new ToolError("INVALID", "the key of world.create must be of the same run and scenario", QA_REASON.KEY_WORLD_MISMATCH);
  }
}

function sameRun(key: IdempotencyKey, runId: string): void {
  if (keyParts(key).runId !== runId) throw forbidden("a step acts only on its own run");
}

/** Derives what `action` touches from its parsed input (see the header). */
export function scopeOf(action: QaActionName, raw: unknown, key: IdempotencyKey): Scope {
  if (WORLDLESS_ACTIONS.has(action)) return { name: action };
  switch (action) {
    case "world.create": {
      const input = raw as QaInput<"world.create">;
      checkWorldKey(key, input);
      if (input.live === true && input.template !== "models") throw new ToolError("INVALID", "the live QA world is built from the models", "LIVE_TEMPLATE");
      return { name: action, worldId: scenarioWorldId(input.runId, input.scenario, input.live === true) };
    }
    case "guest.signup":
    case "guest.confirm":
    case "guest.resend":
    case "guest.session":
    case "guest.lead": {
      const input = raw as QaInput<"guest.signup">;
      sameRun(key, input.runId);
      return { name: action, worldId: signupWorldId(input.runId, input.key) };
    }
    case "guest.expireNow": {
      const input = raw as QaInput<"guest.expireNow">;
      if (!/^qa-\d{1,20}-\d{1,3}-su\d{1,3}$/.test(input.worldId)) throw forbidden("guest.expireNow acts only on a runner sign-up world (qa-<runId>-su<n>)");
      return { name: action, worldId: input.worldId };
    }
    case "batch.run": {
      const input = raw as QaInput<"batch.run">;
      sameRun(key, input.runId);
      return { name: action, worldId: batchWorldId(input.runId, input.batchId) };
    }
    case "caps.prime": {
      const input = raw as QaInput<"caps.prime">;
      if (WORLDLESS_BUCKETS.has(input.bucket)) {
        if (input.worldId !== undefined) throw new ToolError("INVALID", `${input.bucket} is a global QA bucket: name no world`);
        return { name: action };
      }
      if (input.worldId === undefined) throw new ToolError("INVALID", `${input.bucket} needs its world`);
      return { name: action, worldId: input.worldId };
    }
    case "fence.probe": {
      const input = raw as QaInput<"fence.probe">;
      // Only the WORLD_PATHS probe reads gprobe; the recipient probe is an action of a QA world.
      return { name: input.kind === "WORLD_PATHS" ? "fence.probe" : "fence.probe.recipient", worldId: input.worldId };
    }
    case "console": {
      const input = raw as QaInput<"console">;
      if (input.role === "GUEST" && worldClassOf(input.worldId) !== "QA") throw forbidden("GUEST acts only in a qa-* world");
      return { name: `console.${input.procedure}`, worldId: input.worldId, role: input.role };
    }
    default: {
      const worldId = (raw as { readonly worldId?: unknown }).worldId;
      if (typeof worldId !== "string") throw new ToolError("INVALID", `${action} names no world`);
      return { name: action, worldId };
    }
  }
}

/** Scope and fence together: what the driver runs before anything else. */
export function guard(action: QaActionName, input: unknown, key: IdempotencyKey): Scope {
  const scope = scopeOf(action, input, key);
  checkFence(scope, key);
  return scope;
}
