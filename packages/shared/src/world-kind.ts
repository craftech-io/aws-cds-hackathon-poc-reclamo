// The class of a world, derived ONLY from its id (docs/architecture.md §10): nothing a request or a
// row says can move a world into another class, so every fence that depends on the class (queues,
// simulated-envelope keys, mock callers, IAM leading keys) reads it from here.
//
//   DEMO    demo                     the operator's world (video, captures)
//   GUEST   g01..g99, gtest, gprobe  one world per invited guest account; gprobe is the fence probe target
//           gs-<10 base32>           one world per self-signup guest (docs/architecture-guests.md)
//   QA      qa-<runId>-<scenario>, qa-live-<runId>…, qamin
//   SIM     sim-<batch>              simulated-load batches for the metrics
import { z } from "zod";

export const WorldKind = z.enum(["DEMO", "GUEST", "QA", "SIM"]);
export type WorldKind = z.infer<typeof WorldKind>;

/** How a `GUEST` world came to be: pre-provisioned by the operator, or created by a self-signup. */
export const GuestOrigin = z.enum(["INVITED", "SIGNUP"]);
export type GuestOrigin = z.infer<typeof GuestOrigin>;

const INVITED_GUEST = /^(g\d{2}|gtest|gprobe)$/;
const SIGNUP_GUEST = /^gs-[a-z2-7]{10}$/;

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PATTERNS: ReadonlyArray<readonly [WorldKind, RegExp]> = [
  ["DEMO", /^demo$/],
  ["GUEST", INVITED_GUEST],
  ["GUEST", SIGNUP_GUEST],
  ["QA", new RegExp(`^(qamin|qa-${SLUG})$`)],
  ["SIM", new RegExp(`^sim-${SLUG}$`)],
];

/** Longest world id that still fits every key and name built from it. */
export const WORLD_ID_MAX_LENGTH = 48;

export const WorldId = z
  .string()
  .max(WORLD_ID_MAX_LENGTH)
  .refine((value) => PATTERNS.some(([, pattern]) => pattern.test(value)), "unknown world id");
export type WorldId = z.infer<typeof WorldId>;

/** Class of a world id, or `undefined` for anything that is not a world id. */
export function worldKindOf(worldId: string): WorldKind | undefined {
  if (worldId.length > WORLD_ID_MAX_LENGTH) return undefined;
  return PATTERNS.find(([, pattern]) => pattern.test(worldId))?.[0];
}

/** Origin of a `GUEST` world, from its id only; `undefined` for any other world or id. */
export function guestOriginOf(worldId: string): GuestOrigin | undefined {
  if (INVITED_GUEST.test(worldId)) return "INVITED";
  if (SIGNUP_GUEST.test(worldId)) return "SIGNUP";
  return undefined;
}

const QA_SIGNUP = new RegExp(`^qa-${SLUG}-su\\d{1,3}$`);

/** The capacity class of a self-signup world: a visitor's `gs-*` or the scenario runner's `qa-<runId>-su<n>`. */
export type SignupWorldClass = "SIGNUP" | "QA";

/** `SIGNUP` for a `gs-*` world, `QA` for a runner's sign-up world, `undefined` for any other world. */
export function signupWorldClassOf(worldId: string): SignupWorldClass | undefined {
  if (guestOriginOf(worldId) === "SIGNUP") return "SIGNUP";
  if (worldId.length <= WORLD_ID_MAX_LENGTH && QA_SIGNUP.test(worldId)) return "QA";
  return undefined;
}

/** Worlds whose WhatsApp may ever run live (ADR-0002): `demo` and the QA live worlds. */
export function mayRunLive(worldId: string): boolean {
  return worldId === "demo" || /^qa-live-[a-z0-9-]+$/.test(worldId);
}

/** Partition-key prefix of every item of a world (docs/architecture.md §5). */
export function worldKeyPrefix(worldId: string): string {
  return `W#${worldId}#`;
}
