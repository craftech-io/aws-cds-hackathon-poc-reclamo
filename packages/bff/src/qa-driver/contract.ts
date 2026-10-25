// Contract of the `QaDriver` Lambda (docs/tool-catalog.md "Acciones del QaDriver", docs/test-plan.md §4,
// ADR-0009), shared by the Lambda and the scenario runner (scripts/scenarios/): the request envelope,
// the idempotency key every action carries, the answer envelope, and the ids derived from the key so a
// retried step never duplicates an effect.
//
//   request   { action, idempotencyKey: "<runId>/<scenario>/<step>[/<label>]", input }
//   answer    { ok: true, replayed, result } | { ok: false, error: { code, message, reason? } }
//
// Every wait is a non-blocking probe: an action answers within PROBE_BUDGET_MS with a `state` the runner
// polls with `eventually()`; an answer whose `state` is interim (INTERIM_STATES) is never remembered under
// its key, so the next call of the same step continues the work instead of replaying "still working".
// The inputs of every action are in inputs.ts.
import { z } from "zod";
import { ErrorCode } from "@reclamo/shared";
import { sha256Hex } from "../lib/crypto";

export const QA_ACTIONS = [
  "world.create",
  "world.destroy",
  "auth.session",
  "guest.invite",
  "guest.signup",
  "guest.confirm",
  "guest.resend",
  "guest.session",
  "guest.lead",
  "guest.expireNow",
  "probe.edge",
  "notice.probe",
  "wa.inbound",
  "clock.advance",
  "clock.advanceTo",
  "clock.advanceToNext",
  "clock.advanceBusinessDay",
  "clock.fireNow",
  "clock.unfreeze",
  "clock.freeze",
  "conv.settleProbe",
  "network.publish",
  "network.setDelay",
  "network.setFault",
  "network.transition",
  "receipt.forceFallback",
  "receipt.readProbe",
  "schedule.fireStale",
  "console",
  "mail.outcome",
  "register.tamperProbe",
  "fence.probe",
  "gate.probe",
  "guardrail.probe",
  "caps.prime",
  "kill.setWorld",
  "turn.forceFailure",
  "turn.forceSilence",
  "event.inject",
  "event.poison",
  "dlq.find",
  "dlq.delete",
  "alarm.history",
  "probe.mocks",
  "probe.malwarePlan",
  "memory.inspect",
  "snapshot",
  "turn.inspect",
  "intake.inspect",
  "probe.cognitoClients",
  "policyAudit.run",
  "metrics.get",
  "batch.run",
] as const;
export const QaActionName = z.enum(QA_ACTIONS);
export type QaActionName = z.infer<typeof QaActionName>;

/**
 * Actions never remembered under their key, so a retry reads (or probes) again: reads, probes, and the
 * two logins (`auth.session`, `guest.session`), whose tokens are never stored and whose `auth_time` must
 * be new on every call. Every other action is remembered, and its key replays its first answer.
 */
export const UNREMEMBERED_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>([
  "auth.session",
  "guest.session",
  "guest.lead",
  "conv.settleProbe",
  "receipt.readProbe",
  "mail.outcome",
  "fence.probe",
  "guardrail.probe",
  "probe.edge",
  "notice.probe",
  "dlq.find",
  "alarm.history",
  "probe.mocks",
  "probe.malwarePlan",
  "memory.inspect",
  "snapshot",
  "turn.inspect",
  "intake.inspect",
  "probe.cognitoClients",
  "metrics.get",
]);

/** States of a probe that is still working: the next call of the same key runs again. */
export const INTERIM_STATES: ReadonlySet<string> = new Set(["CREATING", "DESTROYING", "PENDING", "RUNNING", "EXPIRING", "WAITING"]);

/** One invocation works at most this long before it answers its interim state (docs/tool-catalog.md). */
export const PROBE_BUDGET_MS = 50_000;
/** `conv.settleProbe` answers within this (docs/architecture.md §7). */
export const SETTLE_PROBE_MS = 30_000;

/** `<github run id>-<attempt>` (docs/test-plan.md §4): runs exist only in CI. */
export const RunId = z.string().regex(/^\d{1,20}-\d{1,3}$/, "expected <run id>-<attempt>");
export type RunId = z.infer<typeof RunId>;

/** Scenario slug of worlds, users and keys: `sc01`, `sc18-rate`, `smk` (lower case: it ends up in ids). */
export const ScenarioSlug = z.string().regex(/^(?:sc\d{2}|smk|ev\d)(?:-[a-z0-9]{1,8})?$/, "expected sc<nn>[-<suffix>]");
export type ScenarioSlug = z.infer<typeof ScenarioSlug>;

const KEY = /^(\d{1,20}-\d{1,3})\/((?:sc\d{2}|smk|ev\d)(?:-[a-z0-9]{1,8})?)\/(\d{1,3})(?:\/[a-z0-9][a-z0-9.-]{0,31})?$/;

/** `<runId>/<scenario>/<step>` plus an optional label per call inside the step. */
export const IdempotencyKey = z.string().max(128).regex(KEY, "expected <runId>/<scenario>/<step>[/<label>]");
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export function idempotencyKeyOf(parts: { readonly runId: string; readonly scenario: string; readonly step: number; readonly label?: string }): IdempotencyKey {
  const base = `${parts.runId}/${parts.scenario}/${parts.step}`;
  return IdempotencyKey.parse(parts.label === undefined ? base : `${base}/${parts.label}`);
}

/** Run and scenario of a key (the guard binds `world.create` to them). */
export function keyParts(key: IdempotencyKey): { readonly runId: string; readonly scenario: string } {
  const match = KEY.exec(key);
  if (!match?.[1] || !match[2]) throw new RangeError("invalid idempotency key");
  return { runId: match[1], scenario: match[2] };
}

export const QaRequest = z.object({ action: QaActionName, idempotencyKey: IdempotencyKey, input: z.unknown().optional() }).strict();
export type QaRequest = z.infer<typeof QaRequest>;

export const QaError = z.object({ code: ErrorCode, message: z.string(), reason: z.string().optional() });
export type QaError = z.infer<typeof QaError>;

export type QaResponse<T = unknown> = { readonly ok: true; readonly replayed: boolean; readonly result: T } | { readonly ok: false; readonly error: QaError };

export const QaResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), replayed: z.boolean(), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: QaError }),
]);

/** Reasons the driver answers with (besides the domain's own). */
export const QA_REASON = {
  /** The fence: a world outside the QA set, or an action outside a world's closed list. */
  QA_FENCE: "QA_FENCE",
  /** What the action drives is not linked to this function: BLOCKED for the runner, never a pass. */
  NOT_WIRED: "NOT_WIRED",
  /** The key was used by a call with another action or input: nothing ran. */
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  /** `world.create` with a key of another run or scenario. */
  KEY_WORLD_MISMATCH: "KEY_WORLD_MISMATCH",
  /** A model persona asked twice in one world (its loans, codes and lines would collide). */
  DUPLICATE_MODEL: "DUPLICATE_MODEL",
  /** The QA phone range (`+5491100009000`…`9999`) has no free number. */
  NO_QA_PHONE: "NO_QA_PHONE",
  /** Cognito answered a login with a challenge the driver does not answer (MFA). */
  AUTH_CHALLENGE: "AUTH_CHALLENGE",
  /** A self-signup account not confirmed yet: only `guest.confirm` (the product's own path) confirms it. */
  NOT_CONFIRMED: "NOT_CONFIRMED",
  /** An account in a state the driver never signs in (`RESET_REQUIRED`, `FORCE_CHANGE_PASSWORD`…). */
  ACCOUNT_STATE: "ACCOUNT_STATE",
  /** Cognito: the account was confirmed already (`NotAuthorizedException` "Current status is CONFIRMED"). */
  ALREADY_CONFIRMED: "ALREADY_CONFIRMED",
  /** Cognito: no such user. */
  USER_NOT_FOUND: "USER_NOT_FOUND",
  /** Cognito refused the call (`NotAuthorizedException` for another cause). */
  COGNITO_NOT_AUTHORIZED: "COGNITO_NOT_AUTHORIZED",
  /** Cognito throttled the call. */
  COGNITO_RATE_LIMITED: "COGNITO_RATE_LIMITED",
  /** Cognito refused the input (password policy, parameters). */
  COGNITO_INVALID: "COGNITO_INVALID",
  /** A trigger of the pool failed outside the sign-in (the post-confirmation, for one). */
  TRIGGER_FAILED: "TRIGGER_FAILED",
  /** Any other Cognito error: its name is in the message. */
  COGNITO_UNAVAILABLE: "COGNITO_UNAVAILABLE",
} as const;

// ---- Ids derived from the idempotency key (docs/test-plan.md §4) --------------------------------

function digestOf(key: string): string {
  return sha256Hex(IdempotencyKey.parse(key));
}

/** The id of the driver's own mark of a key (`Runtime/W#<w>#IDEMP#QA#<id>`): a key segment holds no `/`. */
export function markIdOf(key: string): string {
  return `qa-${digestOf(key).slice(0, 48)}`;
}

/** `mailId` of a mail the driver makes someone send (`gate.probe`). */
export function qaMailId(key: string): string {
  return `qa${digestOf(key).slice(0, 40)}`;
}

/** Event id of an event the driver enqueues (`event.inject`, `event.poison`, `probe.mocks`). */
export function qaEventId(key: string): string {
  return `qa-${digestOf(key).slice(0, 40)}`;
}

/** Message id of a probe through the outbound gate (`gate.probe`). */
export function qaMessageId(key: string): string {
  return `msg-qa-${digestOf(key).slice(0, 32)}`;
}
