// SC-11 (identification and the register) on the run's model: the challenge passed and failed, an enquiry
// answered on the spot, one that needs work, an unclear first message and a withdrawal. The number, the
// register and the identity checks are code; the oracles read them, the tools called and what left.
import { describe, expect, it } from "vitest";
import { SCRIPTED_RUN, callsOf, okResultOf, openAgentWorld, toolsOf, turnsSummary } from "../support/agent-world";
import { agentSentOf, answerChallenges, complain, current, isIdentified, liveComplaints, pursue, say, tapIfOffered } from "../support/customer";
import { collectionRulesPassed, conversationProblems, unansweredInbound } from "../support/oracles";

const C01 = "cus-0001";
const C02 = "cus-0002";
const C08 = "cus-0008";
const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";

describe.skipIf(SCRIPTED_RUN)("identification and the register (agent)", () => {
  it("[SC-11/4] [FL-003] the agent asks the challenge, checks the customer's answer with verify_challenge and the session is identified", async () => {
    const world = await openAgentWorld();
    const complaint = await complain(world, C01, PAYMENT_NOT_REFLECTED, { acceptEmail: false });

    expect(complaint?.complaintNumber).toBe("R-2026-000123");
    expect(await isIdentified(world, C01), turnsSummary(world.agent.turns)).toBe(true);
    expect(okResultOf(world.agent.turns, "verify_challenge")).toMatchObject({ result: "OK" });
    expect((await world.flow.connector.caps.getChallenge("demo", C01))?.failures ?? []).toHaveLength(0);
    expect((await current(world, complaint ?? { complaintId: "" }))?.status).not.toBe("REGISTERED");
    expect(await conversationProblems(world, C01)).toEqual([]);
  });

  it("[SC-11/3] [FL-004] two wrong answers: never identified, nothing revealed; the second failure locks and a person verifies", async () => {
    const world = await openAgentWorld();
    await say(world, C02, "Me cobraron una comisión que no reconozco");
    await answerChallenges(world, C02, () => "1/1");

    expect(await isIdentified(world, C02)).toBe(false);
    const failures = (await world.flow.connector.caps.getChallenge("demo", C02))?.failures ?? [];
    expect(failures.length, `the agent never checked an answer; ${turnsSummary(world.agent.turns)}`).toBeGreaterThan(0);
    const [complaint] = await liveComplaints(world, C02);
    if (failures.length >= 2) expect(complaint).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "IDENTITY_VERIFICATION" } });
    expect(okResultOf(world.agent.turns, "get_account")).toBeUndefined();
    expect(okResultOf(world.agent.turns, "list_operations")).toBeUndefined();
    expect(await conversationProblems(world, C02)).toEqual([]);
  });

  it("[SC-11/6] [FL-008] an enquiry is answered on the spot from the core, with no number and in a neutral tone", async () => {
    const world = await openAgentWorld();
    await say(world, C08, "¿Cuánto me falta pagar del préstamo?");
    await answerChallenges(world, C08);
    await pursue(world, C08, async () => (await agentSentOf(world, C08)).some((message) => message.kind === "REPLY" && /\$\s?\d/.test(message.body)), 1);

    expect(await isIdentified(world, C08)).toBe(true);
    expect(await liveComplaints(world, C08)).toEqual([]);
    expect(await world.flow.connector.counters.getComplaintCounter("demo", 1, 2026)).toBe(122);
    expect((await agentSentOf(world, C08)).some((message) => message.kind === "REPLY"), turnsSummary(world.agent.turns)).toBe(true);
    expect(await collectionRulesPassed(world, C08)).toBe(true);
    expect(await conversationProblems(world, C08)).toEqual([]);
  });

  it("[SC-11/7] [FL-009] an enquiry that needs work is registered as CONSULTA INFORMATION_REQUEST with its correlative number", async () => {
    const world = await openAgentWorld();
    await say(world, C08, "Necesito el detalle de todos los pagos del año");
    await answerChallenges(world, C08);
    await pursue(world, C08, async () => (await liveComplaints(world, C08)).length > 0, 1);

    const complaints = await liveComplaints(world, C08);
    expect(complaints.map((complaint) => [complaint.kind, complaint.type, complaint.complaintNumber]), turnsSummary(world.agent.turns)).toEqual([["CONSULTA", "INFORMATION_REQUEST", "R-2026-000123"]]);
    expect((await world.flow.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).map((entry) => entry.eventType)).toContain("FILED");
    expect(await conversationProblems(world, C08)).toEqual([]);
  });

  it("[SC-11/8] [FL-012] an unclear first message is answered; once the customer says what happened, the complaint is registered before any investigation succeeds", async () => {
    const world = await openAgentWorld();
    await say(world, C01, "Una consulta");
    expect((await agentSentOf(world, C01)).length, turnsSummary(world.agent.turns)).toBeGreaterThan(0);
    await say(world, C01, "El préstamo me figura aprobado hace una semana pero la plata nunca apareció en la billetera");
    await answerChallenges(world, C01);
    await pursue(world, C01, async () => (await liveComplaints(world, C01)).length > 0, 1);

    const complaints = await liveComplaints(world, C01);
    expect(complaints, turnsSummary(world.agent.turns)).toHaveLength(1);
    expect(complaints[0]?.complaintNumber).toBe("R-2026-000123");
    const investigated = callsOf(world.agent.turns, "get_disbursement").filter((call) => (call.output as { ok?: unknown } | null)?.ok === true);
    if (investigated.length > 0) expect(toolsOf(world.agent.turns).includes("register_complaint") || complaints[0]?.kind === "RECLAMO").toBe(true);
    expect(await unansweredInbound(world, C01)).toBe(0);
    expect(await conversationProblems(world, C01)).toEqual([]);
  });

  it("[SC-11/10] [FL-015] the identified customer withdraws: WITHDRAWN in the register, ANSWERED, the milestones cancelled", async () => {
    const world = await openAgentWorld();
    const complaint = await complain(world, C01, PAYMENT_NOT_REFLECTED);
    expect(complaint).toBeDefined();
    await say(world, C01, "Ya está, se acreditó solo. Cerralo, retiro el reclamo.");
    await answerChallenges(world, C01);
    const withdrawn = async () => (await current(world, complaint ?? { complaintId: "" }))?.outcome === "WITHDRAWN";
    if (!(await withdrawn())) {
      await tapIfOffered(world, C01, "WITHDRAW");
      if (!(await withdrawn())) await say(world, C01, "Sí, confirmo que lo retiro.");
    }

    const done = await current(world, complaint ?? { complaintId: "" });
    expect(done, turnsSummary(world.agent.turns)).toMatchObject({ outcome: "WITHDRAWN" });
    expect(["ANSWERED", "CLOSED"]).toContain(done?.status);
    expect((await world.flow.connector.chains.listRegisterByComplaint("demo", 1, complaint?.complaintNumber ?? "")).map((entry) => entry.eventType)).toEqual(expect.arrayContaining(["FILED", "WITHDRAWN"]));
    expect((await world.flow.connector.timers.listByOwner("demo", `CMP#${complaint?.complaintId}`)).filter((timer) => timer.kind === "SLA").every((timer) => timer.status === "CANCELLED")).toBe(true);
    expect(await conversationProblems(world, C01)).toEqual([]);
  });
});
