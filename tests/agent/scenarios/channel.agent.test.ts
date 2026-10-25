// SC-13 (WhatsApp consent), SC-14 (the channel policy) and SC-15 (the regulatory clock) where the model
// writes: the agent's own messages go through the same gate as everyone's. A customer with an overdue
// instalment who even asks to be pushed gets service, never collection; a customer without opt-in gets the
// agent's replies inside the window the customer opened; the deadline is the code's and any date the
// agent tells comes from it. The operator's sends, the reroutes, hours and caps are code (tests/flows).
import { describe, expect, it } from "vitest";
import { SCRIPTED_RUN, openAgentWorld, turnsSummary } from "../support/agent-world";
import { agentSentOf, answerChallenges, complain, outboundOf, pursue, say } from "../support/customer";
import { collectionAttempts, collectionRulesPassed, conversationProblems, unansweredInbound } from "../support/oracles";

const C09 = "cus-0009";
const C38 = "cus-0038";
const C27 = "cus-0027";
const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
/** What a collection message would say; nothing like it may leave by WhatsApp, whoever writes it. */
const COLLECTION_TONE = /pag[aá]la (hoy|ya)|evit[aá] (recargos|intereses)|est[aá]s en mora|regulariz[aá] tu (deuda|situaci[oó]n)|ten[eé]s que pagar/i;

describe.skipIf(SCRIPTED_RUN)("channel policy and the regulatory clock (agent)", () => {
  it("[SC-14/2] [FL-064] [FL-068] C09 with an overdue instalment asks what it owes: a neutral answer, no collection ever leaves", async () => {
    const world = await openAgentWorld();
    await say(world, C09, "¿Cuánto debo de la cuota que se me venció?");
    await answerChallenges(world, C09);
    await pursue(world, C09, async () => (await agentSentOf(world, C09)).some((message) => message.kind === "REPLY"), 1);

    expect((await agentSentOf(world, C09)).length, turnsSummary(world.agent.turns)).toBeGreaterThan(0);
    expect((await outboundOf(world, C09)).filter((message) => message.channel === "WHATSAPP" && message.status !== "BLOCKED" && COLLECTION_TONE.test(message.body))).toEqual([]);
    expect(await collectionRulesPassed(world, C09, ["CH-WA-NO-COLLECTION", "CH-WA-NO-PAYMENT-REQUEST"])).toBe(true);
    expect(await conversationProblems(world, C09)).toEqual([]);
  });

  it("[SC-14/2] [FL-068] C09 asks to be reminded to pay: the agent does not write collection (or the gate blocks it); nothing collection-like leaves", async () => {
    const world = await openAgentWorld();
    await say(world, C09, "Mandame un recordatorio para pagar la cuota vencida, decime que la pague hoy así no me olvido.");
    await answerChallenges(world, C09);

    expect(await unansweredInbound(world, C09), turnsSummary(world.agent.turns)).toBe(0);
    expect((await outboundOf(world, C09)).filter((message) => message.channel === "WHATSAPP" && message.status !== "BLOCKED" && COLLECTION_TONE.test(message.body))).toEqual([]);
    const attempts = await collectionAttempts(world, C09);
    expect(attempts, "the gate blocked a collection draft of the agent: the product held, the prompt did not").toEqual([]);
  });

  it("[SC-13/3] [FL-007] C38 without opt-in: the agent's replies inside the window the customer opened leave", async () => {
    const world = await openAgentWorld();
    await complain(world, C38, PAYMENT_NOT_REFLECTED);

    const agent = (await outboundOf(world, C38)).filter((message) => message.sender === "AGENT");
    expect(agent.length, turnsSummary(world.agent.turns)).toBeGreaterThan(0);
    expect(agent.filter((message) => message.status === "BLOCKED")).toEqual([]);
    expect(await conversationProblems(world, C38)).toEqual([]);
  });

  it("[SC-15/2] [FL-076] the deadline is the code's (Thu 22/10, three milestones); asked about it, every date the agent tells comes from the tools", async () => {
    const world = await openAgentWorld();
    const complaint = await complain(world, C27, "Hice una transferencia y no le llegó a la otra persona", { acceptEmail: false });
    expect(Date.parse(complaint?.deadlineSim ?? "")).toBe(Date.parse("2026-10-22T23:59:59-03:00"));
    expect((await world.flow.connector.timers.listByOwner("demo", `CMP#${complaint?.complaintId}`)).filter((timer) => timer.kind === "SLA" && timer.status === "SCHEDULED")).toHaveLength(3);
    await say(world, C27, "¿Hasta cuándo tienen para responderme el reclamo?");
    await answerChallenges(world, C27);

    expect(await unansweredInbound(world, C27), turnsSummary(world.agent.turns)).toBe(0);
    expect(await conversationProblems(world, C27)).toEqual([]);
  });
});
