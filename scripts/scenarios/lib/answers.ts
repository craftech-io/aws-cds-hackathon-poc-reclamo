// The written answer and what proves it (docs/test-plan.md §4.3 "Email", "Registro", "Timers"): the
// complaint `ANSWERED` (by the agent's turn or by the `ANSWER_DUE` obligation that followed it), the
// `FORMAL_ANSWER` mail with the attachments the code decides, its delivery proof from the SES mailbox
// simulator, the register entries in order and the three milestones `CANCELLED`.
import type { ComplaintStatus } from "@reclamo/shared";
import type { AutopilotProgress } from "./autopilot";
import { type CaseView, type Timeline, caseOf, itemsOf, timelineOf } from "./console";
import { WAITS } from "./eventually";
import { type Persona, mailOutcome, untilStatus } from "./flows";
import { turnErrors } from "./preflight";
import type { ScenarioContext } from "./steps";

export const MILESTONES = ["OPERATOR_REMINDER", "SUPERVISOR_ESCALATION", "DEADLINE"] as const;

export interface AnswerExpectation {
  /** Attachments besides the answer itself (`STATEMENT`, `PAYOFF_CERTIFICATE`, `CREDIT_NOTE`). */
  readonly attachments?: readonly string[];
  /** Attachments that must NOT be there (FL-031: no payoff certificate with a balance left). */
  readonly without?: readonly string[];
  readonly delivery?: readonly string[];
  readonly progress?: AutopilotProgress;
}

export interface Answered {
  readonly view: CaseView;
  readonly timeline: Timeline;
}

/** `ANSWERED`, its mail with the expected attachments and its delivery proof (docs/architecture-integrations.md §2). */
export async function expectWrittenAnswer(ctx: ScenarioContext, persona: Persona, complaintId: string, expectation: AnswerExpectation = {}): Promise<Answered> {
  const answered: readonly ComplaintStatus[] = ["ANSWERED", "CLOSED"];
  await untilStatus(ctx, persona, complaintId, answered, { timeoutSec: WAITS.turnSec * 2, ...(expectation.progress ? { progress: expectation.progress } : {}) });
  const view = await caseOf(ctx, persona.worldId, complaintId);
  const mailId = view.complaint.answer?.mailId;
  ctx.check(mailId !== undefined, `${view.complaint.complaintNumber} is ANSWERED without a mail`);
  if (mailId === undefined) return { view, timeline: await timelineOf(ctx, persona.worldId, complaintId) };
  ctx.note("answerMailId", mailId);
  const timeline = await timelineOf(ctx, persona.worldId, complaintId);
  const mail = itemsOf(timeline, "EMAIL").find((item) => item.mailId === mailId);
  ctx.check(mail !== undefined, `the answer's mail ${mailId} is not in the timeline`);
  const kinds = new Set(mail?.attachments.map((attachment) => attachment.docKind) ?? []);
  for (const expected of ["ANSWER", ...(expectation.attachments ?? [])]) ctx.check(kinds.has(expected), `the answer of ${view.complaint.complaintNumber} has no ${expected} (it has ${[...kinds].join(", ")})`);
  for (const absent of expectation.without ?? []) ctx.check(!kinds.has(absent), `the answer of ${view.complaint.complaintNumber} carries ${absent}`);
  await mailOutcome(ctx, persona.worldId, mailId, expectation.delivery ?? ["DELIVERED"]);
  return { view, timeline };
}

/** The proof lands on the complaint and on the register (`DELIVERY_PROOF`) once the SES event came back. */
export async function expectDeliveryProof(ctx: ScenarioContext, persona: Persona, complaintId: string): Promise<Timeline> {
  return ctx.eventually(
    `${complaintId} DELIVERY_PROOF`,
    async () => {
      const timeline = await timelineOf(ctx, persona.worldId, complaintId);
      return itemsOf(timeline, "REGISTER").some((entry) => entry.eventType === "DELIVERY_PROOF") ? timeline : undefined;
    },
    WAITS.sesEventSec,
    5,
  );
}

/** Register entries of the complaint with consecutive `seq` and the expected event types in order. */
export function expectRegister(ctx: ScenarioContext, timeline: Timeline, expected: readonly string[]): void {
  const entries = itemsOf(timeline, "REGISTER").sort((a, b) => a.seq - b.seq);
  const types: string[] = entries.map((entry) => entry.eventType);
  let at = 0;
  for (const type of expected) {
    const found = types.indexOf(type, at);
    ctx.check(found >= 0, `register of ${timeline.complaintNumber}: no ${type} after position ${at} (${types.join(", ")})`);
    at = found + 1;
  }
  const seqs = entries.map((entry) => entry.seq);
  // The register is one chain for the whole world: a complaint's own entries keep their global order.
  ctx.check(seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? 0)), `register of ${timeline.complaintNumber} out of order: ${seqs.join(", ")}`);
}

/** The three milestones of the complaint in one status (`SCHEDULED` at filing, `CANCELLED` once answered). */
export function expectMilestones(ctx: ScenarioContext, timeline: Timeline, status: "SCHEDULED" | "CANCELLED"): void {
  const milestones = itemsOf(timeline, "MILESTONE").filter((item) => item.kind === "SLA");
  for (const milestone of MILESTONES) {
    const item = milestones.find((candidate) => candidate.milestone === milestone);
    ctx.check(item?.status === status, `${timeline.complaintNumber}: ${milestone} is ${item?.status ?? "missing"}, expected ${status}`);
  }
}

/** No turn ended at `max_tokens` since `sinceMs` (§7); unreadable metrics are a warning, never a pass in silence. */
export async function expectNoMaxTokens(ctx: ScenarioContext, sinceMs: number): Promise<void> {
  try {
    const stops = await turnErrors("max_tokens", sinceMs);
    ctx.check(stops === 0, `${stops} turn(s) stopped at max_tokens`);
  } catch (error) {
    if (error instanceof Error && error.name === "AssertionFailed") throw error;
    ctx.warn(`ReclamoAgent/TurnErrors could not be read: ${error instanceof Error ? error.name : "error"}`);
  }
}
