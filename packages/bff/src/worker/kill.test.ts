// The agent's runtime kill switch (docs/architecture.md §13, ADR-0017, FL-109): `KILL#AGENT` for every
// world and `W#<w>#KILL` for one, read before the caps, G1 and the Harness. While it is on, no turn runs
// and nothing is spent; the customer gets the fixed handoff notice and a person.
import { describe, expect, it } from "vitest";
import { poolBuckets, worldBuckets } from "./caps";
import { AGENT_KILLED_METRIC, agentKillScope } from "./kill";
import { TEST_NOW, eventOf, recordOf, workerKit, type WorkerKit } from "./testing";
import { processRecord } from "./worker";

async function customerTurn(kit: WorkerKit, eventId: string) {
  await kit.addInbound(`msg-${eventId}`, "Quiero reclamar un débito");
  return processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: `msg-${eventId}`, messageAtSim: "2026-10-07T10:10:00-03:00", complaintIds: [] }, { worldId: kit.worldId, eventId })));
}

describe("[FL-109] the agent's kill switch", () => {
  it("[FL-109] with KILL#AGENT on, no turn runs: AGENT_KILLED, AgentKilled, handoff notice, no G1, no Harness, no cap spent", async () => {
    const kit = await workerKit();
    const complaint = await kit.addComplaint({ status: "REGISTERED" });
    await kit.connector.runtime.setKill({ on: true, by: "BUDGET", atReal: TEST_NOW.toISOString(), reason: "BUDGET_100" });
    await customerTurn(kit, "evt-killed");
    expect(kit.harness.requests).toHaveLength(0);
    expect(kit.g1.texts).toHaveLength(0);
    const audit = await kit.audited("AGENT_KILLED");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ scope: "GLOBAL" });
    expect(kit.lines.some((line) => line.metric === AGENT_KILLED_METRIC)).toBe(true);
    expect(kit.gate.requests.map((request) => [request.kind, request.sender])).toEqual([["HANDOFF_NOTICE", "SYSTEM"]]);
    expect((await kit.connector.complaints.get("demo", complaint.complaintId))?.status).toBe("HUMAN_REVIEW");
    const settings = await kit.connector.worlds.getSettings("demo");
    if (settings === undefined) throw new Error("no settings");
    for (const bucket of [...worldBuckets("demo", 1, settings, TEST_NOW), ...poolBuckets("demo", TEST_NOW)]) expect(await kit.counter(bucket.key)).toBe(0);
  });

  it("[FL-109] W#<w>#KILL cuts only its own world", async () => {
    const kit = await workerKit({ worldId: "g07" });
    await kit.connector.runtime.setKill({ worldId: "g07", on: true, by: "QA", atReal: TEST_NOW.toISOString() });
    expect(await agentKillScope(kit.connector, "g07")).toBe("WORLD");
    expect(await agentKillScope(kit.connector, "demo")).toBeUndefined();
    await customerTurn(kit, "evt-world-killed");
    expect(kit.harness.requests).toHaveLength(0);
    expect((await kit.connector.audit.listByAction("g07", "AGENT_KILLED"))[0]?.detail).toMatchObject({ scope: "WORLD" });
  });

  it("[FL-109] turned off, without a deploy, the next turn runs again", async () => {
    const kit = await workerKit();
    await kit.connector.runtime.setKill({ on: true, by: "BUDGET", atReal: TEST_NOW.toISOString() });
    expect(await agentKillScope(kit.connector, "demo")).toBe("GLOBAL");
    await customerTurn(kit, "evt-off-1");
    await kit.connector.runtime.setKill({ on: false, by: "BUDGET", atReal: TEST_NOW.toISOString() });
    await customerTurn(kit, "evt-off-2");
    expect(kit.harness.requests).toHaveLength(1);
  });
});
