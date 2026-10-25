// The customer's side of an agent conversation in the local demo world, as the scenarios' autopilot plays
// it on the stage (scripts/scenarios/lib/autopilot.ts): it writes, taps the buttons the messages offer,
// sends the seed receipts and answers the identity challenge with the persona's truth when the agent asks
// it. It never decides for the agent: when the agent did not ask, the customer does not answer.
import type { WaButtonAction } from "@reclamo/shared";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import type { Message } from "@reclamo/bff/domain/conversation";
import { TEST_NOW } from "@reclamo/bff/connector/testing";
import { parseEnvelope } from "../../flows/support/scripted-harness";
import type { AgentWorld } from "./agent-world";

export const WORLD = "demo";
/** What a customer writes to have a filed complaint looked at again (the flows' `REVIEW`). */
export const REVIEW = "¿Lo pueden revisar?";
/** The world's local date while its clock is paused at the seed's start (Wed 07/10/2026 10:10). */
const TODAY = "2026-10-07";

/** A persona and the complaint its conversation filed. */
export interface Customer {
  readonly customerId: string;
  readonly complaint: Complaint;
}

/** Written after the seed: the messages of this conversation, never the seeded history. */
const fresh = (message: Message): boolean => (message.createdAt ?? "") > TEST_NOW.toISOString();

export async function messagesOf(world: AgentWorld, customerId: string): Promise<Message[]> {
  const messages = (await world.flow.connector.conversations.listMessages(WORLD, customerId)).filter(fresh);
  return messages.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.messageId.localeCompare(b.messageId));
}

/** Outbound messages of this conversation, every sender, every status (BLOCKED ones included). */
export async function outboundOf(world: AgentWorld, customerId: string): Promise<Message[]> {
  return (await messagesOf(world, customerId)).filter((message) => message.direction === "OUT");
}

/** The agent's outbound messages that reached the customer (or are on their way): not blocked by the gate. */
export async function agentSentOf(world: AgentWorld, customerId: string): Promise<Message[]> {
  return (await outboundOf(world, customerId)).filter((message) => message.sender === "AGENT" && message.status !== "BLOCKED");
}

/** The complaints the conversation filed (`origin LIVE`), oldest number first. */
export async function liveComplaints(world: AgentWorld, customerId: string): Promise<Complaint[]> {
  return (await world.flow.connector.complaints.listByCustomer(WORLD, customerId)).filter((complaint) => complaint.origin === "LIVE").sort((a, b) => a.complaintNumber.localeCompare(b.complaintNumber));
}

export async function current(world: AgentWorld, complaint: Pick<Complaint, "complaintId">): Promise<Complaint | undefined> {
  return world.flow.connector.complaints.get(WORLD, complaint.complaintId);
}

export async function isIdentified(world: AgentWorld, customerId: string): Promise<boolean> {
  const until = (await world.flow.connector.conversations.getMeta(WORLD, customerId))?.identifiedUntilReal;
  return until !== undefined && Date.parse(until) > world.flow.realNow().getTime();
}

export const say = (world: AgentWorld, customerId: string, text: string) => world.flow.phone(customerId, { type: "text", text });

/** Taps `action` on the last message that offers it; `false` when none does (the agent offered nothing). */
export async function tapIfOffered(world: AgentWorld, customerId: string, action: WaButtonAction): Promise<boolean> {
  const offered = (await outboundOf(world, customerId)).some((message) => JSON.stringify(message.interactive ?? {}).includes(`"${action}"`));
  if (!offered) return false;
  await world.flow.tap(customerId, action);
  return true;
}

/** The challenge the last turn's preloaded `identify_customer` named (`LAST_DUE_DATE` when it named none). */
function challengeKind(world: AgentWorld): string {
  for (const turn of [...world.agent.turns].reverse()) {
    const identify = parseEnvelope(turn.userText).preloaded.identify_customer as { challenge?: { kind?: string } } | undefined;
    if (identify?.challenge?.kind !== undefined) return identify.challenge.kind;
  }
  return "LAST_DUE_DATE";
}

/** The persona's true answer, from the core's rows (what the customer knows about their own account). */
export function challengeAnswer(world: AgentWorld, customerId: string, kind: string = challengeKind(world)): string {
  const rows = world.flow.mocks.coreStore.dump().filter((item) => item.pk === `W#${WORLD}#CUS#${customerId}`);
  if (kind === "LAST_MOVEMENT_AMOUNT") {
    const movements = rows.filter((item) => item.entity === "Movement" && String(item.atSim).slice(0, 10) <= TODAY).sort((a, b) => Date.parse(String(a.atSim)) - Date.parse(String(b.atSim)));
    return String(Number(movements.at(-1)?.amount) / 100);
  }
  const due = rows.filter((item) => item.entity === "Instalment" && String(item.dueDate) <= TODAY).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const last = due.at(-1);
  if (last === undefined) throw new Error(`${customerId} has no instalment due`);
  if (kind === "LAST_INSTALMENT_AMOUNT") return String(Number(last.amount) / 100);
  const [, month, day] = String(last.dueDate).split("-");
  return `${Number(day)}/${Number(month)}`;
}

/**
 * Answers the identity challenge while the agent keeps asking it, at most twice (a third is never asked):
 * `answer` is the persona's truth unless the test plays a customer who does not know it.
 */
export async function answerChallenges(world: AgentWorld, customerId: string, answer: () => string = () => challengeAnswer(world, customerId)): Promise<boolean> {
  let answered = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await isIdentified(world, customerId)) return true;
    const asked = (await outboundOf(world, customerId)).filter((message) => message.kind === "IDENTITY_CHALLENGE" && message.status !== "BLOCKED").length;
    if (asked <= answered) return false;
    answered = asked;
    await say(world, customerId, answer());
  }
  return isIdentified(world, customerId);
}

/** The complaint text, then the email accepted when the acknowledgement offers it, then the challenge. */
export async function complain(world: AgentWorld, customerId: string, text: string, options: { readonly acceptEmail?: boolean } = {}): Promise<Complaint | undefined> {
  await say(world, customerId, text);
  if (options.acceptEmail !== false) await tapIfOffered(world, customerId, "ACCEPT_EMAIL");
  await answerChallenges(world, customerId);
  return (await liveComplaints(world, customerId))[0];
}

/**
 * The customer asks again (`REVIEW`) while `done` does not hold, at most `times` times, answering the
 * challenge whenever the agent asks it: what a customer does when the agent stops before the end.
 */
export async function pursue(world: AgentWorld, customerId: string, done: () => Promise<boolean>, times = 2): Promise<boolean> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    if (await done()) return true;
    await say(world, customerId, REVIEW);
    await answerChallenges(world, customerId);
  }
  return done();
}

/** `pursue` until the complaint reaches one of `statuses`. */
export function pursueStatus(world: AgentWorld, customerId: string, complaint: Pick<Complaint, "complaintId">, statuses: readonly string[], times = 2): Promise<boolean> {
  return pursue(world, customerId, async () => statuses.includes((await current(world, complaint))?.status ?? ""), times);
}

/** A core row of the persona (`Wallet`, `Account`, `Customer`…). */
export function coreRow(world: AgentWorld, customerId: string, entity: string, where: (item: Record<string, unknown>) => boolean = () => true): Record<string, unknown> | undefined {
  return world.flow.mocks.coreStore.dump().find((item) => item.pk === `W#${WORLD}#CUS#${customerId}` && item.entity === entity && where(item));
}

export const walletOf = (world: AgentWorld, customerId: string): number => Number(coreRow(world, customerId, "Wallet")?.balance);

/** Every case action of the complaint (`APPLY_PAYMENT`, `REVERSE_CHARGE`…), whatever its status. */
export async function actionsOf(world: AgentWorld, complaint: Pick<Complaint, "complaintId">) {
  return world.flow.connector.caseItems.listActions(WORLD, complaint.complaintId);
}

/** The evidence kinds on the case file. */
export async function evidenceKinds(world: AgentWorld, complaint: Pick<Complaint, "complaintId">): Promise<string[]> {
  return (await world.flow.connector.caseItems.listEvidence(WORLD, complaint.complaintId)).map((evidence) => evidence.kind);
}

/** The operator approves the pending approval of the complaint (a recent sign-in), then the world settles. */
export async function operatorApproves(world: AgentWorld, complaint: Pick<Complaint, "complaintId">, role: "OPERATOR" | "SUPERVISOR" = "OPERATOR"): Promise<string | undefined> {
  const pending = (await world.flow.connector.caseItems.listPendingApprovals(WORLD)).find((approval) => approval.complaintId === complaint.complaintId);
  if (pending === undefined) return undefined;
  const console = await world.flow.console(role);
  await console.approvals.decide({ complaintId: complaint.complaintId, approvalId: pending.approvalId, decision: "APPROVED" });
  await world.flow.settle();
  return pending.approvalId;
}

/** The emails the world sent with a tag value (`FORMAL_ANSWER`, `ACK_EMAIL`…). */
export const emailsTagged = (world: AgentWorld, value: string) => world.flow.stage.emails.filter((email) => email.input.EmailTags?.some((tag) => tag.Value === value));
