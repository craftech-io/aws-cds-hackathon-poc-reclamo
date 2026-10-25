import { describe, expect, it } from "vitest";
import { complaint, testConnector } from "../connector/testing";
import type { Complaint } from "../domain/complaint";
import { createLogger } from "../lib/log";
import type { TurnEvent } from "../worker/events";
import { recordUsage } from "./record";

describe("the KPI row of a complaint [FL-098]", () => {
  it("[FL-098] the agent that ran the turn decides the row's mode, over the acknowledgement's REAL", async () => {
    const mc = testConnector();
    const filed = complaint("demo", { complaintId: "cmp-0001", origin: "LIVE" }) as unknown as Complaint;
    await mc.connector.metrics.put({ worldId: "demo", source: "WORLD", runId: "world", complaintId: "cmp-0001", complaintType: filed.type, agentMode: "REAL", origin: "LIVE", ackLatencyMs: 0, humanActions: [], tokens: { in: 0, out: 0, cached: 0 }, messages: { wa: 0, email: 0 } });
    const event = { worldId: "demo", customerId: filed.customerId, type: "CUSTOMER_MESSAGE", eventAtSim: filed.filedAtSim } as unknown as TurnEvent;
    await recordUsage({ data: mc.connector, agentMode: "SCRIPTED", log: createLogger({ sink: () => undefined }) }, event, filed, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const [row] = await mc.connector.metrics.list("demo", { source: "WORLD", runId: "world" });
    expect(row).toMatchObject({ complaintId: "cmp-0001", agentMode: "SCRIPTED", ackLatencyMs: 0, tokens: { in: 10, out: 2 } });
  });
});
