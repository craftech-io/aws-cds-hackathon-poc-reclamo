// SC-07 (transfers) and SC-08 (disbursements) on the run's model. The status always comes from the
// network and the core; the model only reports it and asks for what the code allows. The oracles read the
// status the tools returned, the actions and their claims, the follow-ups and who holds the case.
import { describe, expect, it } from "vitest";
import { SCRIPTED_RUN, callsOf, okResultOf, openAgentWorld, turnsSummary } from "../support/agent-world";
import type { AgentWorld } from "../support/agent-world";
import { type Customer, actionsOf, agentSentOf, complain, current, outboundOf, pursueStatus, walletOf } from "../support/customer";
import { conversationProblems } from "../support/oracles";

const TRANSFER = "Hice una transferencia y no le llegó a la otra persona";
const DISBURSEMENT = "Me aprobaron el préstamo y no me depositaron la plata";
const FINISHED = ["ANSWERED", "CLOSED"];

async function filed(world: AgentWorld, customerId: string, text: string): Promise<Customer> {
  const complaint = await complain(world, customerId, text);
  if (complaint === undefined) throw new Error("the complaint was not filed");
  return { customerId, complaint };
}

describe.skipIf(SCRIPTED_RUN)("transfers and disbursements (agent)", () => {
  it("[SC-07/2] [FL-041] C27: COMPLETED, the network's trace reaches the customer as the tool wrote it; informational, no action", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0027", TRANSFER);
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(okResultOf(world.agent.turns, "get_transfer_status"), turnsSummary(world.agent.turns)).toMatchObject({ status: "COMPLETED", traceId: "TRZ-7F3K9Q2M" });
    const traces = (await agentSentOf(world, who.customerId)).flatMap((message) => message.body.match(/TRZ-[A-Z0-9]+/g) ?? []);
    expect(traces.every((trace) => trace === "TRZ-7F3K9Q2M")).toBe(true);
    expect(await actionsOf(world, who.complaint)).toEqual([]);
    expect((await current(world, who.complaint))?.outcome).not.toBe("IN_FAVOUR");
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-07/3-4] [FL-042] C28: PENDING waits for the network; when it completes, exactly one update reaches the customer", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0028", TRANSFER);
    await pursueStatus(world, who.customerId, who.complaint, ["AWAITING_NETWORK"], 1);

    expect(okResultOf(world.agent.turns, "get_transfer_status"), turnsSummary(world.agent.turns)).toMatchObject({ status: "PENDING" });
    expect((await current(world, who.complaint))?.status).toBe("AWAITING_NETWORK");
    await world.flow.advance({ kind: "advanceTo", to: "2026-10-08T12:00:00-03:00" });

    expect(world.agent.turns.some((turn) => turn.userText.includes('type="TRANSFER_STATUS_CHANGED"')), turnsSummary(world.agent.turns)).toBe(true);
    expect((await outboundOf(world, who.customerId)).filter((message) => message.kind === "COMPLAINT_UPDATE" && message.status !== "BLOCKED").length).toBeLessThanOrEqual(1);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-07/5] [FL-043] C29: REJECTED_REVERSED needs no reversal", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0029", TRANSFER);
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(okResultOf(world.agent.turns, "get_transfer_status"), turnsSummary(world.agent.turns)).toMatchObject({ status: "REJECTED_REVERSED" });
    expect(callsOf(world.agent.turns, "request_transfer_reversal").filter((call) => (call.output as { ok?: unknown } | null)?.ok === true)).toEqual([]);
    expect(await actionsOf(world, who.complaint)).toEqual([]);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-07/6] [FL-044] C30: REJECTED_NOT_REVERSED → the reversal credits the wallet once, claim TRV#", async () => {
    const world = await openAgentWorld();
    const before = walletOf(world, "cus-0030");
    const who = await filed(world, "cus-0030", "La transferencia que mandé figura pendiente desde ayer");
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    const reversals = (await actionsOf(world, who.complaint)).filter((action) => action.kind === "TRANSFER_REVERSAL" && action.status === "EXECUTED");
    expect(reversals, turnsSummary(world.agent.turns)).toEqual([expect.objectContaining({ claimKey: "TRV#trf-0030-1" })]);
    expect(walletOf(world, "cus-0030")).toBe(before + 3_800_000);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-07/7] [FL-045] C31: an incoming transfer nobody knows goes to a person; no message shows or asks for a full CVU", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0031", "Me transfirieron plata y no la veo en la billetera");
    await pursueStatus(world, who.customerId, who.complaint, ["HUMAN_REVIEW"]);

    expect((await current(world, who.complaint))?.status, turnsSummary(world.agent.turns)).toBe("HUMAN_REVIEW");
    expect((await outboundOf(world, who.customerId)).some((message) => /\d{22}/.test(message.body))).toBe(false);
    expect(await actionsOf(world, who.complaint)).toEqual([]);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-08/2] [FL-046] C32: CREDITED net of the origination fee; every amount told comes from the core", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0032", DISBURSEMENT);
    await pursueStatus(world, who.customerId, who.complaint, FINISHED);

    expect(okResultOf(world.agent.turns, "get_disbursement"), turnsSummary(world.agent.turns)).toMatchObject({ status: "CREDITED", net: { amount: 578_220 } });
    expect(await actionsOf(world, who.complaint)).toEqual([]);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-08/3] [FL-047] C33: PENDING within its term: a follow-up, no person yet", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0033", DISBURSEMENT);
    await pursueStatus(world, who.customerId, who.complaint, ["AWAITING_NETWORK"], 1);

    expect(okResultOf(world.agent.turns, "get_disbursement"), turnsSummary(world.agent.turns)).toMatchObject({ status: "PENDING", overdue: false });
    expect((await current(world, who.complaint))?.status).toBe("AWAITING_NETWORK");
    expect((await world.flow.connector.timers.listByOwner("demo", `CMP#${who.complaint.complaintId}`)).some((timer) => timer.kind === "FOLLOW_UP" && timer.status === "SCHEDULED")).toBe(true);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });

  it("[SC-08/5] [FL-048] C34: FAILED_RETURNED goes to a person, no action of the agent", async () => {
    const world = await openAgentWorld();
    const who = await filed(world, "cus-0034", DISBURSEMENT);
    await pursueStatus(world, who.customerId, who.complaint, ["HUMAN_REVIEW"]);

    expect(okResultOf(world.agent.turns, "get_disbursement"), turnsSummary(world.agent.turns)).toMatchObject({ status: "FAILED_RETURNED" });
    expect((await current(world, who.complaint))?.status).toBe("HUMAN_REVIEW");
    expect(await actionsOf(world, who.complaint)).toEqual([]);
    expect(await conversationProblems(world, who.customerId)).toEqual([]);
  });
});
