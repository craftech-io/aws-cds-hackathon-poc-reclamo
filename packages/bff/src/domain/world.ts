// `Worlds` table (docs/architecture.md §5 and §10): the world itself (`META`), its settings
// (`SETTINGS`: caps, contact hours, channel modes…) and its staff rows (`STAFF#`), which are the only
// source of a console user's world, staff id and role (ADR-0018).
import { z } from "zod";
import { CapAction, ChannelMode, GuestOrigin, IsoInstant, StaffRole, WorldId, WorldKind, worldKindOf } from "@reclamo/shared";
import { Cents, Epoch, Id, StaffId, Versioned } from "./common";

/** `EXPIRING` and `EXPIRED` only for self-signup worlds (`gs-*`, docs/architecture-guests.md §5-§6). */
export const WorldStatus = z.enum(["REGISTERED", "CREATING", "READY", "RESETTING", "EXPIRING", "EXPIRED"]);
export type WorldStatus = z.infer<typeof WorldStatus>;

export const WorldTemplate = z.enum(["demo", "guest", "qa-min", "models"]);
export type WorldTemplate = z.infer<typeof WorldTemplate>;

/** Where the block-by-block world factory stopped (`META.buildCursor`). */
export const BuildCursor = z.object({ phase: z.string().min(1).max(64), block: z.number().int().nonnegative() });
export type BuildCursor = z.infer<typeof BuildCursor>;

export const ResetPhase = z.enum(["WIPE", "OBJECTS", "RELOAD", "PURGE"]);
export type ResetPhase = z.infer<typeof ResetPhase>;

/** `META.reset` while the world is `RESETTING` (docs/architecture.md §10). */
export const ResetState = z.object({
  requestId: Id,
  fromEpoch: Epoch,
  toEpoch: Epoch,
  phase: ResetPhase,
  requestedAtReal: IsoInstant,
  heartbeatAtReal: IsoInstant,
  attempts: z.number().int().nonnegative(),
  cursor: z.string().max(2_048).optional(),
});
export type ResetState = z.infer<typeof ResetState>;

export const WorldMeta = z
  .object({
    worldId: WorldId,
    kind: WorldKind,
    template: WorldTemplate,
    epoch: Epoch,
    status: WorldStatus,
    buildCursor: BuildCursor.optional(),
    reset: ResetState.optional(),
    lastResetAtReal: IsoInstant.optional(),
    /** Self-signup worlds: where the world came from, the queue and the expiry clock (real time). */
    origin: GuestOrigin.optional(),
    requestedAtReal: IsoInstant.optional(),
    readyAtReal: IsoInstant.optional(),
    lastActivityAtReal: IsoInstant.optional(),
    /** Position in the provisioning queue, written by WorldJanitor's pass (0 = next). */
    queuePosition: z.number().int().nonnegative().optional(),
    ...Versioned,
  })
  .refine((meta) => worldKindOf(meta.worldId) === meta.kind, { message: "kind must be the class of the world id", path: ["kind"] });
export type WorldMeta = z.infer<typeof WorldMeta>;

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
export const TimeRange = z.object({ from: ClockTime, to: ClockTime });
export type TimeRange = z.infer<typeof TimeRange>;

/** Tiers of a money action: up to `agentCents` the agent acts; up to `operatorCents` an operator approves; above, a supervisor. */
export const CapLimits = z.object({ agentCents: Cents.nonnegative(), operatorCents: Cents.nonnegative() }).refine((caps) => caps.agentCents <= caps.operatorCents, {
  message: "the agent cap cannot exceed the operator cap",
});
export type CapLimits = z.infer<typeof CapLimits>;

export const WorldCaps = z.object({
  perAction: z.record(CapAction, CapLimits),
  /** Automatic reversals or refunds per customer in 30 days before an operator must approve. */
  autoActionsPer30Days: z.number().int().nonnegative(),
});
export type WorldCaps = z.infer<typeof WorldCaps>;

export const SettlementDelay = z.object({ businessDays: z.number().int().min(0).max(10), publishAt: ClockTime, cutoff: ClockTime });

export const ManualBaselineItem = z.object({ action: z.string().min(1).max(80), minutes: z.number().nonnegative(), label: z.literal("supuesto") });

/** `SETTINGS` of a world: every parameter the code decides with, configurable per world. */
export const WorldSettings = z.object({
  worldId: WorldId,
  caps: WorldCaps,
  contactHours: z.object({ weekday: TimeRange, saturday: TimeRange.nullable(), formalNotice: TimeRange }),
  maxProactivePerDay: z.number().int().nonnegative(),
  settlementDelays: z.partialRecord(z.enum(["NORTE", "SUR"]), SettlementDelay),
  turnCaps: z.object({ perHour: z.number().int().positive(), perDay: z.number().int().positive() }),
  imageReadsPerDay: z.number().int().nonnegative(),
  rateLimitPerHour: z.number().int().positive(),
  /** Email is always live (outbound only); WhatsApp is `simulated` unless this world may run live (ADR-0002). */
  channelModes: z.object({ whatsapp: ChannelMode }),
  manualBaseline: z.object({ items: z.array(ManualBaselineItem).max(50) }),
  /** Synthetic reference rate for compensatory interest, always labelled an assumption. */
  referenceRate: z.object({ annualRate: z.number().nonnegative(), label: z.string().min(1).max(120) }),
  /** Cost-per-complaint threshold set by the CTO (USD). */
  costPerComplaintThresholdUsd: z.number().positive().optional(),
  /** QA worlds of the classifier eval: stop after intake. */
  intakeOnly: z.boolean().optional(),
  ...Versioned,
});
export type WorldSettings = z.infer<typeof WorldSettings>;

/** A console user of a world (`STAFF#<staffId>`), bound to one Cognito `sub`. */
export const Staff = z.object({
  worldId: WorldId,
  staffId: StaffId,
  role: StaffRole,
  displayName: z.string().min(1).max(120),
  /** `SUB#<cognito sub>` (index `BySub`). */
  cognitoSubKey: z.string().regex(/^SUB#[A-Za-z0-9-]{1,128}$/),
  /** An inactive row stops a still-valid token at the next request (auth/staff.ts). */
  active: z.boolean().default(true),
  ...Versioned,
});
export type Staff = z.infer<typeof Staff>;
