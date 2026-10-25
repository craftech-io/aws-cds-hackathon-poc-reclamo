// The moves the scenarios of SC-01 to SC-11 repeat (docs/test-plan.md §4.3, §4.5): a persona writes its
// script message, the number comes back on the spot, the autopilot plays the customer until the
// complaint reaches a state, a mail gets its delivery proof. Every wait is a probe with its cap; every
// negative is asserted on what was read with the world quiet. The model's wording is never asserted:
// states, the register, the tape, tool calls and the delivery proof are.
import { isCollection } from "@reclamo/bff/channel-policy/collection-lexicon";
import type { ComplaintStatus, ComplaintType, MessageKind } from "@reclamo/shared";
import { type AutopilotPlan, type AutopilotProgress, drive, newProgress } from "./autopilot";
import { WAITS } from "./eventually";
import { scriptMessage, scriptReceipt } from "./personas";
import { COMPLAINT_NUMBER, type Complaint, type Snapshot, SENT, complaintById, latestComplaint, messages } from "./snapshot";
import { type QaInput, type ScenarioContext, ensure } from "./steps";
import { type CreatedWorld, customerOf } from "./world";

type WaContent = QaInput<"wa.inbound">["content"];

export interface Persona {
  readonly worldId: string;
  readonly key: string;
  readonly model: string;
  readonly customerId: string;
}

export function personaIn(ctx: ScenarioContext, world: CreatedWorld, key: string): Persona {
  const model = world.models[key];
  ensure(model !== undefined, `${world.worldId} has no persona ${key}`);
  return { worldId: world.worldId, key, model, customerId: customerOf(ctx, key, worldSuffix(ctx, world)) };
}

function worldSuffix(ctx: ScenarioContext, world: CreatedWorld): string {
  const base = `qa-${ctx.runId}-${ctx.scenario.slug}`;
  return world.worldId === base ? "main" : world.worldId.slice(base.length + 1);
}

export async function say(ctx: ScenarioContext, persona: Persona, content: WaContent): Promise<{ readonly accepted: boolean; readonly reason: string | null; readonly outcomes: readonly string[] }> {
  return (await ctx.qa("wa.inbound", { worldId: persona.worldId, persona: persona.key, content })) as { accepted: boolean; reason: string | null; outcomes: string[] };
}

/** Message `index` of the persona's script, as text. */
export const sayScript = (ctx: ScenarioContext, persona: Persona, index = 0) => say(ctx, persona, { type: "text", text: scriptMessage(persona.model, index).text });

/** The receipt of the persona's script message `index` (a seed image), or a given variant. */
export async function sendReceipt(ctx: ScenarioContext, persona: Persona, index = 0, override?: { readonly variant: string; readonly seq?: number }): Promise<void> {
  const receipt = override === undefined ? scriptReceipt(persona.model, index) : { type: "receipt" as const, variant: override.variant, personaModel: persona.model, seq: override.seq ?? 1 };
  ensure(receipt !== undefined, `${persona.model}'s script message ${index} has no receipt`);
  await say(ctx, persona, receipt);
}

export interface Acknowledged {
  readonly snapshot: Snapshot;
  readonly complaint: Complaint;
  readonly ackLatencyMs: number;
}

/**
 * The number on the spot (FL-010): a `COMPLAINT_ACK` that left within 10 s of the message, with a new
 * complaint `R-AAAA-NNNNNN`. `before` is the complaint count before the message, so a follow-up never
 * passes for a new number.
 */
export async function expectAck(ctx: ScenarioContext, persona: Persona, sentAt: number, before: number, type?: ComplaintType): Promise<Acknowledged> {
  const snapshot = await ctx.eventually(
    `${persona.key}: COMPLAINT_ACK`,
    async () => {
      const fresh = await ctx.snapshot(persona.worldId, persona.customerId);
      const acks = messages(fresh, { direction: "OUT", kind: "COMPLAINT_ACK", status: SENT });
      return fresh.complaints.length > before && acks.length > 0 ? fresh : undefined;
    },
    WAITS.ackSec + 5,
    1,
  );
  const ackLatencyMs = ctx.now() - sentAt;
  ctx.measure("ackLatencyMs", ackLatencyMs);
  ctx.check(ackLatencyMs <= WAITS.ackSec * 1_000 + 2_000, `the number took ${ackLatencyMs} ms (hard cap 10 s per message, plus the probe's period)`);
  const view = latestComplaint(snapshot, type);
  ensure(view !== undefined, `no ${type ?? ""} complaint after the acknowledgement`);
  ctx.check(COMPLAINT_NUMBER.test(view.complaint.complaintNumber), `${view.complaint.complaintNumber} is not R-AAAA-NNNNNN`);
  ctx.note(`complaint-${persona.key}`, view.complaint.complaintNumber);
  return { snapshot, complaint: view.complaint, ackLatencyMs };
}

/** Writes the script message and waits for its number. */
export async function fileByScript(ctx: ScenarioContext, persona: Persona, index = 0, type?: ComplaintType): Promise<Acknowledged> {
  const before = (await ctx.snapshot(persona.worldId, persona.customerId)).complaints.length;
  const sentAt = ctx.now();
  await sayScript(ctx, persona, index);
  return expectAck(ctx, persona, sentAt, before, type);
}

export interface AwaitOptions {
  readonly plan?: Omit<AutopilotPlan, "persona" | "model">;
  readonly progress?: AutopilotProgress;
  readonly timeoutSec?: number;
}

/** Plays the customer (autopilot) until the complaint is in one of `statuses`. */
export async function untilStatus(ctx: ScenarioContext, persona: Persona, complaintId: string, statuses: readonly ComplaintStatus[], options: AwaitOptions = {}): Promise<Snapshot> {
  return drive(ctx, {
    worldId: persona.worldId,
    customerId: persona.customerId,
    plan: { persona: persona.key, model: persona.model, ...options.plan },
    progress: options.progress ?? newProgress(),
    until: (snapshot) => statuses.includes(complaintById(snapshot, complaintId)?.complaint.status ?? "REGISTERED"),
    what: `${complaintId} ${statuses.join("|")}`,
    timeoutSec: options.timeoutSec ?? WAITS.turnSec,
  });
}

/** Plays the customer until `holds` is true on the snapshot. */
export function until(ctx: ScenarioContext, persona: Persona, what: string, holds: (snapshot: Snapshot) => boolean, options: AwaitOptions = {}): Promise<Snapshot> {
  return drive(ctx, {
    worldId: persona.worldId,
    customerId: persona.customerId,
    plan: { persona: persona.key, model: persona.model, ...options.plan },
    progress: options.progress ?? newProgress(),
    until: holds,
    what,
    timeoutSec: options.timeoutSec ?? WAITS.turnSec,
  });
}

export function viewOf(snapshot: Snapshot, complaintId: string) {
  const view = complaintById(snapshot, complaintId);
  ensure(view !== undefined, `${complaintId} is not in the snapshot`);
  return view;
}

/** An outbound message of `kind` that left (`SENT` or later). */
export const sentKind = (snapshot: Snapshot, kind: MessageKind | readonly MessageKind[], channel?: "WHATSAPP" | "EMAIL") =>
  messages(snapshot, { direction: "OUT", kind, status: SENT, ...(channel ? { channel } : {}) });

/** The delivery proof of a mail from the SES mailbox simulator (`DELIVERED`, `BOUNCED`, `COMPLAINED`). */
export async function mailOutcome(ctx: ScenarioContext, worldId: string, mailId: string, expected: readonly string[] = ["DELIVERED"]): Promise<string> {
  const outcome = await ctx.eventually(
    `mail ${mailId} ${expected.join("|")}`,
    async () => {
      const answer = (await ctx.qa("mail.outcome", { worldId, mailId })) as { status: string };
      return expected.includes(answer.status) || ["BOUNCED", "COMPLAINED"].includes(answer.status) ? answer.status : undefined;
    },
    WAITS.sesEventSec,
    5,
  );
  ctx.check(expected.includes(outcome), `mail ${mailId} ended ${outcome}, expected ${expected.join(" or ")}`);
  return outcome;
}

/** Mails of the snapshot of one kind (`ACK_EMAIL`, `FORMAL_ANSWER`…), newest last. */
export const mailsOf = (snapshot: Snapshot, kind: string, customerId?: string) => snapshot.emails.filter((mail) => mail.kind === kind && (customerId === undefined || mail.customerId === customerId));

/**
 * The negatives every WhatsApp conversation keeps (docs/test-plan.md §4.3): no outbound WhatsApp with the
 * collection lexicon, and none without its `ALLOWED` on the tape. On a snapshot read with the world quiet.
 */
export function noCollectionOnWhatsApp(ctx: ScenarioContext, snapshot: Snapshot): void {
  const outbound = messages(snapshot, { direction: "OUT", channel: "WHATSAPP" }).filter((message) => message.status !== "BLOCKED");
  ctx.none(snapshot, "outbound WhatsApp messages with collection language", outbound.filter((message) => isCollection(message.body)));
}

/** Two complaint numbers of the same world are consecutive. */
export function consecutive(first: string, second: string): boolean {
  const seq = (number: string) => Number(number.slice(-6));
  return first.slice(0, 7) === second.slice(0, 7) && seq(second) === seq(first) + 1;
}

/** The script message (and its receipt, if it has one) and its number: what "Mandar mensaje del guion" does. */
export async function fileWithReceipt(ctx: ScenarioContext, persona: Persona, index = 0, type?: ComplaintType): Promise<Acknowledged> {
  const filed = await fileByScript(ctx, persona, index, type);
  if (scriptReceipt(persona.model, index) !== undefined) await sendReceipt(ctx, persona, index);
  return filed;
}

/** The complaint id a step left in the scenario's state under `name`. */
export function complaintIdOf(ctx: ScenarioContext, name: string): string {
  const id = ctx.state[`complaint:${name}`];
  ensure(typeof id === "string", `no complaint "${name}" filed by an earlier step`);
  return id;
}

export function keepComplaint(ctx: ScenarioContext, name: string, filed: Acknowledged): string {
  ctx.state[`complaint:${name}`] = filed.complaint.complaintId;
  return filed.complaint.complaintId;
}

/** The autopilot's progress of one persona, kept across the steps of a scenario. */
export function progressOf(ctx: ScenarioContext, key: string): AutopilotProgress {
  return (ctx.state[`autopilot:${key}`] ??= newProgress()) as AutopilotProgress;
}
