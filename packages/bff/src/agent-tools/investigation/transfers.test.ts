import { describe, expect, it } from "vitest";
import type { CustomerSpec } from "@reclamo/core-mock/ledger/testing";
import { OTHER_CUSTOMER } from "../common/testing";
import { CUSTOMER, WORLD } from "../account/testing";
import { codeOf, investigationKit, okOf } from "./testing";

const transferMovement = (transferId: string, kind: "TRANSFER_OUT" | "TRANSFER_IN", amount: number, atSim = "2026-10-05T14:00:00-03:00") => ({
  movementId: `mov-${transferId}`,
  kind,
  atSim,
  amount,
  ref: { transferId },
});

function customer(): CustomerSpec {
  return {
    customerId: CUSTOMER,
    balance: 1_000_000,
    movements: [
      transferMovement("trf-done", "TRANSFER_OUT", 4_500_000),
      transferMovement("trf-back", "TRANSFER_OUT", 3_000_000, "2026-10-03T11:00:00-03:00"),
      transferMovement("trf-stuck", "TRANSFER_OUT", 8_000_000, "2026-10-02T09:00:00-03:00"),
      transferMovement("trf-ghost", "TRANSFER_IN", 2_000_000, "2026-10-06T16:00:00-03:00"),
    ],
  };
}

async function setup(customers: readonly CustomerSpec[] = [customer()]) {
  const kit = await investigationKit(customers, { type: "TRANSFER_NOT_CREDITED" });
  const seed = (transferId: string, fields: Record<string, unknown>) =>
    kit.network.seedTransfer({ worldId: WORLD, transferId, customerId: CUSTOMER, direction: "OUT", amount: 4_500_000, status: "COMPLETED", ...fields } as never);
  seed("trf-done", { traceId: "TRZ-7F3K9Q2M", completedAtSim: "2026-10-05T14:02:00-03:00" });
  seed("trf-back", { amount: 3_000_000, status: "REJECTED_REVERSED", rejectReason: "Cuenta destino <cerrada>", reversedAtSim: "2026-10-04T10:00:00-03:00" });
  seed("trf-stuck", { amount: 8_000_000, status: "REJECTED_NOT_REVERSED", rejectReason: "Cuenta destino cerrada" });
  return kit;
}

describe("[FL-041] completed transfer: trace", () => {
  it("[FL-041] get_transfer_status answers COMPLETED with the network's trace and time, the customer's amount and direction, and leaves a TRANSFER_STATUS evidence", async () => {
    const kit = await setup();
    const answer = okOf(await kit.call("get_transfer_status", { transferId: "trf-done" }));
    expect(answer).toMatchObject({ status: "COMPLETED", traceId: "TRZ-7F3K9Q2M", completedAtText: "lunes 05/10 14:02", direction: "OUT", amount: { amount: 45_000, text: "$ 45.000,00" } });
    const evidence = await kit.connector.caseItems.getEvidence(WORLD, kit.complaint.complaintId, String(answer["evidenceId"]));
    expect(evidence).toMatchObject({ kind: "TRANSFER_STATUS", details: { transferId: "trf-done", status: "COMPLETED", traceId: "TRZ-7F3K9Q2M", amount: 4_500_000 } });
    const [result] = await kit.connector.sessions.listTurnResults(WORLD, kit.turnId);
    expect(JSON.stringify(result?.result)).toContain("TRZ-7F3K9Q2M");
  });
});

describe("[FL-043] transfer rejected and reversed", () => {
  it("[FL-043] answers REJECTED_REVERSED with the reversal date and the network's reason escaped as data", async () => {
    const kit = await setup();
    const answer = okOf(await kit.call("get_transfer_status", { transferId: "trf-back" }));
    expect(answer).toMatchObject({ status: "REJECTED_REVERSED", reversedAtText: "domingo 04/10 10:00", rejectReasonText: "Cuenta destino &lt;cerrada&gt;" });
  });

  it("[FL-043] a REJECTED_NOT_REVERSED transfer leaves the evidence request_transfer_reversal needs (status, transfer and amount)", async () => {
    const kit = await setup();
    const answer = okOf(await kit.call("get_transfer_status", { transferId: "trf-stuck" }));
    const evidence = await kit.connector.caseItems.getEvidence(WORLD, kit.complaint.complaintId, String(answer["evidenceId"]));
    expect(evidence?.details).toMatchObject({ status: "REJECTED_NOT_REVERSED", transferId: "trf-stuck", amount: 8_000_000 });
  });
});

describe("[FL-045] incoming transfer the network does not know", () => {
  it("[FL-045] a transfer the network does not know is UNKNOWN, never found, and no CVU travels", async () => {
    const kit = await setup();
    const answer = okOf(await kit.call("get_transfer_status", { transferId: "trf-ghost" }));
    expect(answer).toMatchObject({ status: "UNKNOWN", direction: "IN" });
    expect(answer).not.toHaveProperty("traceId");
    expect(JSON.stringify(answer)).not.toMatch(/\d{22}/);
  });

  it("[FL-045] a transfer that is not among the customer's operations is FORBIDDEN and audited, whatever the network knows", async () => {
    const other: CustomerSpec = { customerId: OTHER_CUSTOMER, phoneHash: "e".repeat(64), movements: [transferMovement("trf-theirs", "TRANSFER_OUT", 100_000)] };
    const kit = await setup([customer(), other]);
    kit.network.seedTransfer({ worldId: WORLD, transferId: "trf-theirs", customerId: OTHER_CUSTOMER, direction: "OUT", amount: 100_000, status: "COMPLETED" } as never);
    expect(codeOf(await kit.call("get_transfer_status", { transferId: "trf-theirs" }))).toBe("FORBIDDEN");
    expect(codeOf(await kit.call("get_transfer_status", { transferId: "trf-nobody" }))).toBe("FORBIDDEN");
    expect((await kit.auditRows()).filter((row) => row.action === "DENY").map((row) => row.ruleIds)).toEqual([["LAM-SCOPE"], ["LAM-SCOPE"]]);
  });

  it("[FL-045] a network that does not answer is UNAVAILABLE, with no evidence", async () => {
    const kit = await setup();
    kit.network.seedWorld(WORLD, { faults: [{ kind: "ERROR_503" }] as never });
    expect(codeOf(await kit.call("get_transfer_status", { transferId: "trf-done" }))).toBe("UNAVAILABLE");
    expect(await kit.connector.caseItems.listEvidence(WORLD, kit.complaint.complaintId)).toEqual([]);
  });
});
