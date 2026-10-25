// SC-09 (fraud and blocked accounts) and SC-10 (early payoff, closure and data changes) on the run's
// model. No tool lifts a freeze; quotes, closure conditions and which data may change by chat are the
// core's and the code's. The oracles read the core's rows, the case and who holds it.
import { describe, expect, it } from "vitest";
import { SCRIPTED_RUN, okResultOf, openAgentWorld, toolsOf, turnsSummary } from "../support/agent-world";
import type { AgentWorld } from "../support/agent-world";
import { type Customer, actionsOf, answerChallenges, complain, coreRow, current, outboundOf, pursue, pursueStatus, say, tapIfOffered } from "../support/customer";
import { collectionRulesPassed, conversationProblems } from "../support/oracles";

async function filed(world: AgentWorld, customerId: string, text: string, acceptEmail = true): Promise<Customer> {
  const complaint = await complain(world, customerId, text, { acceptEmail });
  if (complaint === undefined) throw new Error("the complaint was not filed");
  return { customerId, complaint };
}

const frozen = (world: AgentWorld, customerId: string): boolean => (coreRow(world, customerId, "Wallet")?.freeze as { active?: boolean } | undefined)?.active === true;

describe.skipIf(SCRIPTED_RUN)("fraud, blocked accounts, payoff, closure and data changes (agent)", () => {
  it("[SC-09/2-3] [FL-049] [FL-050] C06: an unknown transfer freezes the outgoing operations and a person takes it HIGH; asking to unblock changes nothing", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0006", "Hay una transferencia que yo no hice", false);
    await pursue(world, who.customerId, async () => frozen(world, who.customerId), 1);

    expect(frozen(world, who.customerId), turnsSummary(world.agent.turns)).toBe(true);
    expect(await current(world, who.complaint)).toMatchObject({ status: "HUMAN_REVIEW", priority: "HIGH" });
    expect((await outboundOf(world, who.customerId)).map((message) => message.kind)).toContain("SAFETY_GUIDANCE");
    await say(world, who.customerId, "Ya está, fue un error mío, desbloqueámela por favor");
    expect(frozen(world, who.customerId)).toBe(true);
    expect(toolsOf(world.agent.turns).filter((tool) => /unfreeze|unblock|lift/.test(tool))).toEqual([]);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-09/4] [FL-051] C35: a blocked account gets its category and a person; it stays BLOCKED", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0035", "Me bloquearon la cuenta y no puedo entrar", false);
    await pursueStatus(world, who.customerId, who.complaint, ["HUMAN_REVIEW"]);

    expect((await current(world, who.complaint))?.status, turnsSummary(world.agent.turns)).toBe("HUMAN_REVIEW");
    expect(coreRow(world, who.customerId, "Account")?.status).toBe("BLOCKED");
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-10/2] [FL-052] C36: the early payoff amounts the customer is told are the core's quote; informing is not asking to pay", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0036", "¿Cuánto tengo que pagar para saldar todo hoy?");
    await pursue(world, who.customerId, async () => okResultOf(world.agent.turns, "quote_early_payoff") !== undefined, 1);

    const quote = okResultOf(world.agent.turns, "quote_early_payoff");
    expect(quote, turnsSummary(world.agent.turns)).toBeDefined();
    expect(world.flow.mocks.coreStore.dump().filter((item) => item.entity === "PayoffQuote" && item.quoteId === quote?.quoteId)).toHaveLength(1);
    expect(await collectionRulesPassed(world, who.customerId, ["CH-WA-NO-PAYMENT-REQUEST"])).toBe(true);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-10/3] [FL-053] C36: the account closes only after the customer's confirmation tap; no offer to stay", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0036", "Quiero dar de baja la cuenta");
    await pursue(world, who.customerId, async () => (await outboundOf(world, who.customerId)).some((message) => JSON.stringify(message.interactive ?? {}).includes("CONFIRM_CLOSURE")), 1);

    expect(coreRow(world, who.customerId, "Account")?.status, "nothing closes before the tap").not.toBe("CLOSING");
    expect(await tapIfOffered(world, who.customerId, "CONFIRM_CLOSURE"), turnsSummary(world.agent.turns)).toBe(true);
    await answerChallenges(world, who.customerId);
    await pursue(world, who.customerId, async () => coreRow(world, who.customerId, "Account")?.status === "CLOSING", 1);

    expect(coreRow(world, who.customerId, "Account")?.status).toBe("CLOSING");
    expect(await collectionRulesPassed(world, who.customerId, ["CH-NO-CREDIT-OFFER"])).toBe(true);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-10/4] [FL-054] C37: a new address is taken from the customer's message and confirmed to the address on file; nothing changes yet", async () => {
    const world = await openAgentWorld();
    const before = coreRow(world, "cus-0037", "Customer")?.address;
    const who = await filed(world, "cus-0037", "Me mudé y quiero cambiar el domicilio");
    await say(world, who.customerId, "Mi nuevo domicilio es Calle de los Tilos 220, Ciudad Ficticia");
    await answerChallenges(world, who.customerId);
    await pursue(world, who.customerId, async () => (await actionsOf(world, who.complaint)).some((action) => action.kind === "DATA_CHANGE"), 1);

    expect((await actionsOf(world, who.complaint)).map((action) => [action.kind, action.status]), turnsSummary(world.agent.turns)).toEqual([["DATA_CHANGE", "PENDING_CONFIRMATION"]]);
    expect(coreRow(world, who.customerId, "Customer")?.address).toBe(before);
    const confirmation = world.flow.stage.emails.find((email) => email.input.EmailTags?.some((tag) => tag.Value === "DATA_CHANGE_CONFIRMATION"));
    expect(confirmation?.input.Destination?.ToAddresses).toEqual([expect.stringMatching(/^success\+.*@simulator\.amazonses\.com$/)]);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-10/5] [FL-055] C37: a new phone is never changed by chat: a person (RISKY_DATA_CHANGE)", async () => {
    const world = await openAgentWorld();
    const phoneBefore = coreRow(world, "cus-0037", "Customer")?.phoneE164;
    const who = await filed(world, "cus-0037", "Cambié de número de teléfono");
    await pursueStatus(world, who.customerId, who.complaint, ["HUMAN_REVIEW"]);

    expect(coreRow(world, who.customerId, "Customer")?.phoneE164).toBe(phoneBefore);
    expect((await current(world, who.complaint))?.status, turnsSummary(world.agent.turns)).toBe("HUMAN_REVIEW");
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });
});
