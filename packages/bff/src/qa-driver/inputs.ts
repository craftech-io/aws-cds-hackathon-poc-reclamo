// The input of every `QaDriver` action (docs/tool-catalog.md "Acciones del QaDriver"), with zod `.strict()`:
// an unknown key is INVALID before the guard reads anything. Ids the driver writes into keys are
// validated with the same schemas the connector uses; the world an action touches is named here and
// fenced by guard.ts, never taken from a stored row the input points at.
import { z } from "zod";
import { CalendarDate, CollectionNetwork, TransitionRequest } from "@reclamo/core-contract";
import { CustomerId, IsoInstant, MessageKind, StaffRole, TimerKind, WaButtonAction, WorldId } from "@reclamo/shared";
import { Epoch, Id } from "../domain/common";
import { Locale, Referrer, SignupId, Utm } from "../guests/schemas";
import { TimerKey } from "../timers/events";
import { RunId, ScenarioSlug, type QaActionName } from "./contract";

/** A persona of a QA world: `key` of a clone (`a`, `b01`) or a model persona of `qamin` (`C01`). */
export const PersonaKey = z.string().regex(/^(?:[a-z][a-z0-9]{0,7}|C\d{2})$/, "expected a clone key or Cnn");
export const ModelPersona = z.string().regex(/^C(0[1-9]|[1-3]\d|4[01])$/, "expected C01…C41");
/** `su1`…: the only key of a self-signup of the runner (docs/tool-catalog.md `guest.signup`). */
export const SignupKey = z.string().regex(/^su\d{1,3}$/, "expected su<n>");

const World = { worldId: WorldId };
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** World settings a scenario may set (docs/tool-catalog.md `world.create`); the rest stays the template's. */
export const WorldSettingsOverride = z
  .object({
    caps: z.record(z.string(), z.unknown()).optional(),
    contactHours: z.record(z.string(), z.unknown()).optional(),
    rateLimitPerHour: z.number().int().positive().max(10_000).optional(),
    settlementDelays: z.record(z.string(), z.unknown()).optional(),
    turnCaps: z.object({ perHour: z.number().int().positive(), perDay: z.number().int().positive() }).strict().optional(),
    imageReadsPerDay: z.number().int().nonnegative().optional(),
    channelModes: z.object({ whatsapp: z.enum(["simulated", "live"]) }).strict().optional(),
    intakeOnly: z.boolean().optional(),
  })
  .strict();
export type WorldSettingsOverride = z.infer<typeof WorldSettingsOverride>;

export const PersonaRequest = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9]{0,7}$/, "expected a lower-case key"),
    model: ModelPersona,
    /** The SES mailbox simulator's other outcomes for this customer's email. */
    emailOverride: z.enum(["bounce", "complaint"]).optional(),
  })
  .strict();
export type PersonaRequest = z.infer<typeof PersonaRequest>;

/** Money actions counted by the monthly limit (complaints/caps.ts `REVERSAL_ACTIONS`). */
export const HistoryAction = z.enum(["REVERSE_CHARGE", "REFUND_DUPLICATE", "TRANSFER_REVERSAL"]);

/**
 * An earlier action of a cloned persona (FL-040): a closed complaint of the persona with that action
 * executed by the agent on its own `daysAgo` simulated days before the world's start.
 */
export const HistoryEntry = z
  .object({
    persona: z.string().regex(/^[a-z][a-z0-9]{0,7}$/, "expected the clone key of a requested persona"),
    action: HistoryAction,
    amountCents: z.number().int().positive().max(10_000_000),
    daysAgo: z.number().int().min(1).max(29),
  })
  .strict();
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** An eval image of the `Seed` bucket (`receipts/<variant>/<name>.png`), addressed by its key. */
export const SeedReceiptFile = z.string().regex(/^receipts\/[a-z-]{1,40}\/[a-z0-9-]{1,60}\.png$/, "expected receipts/<variant>/<name>.png");

const WaContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(1_000) }).strict(),
  /** A tap on the last outbound message that offers `action` (its nonce is resolved on the server). */
  z.object({ type: z.literal("button"), action: WaButtonAction }).strict(),
  z.object({ type: z.literal("receipt"), variant: z.string().regex(/^[a-z-]{1,40}$/), personaModel: ModelPersona, seq: z.number().int().min(1).max(9).default(1), caption: z.string().min(1).max(200).optional() }).strict(),
  /** An eval image of the seed (a tampered or blurry variant no persona owns), by its `Seed` key. */
  z.object({ type: z.literal("seedFile"), file: SeedReceiptFile, caption: z.string().min(1).max(200).optional() }).strict(),
  /** A document (PDF): the adapter answers with its fixed reply and never downloads it (FL-029). */
  z.object({ type: z.literal("document"), mimeType: z.literal("application/pdf").default("application/pdf") }).strict(),
  /** Variants built on the server: no invocation payload carries more than 1 MB of bytes. */
  z.object({ type: z.literal("serverImage"), variant: z.enum(["oversize-4.5mb", "oversize-7mb", "bad-magic"]) }).strict(),
]);
export type WaContent = z.infer<typeof WaContent>;

const ConsoleInput = z
  .object({
    worldId: WorldId,
    /** `router.procedure` of the appRouter (`clock.advance`, `approvals.decide`…). */
    procedure: z.string().regex(/^[a-z][A-Za-z]{1,30}\.[a-z][A-Za-z]{1,40}$/),
    role: StaffRole,
    input: z.unknown().optional(),
    /** Epoch seconds of the simulated sign-in (an old one tests the recent-login gate). */
    authTime: z.number().int().positive().optional(),
  })
  .strict();

const NetworkFault = z.record(z.string(), z.unknown());

export const ACTION_INPUTS = {
  "world.create": z
    .object({
      runId: RunId,
      scenario: ScenarioSlug,
      template: z.enum(["models", "guest"]).default("models"),
      personas: z.array(PersonaRequest).max(12).default([]),
      settings: WorldSettingsOverride.optional(),
      /** Earlier money actions of the requested personas (docs/tool-catalog.md `world.create`, FL-040). */
      history: z.array(HistoryEntry).max(6).default([]),
      /** `qa-live-<runId>` (SC-23 only): the one QA world that may run WhatsApp live. */
      live: z.boolean().optional(),
    })
    .strict(),
  "world.destroy": z.object(World).strict(),
  "auth.session": z
    .object({ ...World, sessionKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), role: StaffRole, flow: z.enum(["ADMIN", "SRP"]).default("ADMIN"), probeCognito: z.boolean().optional() })
    .strict(),
  /** `registerOnly`: the account and the pre-registration only, the world left `REGISTERED` (SC-22/8). */
  "guest.invite": z.object({ ...World, registerOnly: z.boolean().optional() }).strict(),
  /** `utm`/`referrer`: the campaign of the visit, as the public form carries it (guests/schemas.ts). */
  "guest.signup": z.object({ runId: RunId, key: SignupKey, locale: Locale, acceptContact: z.boolean().default(false), utm: Utm.optional(), referrer: Referrer.optional() }).strict(),
  "guest.confirm": z.object({ runId: RunId, key: SignupKey, signupId: SignupId, code: z.string().regex(/^\d{6}$/).optional() }).strict(),
  "guest.resend": z.object({ runId: RunId, key: SignupKey, signupId: SignupId }).strict(),
  "guest.session": z.object({ runId: RunId, key: SignupKey }).strict(),
  "guest.lead": z.object({ runId: RunId, key: SignupKey }).strict(),
  "guest.expireNow": z.object(World).strict(),
  "probe.edge": z.object({}).strict(),
  /** The run comes from the idempotency key; nothing in the input names an address. */
  "notice.probe": z.object({}).strict(),
  "wa.inbound": z
    .object({
      ...World,
      persona: PersonaKey,
      content: WaContent,
      /** The `wamid` an earlier `wa.inbound` answered: the same message id again, as an SNS redelivery carries it. */
      redeliveryOf: z.string().regex(/^wamid\.SIM\.[0-9a-f]{64}$/, "expected the wamid of an earlier wa.inbound").optional(),
    })
    .strict(),
  "clock.advance": z.object({ ...World, minutes: z.number().int().min(1).max(20 * 24 * 60) }).strict(),
  "clock.advanceTo": z.object({ ...World, to: IsoInstant }).strict(),
  "clock.advanceToNext": z.object({ ...World, complaintId: Id.optional() }).strict(),
  "clock.advanceBusinessDay": z.object(World).strict(),
  "clock.fireNow": z.object({ ...World, kind: TimerKind, timerId: Id }).strict(),
  "clock.unfreeze": z.object({ ...World, timerKey: TimerKey, leadSec: z.number().int().min(10).max(3_600).default(120), rate: z.number().int().min(1).max(86_400).default(1) }).strict(),
  "clock.freeze": z.object(World).strict(),
  "conv.settleProbe": z.object({ ...World, customerId: CustomerId.optional() }).strict(),
  "network.publish": z.object({ ...World, network: CollectionNetwork, businessDate: CalendarDate }).strict(),
  "network.setDelay": z.object({ ...World, network: CollectionNetwork, businessDays: z.number().int().min(0).max(10), publishAt: Clock, cutoff: Clock }).strict(),
  "network.setFault": z.object({ ...World, faults: z.array(NetworkFault).max(20) }).strict(),
  "network.transition": z.object({ ...World, transferId: Id, transition: TransitionRequest }).strict(),
  "receipt.forceFallback": z.object({ ...World, on: z.boolean() }).strict(),
  "receipt.readProbe": z.union([
    z.object({ ...World, variant: z.string().regex(/^[a-z-]{1,40}$/), personaModel: ModelPersona, seq: z.number().int().min(1).max(9).default(1), forceFallback: z.boolean().optional() }).strict(),
    /** An eval image no persona owns (`receipts/<variant>/ev-….png`), by its `Seed` key. */
    z.object({ ...World, variant: z.string().regex(/^[a-z-]{1,40}$/), file: SeedReceiptFile, forceFallback: z.boolean().optional() }).strict(),
  ]),
  "schedule.fireStale": z.object({ ...World, timerKey: TimerKey, version: z.number().int().positive(), epoch: Epoch }).strict(),
  console: ConsoleInput,
  "mail.outcome": z.object({ ...World, mailId: Id }).strict(),
  "register.tamperProbe": z.object({ ...World, overwriteSeq: z.number().int().min(1), rechainSeq: z.number().int().min(1) }).strict(),
  "fence.probe": z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("RECIPIENT"), ...World, channel: z.enum(["EMAIL", "WHATSAPP"]), address: z.string().min(3).max(254) }).strict(),
    z.object({ kind: z.literal("WORLD_PATHS"), worldId: z.literal("gprobe") }).strict(),
  ]),
  "gate.probe": z
    .object({
      ...World,
      customerId: CustomerId,
      kind: MessageKind,
      text: z.string().min(1).max(2_000),
      channel: z.enum(["WHATSAPP", "EMAIL"]).default("WHATSAPP"),
      turnResults: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
      bypassLexicon: z.boolean().optional(),
    })
    .strict(),
  "guardrail.probe": z.object({ text: z.string().min(1).max(2_000).optional() }).strict(),
  "caps.prime": z
    .object({
      worldId: WorldId.optional(),
      bucket: z.enum(["TURNCAP", "RATE", "GLOBALCAP_QA", "SIGNUP_QA", "GUESTCAP_QA"]),
      value: z.number().int().nonnegative().max(100_000),
      window: z.enum(["HOUR", "DAY"]).default("DAY"),
      persona: PersonaKey.optional(),
    })
    .strict(),
  "kill.setWorld": z.object({ ...World, on: z.boolean() }).strict(),
  "turn.forceFailure": z.object({ ...World, customerId: CustomerId }).strict(),
  "turn.forceSilence": z.object({ ...World, customerId: CustomerId, mode: z.enum(["NO_OUTBOUND", "SKIP_ANSWER"]) }).strict(),
  "event.inject": z.object({ ...World, type: z.literal("APPROVAL_DECIDED"), customerId: CustomerId, complaintId: Id, approvalId: Id }).strict(),
  "event.poison": z.object({ ...World, customerId: CustomerId }).strict(),
  "dlq.find": z.object({ eventId: Id }).strict(),
  "dlq.delete": z.object({ eventId: Id }).strict(),
  "alarm.history": z.object({}).strict(),
  "probe.mocks": z.object({ ...World, customerId: CustomerId }).strict(),
  "probe.malwarePlan": z.object({}).strict(),
  "memory.inspect": z.object({ ...World, customerId: CustomerId, epoch: Epoch.optional(), sentinel: z.string().min(4).max(120).optional() }).strict(),
  snapshot: z.object({ ...World, customerId: CustomerId.optional() }).strict(),
  "turn.inspect": z.object({ ...World, customerId: CustomerId }).strict(),
  "intake.inspect": z.object({ ...World, customerId: CustomerId }).strict(),
  "probe.cognitoClients": z.object(World).strict(),
  "policyAudit.run": z.object(World).strict(),
  "metrics.get": z.object({ ...World, tab: z.enum(["WORLD", "BATCH", "SIMULATED_LOAD"]).default("WORLD") }).strict(),
  "batch.run": z.object({ runId: RunId, batchId: z.string().regex(/^[a-z0-9]{1,10}$/) }).strict(),
} as const satisfies Record<QaActionName, z.ZodType>;

export type QaInput<A extends QaActionName> = z.output<(typeof ACTION_INPUTS)[A]>;
