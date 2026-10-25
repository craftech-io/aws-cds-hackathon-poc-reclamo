// `identify_customer` and `verify_challenge` (docs/tool-catalog.md target `identity`, FL-003, FL-004).
// The customer is the session's (the phone the channel resolved); the model only relays the answer the
// customer wrote. Everything that decides is here or in the core:
//
//   identify_customer  IDENTIFIED while `identifiedUntilReal` is ahead of the real clock; LOCKED with a
//                      staff lock or two failures in 24 real hours; else NEEDS_CHALLENGE with the fact
//                      to ask and its fixed text of copy/ (never the expected value).
//   verify_challenge   only an answer the customer wrote after the challenge went out, checked once
//                      (customer-answer.ts): the core compares the customer's own fragment, never the
//                      model's string, and a refusal counts nothing; OK → identified for 30 real
//                      minutes, failures cleared, the session's REGISTERED complaints move to
//                      INVESTIGATING (`IDENTIFIED`); FAILED → one more failure of the customer; the
//                      second → LOCKED and the handler hands the case over (`IDENTITY_VERIFICATION`),
//                      never the model.
import { ToolError, ok } from "@reclamo/shared";
import { CHALLENGE_PROMPT, WHATSAPP_TEXT } from "../../copy";
import type { ComplaintsDeps } from "../../complaints/deps";
import { transition } from "../../complaints/state-machine";
import { CoreError } from "../../core/errors";
import type { Complaint } from "../../domain/complaint";
import { withRetry } from "../../lib/retry";
import type { ToolContext, ToolImplementation, ToolResponse } from "../common/context";
import type { ToolInput } from "../common/define";
import { type CorePort, coreContextOf } from "../account/core";
import { dayTimeText } from "../account/format";
import { type HandoffPorts, handOverByCode } from "../investigation/handoff";
import { IDENTIFICATION_MS, challengeFacts, challengeKindFor, standingOf } from "./challenge";
import { customerAnswer } from "./customer-answer";
import type { IDENTITY_TOOLS } from "./schema";

type Tools = typeof IDENTITY_TOOLS;

export interface IdentityPorts extends HandoffPorts {
  readonly core: CorePort;
}

/** The session's complaints still being worked, oldest first. */
async function openComplaints(deps: ComplaintsDeps, ctx: ToolContext<unknown>): Promise<Complaint[]> {
  const { worldId, customerId, complaintIds } = ctx.session;
  const loaded = await Promise.all(complaintIds.map((id) => deps.connector.complaints.get(worldId, id, { consistent: true })));
  return loaded.filter((complaint): complaint is Complaint => complaint !== undefined && complaint.customerId === customerId && complaint.status !== "ANSWERED" && complaint.status !== "CLOSED");
}

async function firstNameOf(ports: IdentityPorts, ctx: ToolContext<unknown>): Promise<string> {
  const customer = await ports.core().call("getCustomer", coreContextOf(ctx), { params: { customerId: ctx.session.customerId } });
  return customer.firstName;
}

export function identityTools(ports: IdentityPorts) {
  const identifyCustomer: ToolImplementation<ToolInput<Tools["identify_customer"]>> = async (ctx): Promise<ToolResponse> => {
    const realNow = ctx.wallClock();
    const { worldId, customerId } = ctx.session;
    const [conversation, ledger, firstName] = await Promise.all([
      ctx.connector.conversations.getMeta(worldId, customerId, { consistent: true }),
      ctx.connector.caps.getChallenge(worldId, customerId),
      firstNameOf(ports, ctx),
    ]);
    const until = conversation?.identifiedUntilReal;
    if (until !== undefined && Date.parse(until) > realNow.getTime()) return ok({ status: "IDENTIFIED", firstName, identifiedUntilText: dayTimeText(until) });
    const standing = standingOf(ledger, realNow);
    if (standing.locked) return ok({ status: "LOCKED", firstName, attemptsLeft: 0 });
    const kind = challengeKindFor(await challengeFacts(ports.core, ctx.connector, ctx));
    if (kind === undefined) throw new ToolError("NOT_ELIGIBLE", "no identity challenge applies to this customer: hand the case to a person (IDENTITY_VERIFICATION)");
    return ok({ status: "NEEDS_CHALLENGE", firstName, challenge: { kind, promptText: WHATSAPP_TEXT[CHALLENGE_PROMPT[kind]] }, attemptsLeft: standing.attemptsLeft });
  };

  async function identified(ctx: ToolContext<ToolInput<Tools["verify_challenge"]>>, answerMessageId: string): Promise<ToolResponse> {
    const { worldId, customerId } = ctx.session;
    const realNow = ctx.wallClock();
    const untilReal = new Date(realNow.getTime() + IDENTIFICATION_MS).toISOString();
    await withRetry(
      async () => {
        const meta = await ctx.connector.conversations.getMeta(worldId, customerId, { consistent: true });
        if (meta === undefined) throw new ToolError("NOT_FOUND", "the customer has no conversation");
        await ctx.connector.conversations.updateMeta(worldId, customerId, meta.version, { identifiedAtReal: realNow.toISOString(), identifiedUntilReal: untilReal });
      },
      { attempts: 3, baseDelayMs: 20, shouldRetry: (error) => !(error instanceof ToolError) },
    );
    await ctx.connector.caps.clearChallenge(worldId, customerId);
    const deps = ports.complaints();
    const moved: string[] = [];
    for (const complaint of await openComplaints(deps, ctx)) {
      if (complaint.status !== "REGISTERED") continue;
      try {
        await transition(deps, { worldId, complaintId: complaint.complaintId, to: "INVESTIGATING", cause: "IDENTIFIED", actor: "SYSTEM", atSim: ctx.session.eventAtSim, complaint });
        moved.push(complaint.complaintId);
      } catch (error) {
        ctx.log.warn("tool.identified_transition_skipped", { complaintId: complaint.complaintId, error });
      }
    }
    await ctx.audit({ action: "IDENTIFIED", outcome: "OK", refs: { messageId: answerMessageId }, ...(moved.length === 0 ? {} : { detail: { investigating: moved } }) });
    return ok({ result: "OK", attemptsLeft: standingOf(undefined, realNow).attemptsLeft, identifiedUntilText: dayTimeText(untilReal) });
  }

  async function locked(ctx: ToolContext<ToolInput<Tools["verify_challenge"]>>, newlyLocked: boolean): Promise<ToolResponse> {
    const { worldId, customerId } = ctx.session;
    if (!newlyLocked) return ok({ result: "LOCKED", attemptsLeft: 0 });
    await ctx.connector.caps.lockChallenge(worldId, customerId);
    const complaints = await openComplaints(ports.complaints(), ctx);
    const handoff = await handOverByCode(ports, ctx, { reason: "IDENTITY_VERIFICATION", cause: "CHALLENGE_LOCKED", complaints, summary: "Dos respuestas incorrectas al desafío de identidad en 24 horas reales: verificar la identidad." });
    await ctx.audit({ action: "CHALLENGE_LOCKED", outcome: "IDENTITY_VERIFICATION", refs: handoff.handoffNoticeMessageId === undefined ? {} : { messageId: handoff.handoffNoticeMessageId }, detail: { handedOver: [...handoff.handedOver] } });
    return ok({ result: "LOCKED", attemptsLeft: 0, ...(handoff.handoffNoticeMessageId === undefined ? {} : { handoffNoticeMessageId: handoff.handoffNoticeMessageId }) });
  }

  const verifyChallenge: ToolImplementation<ToolInput<Tools["verify_challenge"]>> = async (ctx) => {
    const { worldId, customerId } = ctx.session;
    const realNow = ctx.wallClock();
    const conversation = ctx.conversation ?? (await ctx.connector.conversations.getMeta(worldId, customerId, { consistent: true }));
    const until = conversation?.identifiedUntilReal;
    if (until !== undefined && Date.parse(until) > realNow.getTime()) return ok({ result: "OK", attemptsLeft: standingOf(undefined, realNow).attemptsLeft, identifiedUntilText: dayTimeText(until) });
    if (standingOf(await ctx.connector.caps.getChallenge(worldId, customerId), realNow).locked) return locked(ctx, false);
    const kind = challengeKindFor(await challengeFacts(ports.core, ctx.connector, ctx));
    if (kind === undefined) throw new ToolError("NOT_ELIGIBLE", "no identity challenge applies to this customer: hand the case to a person (IDENTITY_VERIFICATION)");
    const written = await customerAnswer(ctx, kind, ctx.input.answer);
    let matched: boolean;
    try {
      matched = (await ports.core().call("checkChallenge", coreContextOf(ctx), { params: { customerId }, body: { kind, answer: written.fragment } })).ok;
    } catch (error) {
      // A fact the customer cannot answer is not a failure of theirs: nothing is counted.
      if (error instanceof CoreError && error.contractCode === "NOT_ELIGIBLE") throw new ToolError("NOT_ELIGIBLE", "this challenge cannot be answered now; ask identify_customer again");
      throw error;
    }
    if (matched) return identified(ctx, written.messageId);
    const recorded = await ctx.connector.caps.recordChallengeFailure(worldId, customerId);
    if (recorded.status === "LOCKED") return locked(ctx, false);
    const standing = standingOf(recorded.ledger, realNow);
    if (standing.locked) return locked(ctx, true);
    await ctx.audit({ action: "CHALLENGE_FAILED", outcome: "FAILED", refs: { messageId: written.messageId }, detail: { failures: standing.failures, kind } });
    return ok({ result: "FAILED", attemptsLeft: standing.attemptsLeft, retryText: WHATSAPP_TEXT.CHALLENGE_RETRY });
  };

  return { identify_customer: identifyCustomer, verify_challenge: verifyChallenge } as const;
}
