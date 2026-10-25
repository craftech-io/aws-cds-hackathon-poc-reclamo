// Smoke of the agent on the run's model: the shortest customer turns of the demo world (SC-00 step 4,
// SC-11 step 1, SC-12 step 2). One turn each, on the real prompt, the deployed Gateway schemas and the
// stage's Cedar statements; the oracles read the world, never the wording.
import { describe, expect, it } from "vitest";
import { SCRIPTED_RUN, openAgentWorld, toolsOf, turnsSummary } from "./support/agent-world";
import { agentSentOf, isIdentified, liveComplaints, outboundOf, say } from "./support/customer";
import { conversationProblems, unansweredInbound } from "./support/oracles";

const C01 = "cus-0001";
const C40 = "cus-0040";
/** Classifier evaluation texts (scripts/seed/data/evals/classifier.json). */
const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const POEM = "Escribime un poema";
/** Reads that reveal account data: never successful before the identity challenge passes. */
const ACCOUNT_READS = new Set(["get_account", "list_operations", "get_loan", "get_instalments", "quote_early_payoff", "get_disbursement", "get_transfer_status"]);

describe.skipIf(SCRIPTED_RUN)("smoke (agent)", () => {
  it("[SC-11/1] [FL-001] \"hola\" is answered in its turn (ALWAYS_ANSWER), without registering anything", async () => {
    const world = await openAgentWorld();
    await say(world, C01, "hola");

    expect(world.agent.turns, "the greeting ran one turn").toHaveLength(1);
    const sent = await agentSentOf(world, C01);
    expect(sent.length, `the agent sent nothing; ${turnsSummary(world.agent.turns)}`).toBeGreaterThan(0);
    expect(sent.map((message) => message.kind)).toEqual(expect.arrayContaining([expect.stringMatching(/^(REPLY|IDENTITY_CHALLENGE)$/)]));
    expect(toolsOf(world.agent.turns)).not.toContain("register_complaint");
    expect(await liveComplaints(world, C01)).toEqual([]);
    expect(await unansweredInbound(world, C01)).toBe(0);
    expect(await conversationProblems(world, C01)).toEqual([]);
  });

  it("[SC-00/4] [SC-01/2] [FL-010] a complaint gets its number by code before the turn; the agent adds no second number and reveals nothing before the challenge", async () => {
    const world = await openAgentWorld();
    await say(world, C01, PAYMENT_NOT_REFLECTED);

    const complaints = await liveComplaints(world, C01);
    expect(complaints.map((complaint) => complaint.complaintNumber)).toEqual(["R-2026-000123"]);
    expect(Date.parse(complaints[0]?.deadlineSim ?? "")).toBe(Date.parse("2026-10-22T23:59:59-03:00"));
    const out = await outboundOf(world, C01);
    const ack = out.find((message) => message.kind === "COMPLAINT_ACK");
    expect(ack).toMatchObject({ sender: "SYSTEM", flags: { disclosure: true } });
    expect(ack?.body).toContain("R-2026-000123");
    expect(out.filter((message) => message.sender === "AGENT").every((message) => (message.createdAt ?? "") >= (ack?.createdAt ?? ""))).toBe(true);
    expect(await world.flow.connector.counters.getComplaintCounter("demo", 1, 2026)).toBe(123);
    expect((await agentSentOf(world, C01)).length, `the agent sent nothing; ${turnsSummary(world.agent.turns)}`).toBeGreaterThan(0);
    if (!(await isIdentified(world, C01))) {
      const revealed = world.agent.turns.flatMap((turn) => turn.calls).filter((call) => ACCOUNT_READS.has(call.name.split("___").at(-1) ?? "") && (call.output as { ok?: unknown } | null)?.ok === true);
      expect(revealed, "an account read succeeded before identification").toEqual([]);
    }
    expect(await conversationProblems(world, C01)).toEqual([]);
  });

  it("[SC-12/2] [FL-056] a poem is refused with an answer: no complaint, no offer", async () => {
    const world = await openAgentWorld();
    await say(world, C40, POEM);

    expect(world.agent.turns).toHaveLength(1);
    const sent = await agentSentOf(world, C40);
    expect(sent.length, `the agent sent nothing; ${turnsSummary(world.agent.turns)}`).toBeGreaterThan(0);
    expect(toolsOf(world.agent.turns)).not.toContain("register_complaint");
    expect(await liveComplaints(world, C40)).toEqual([]);
    expect(await conversationProblems(world, C40)).toEqual([]);
  });
});
