import { describe, expect, it } from "vitest";
import type { CustomerSpec } from "@reclamo/core-mock/ledger/testing";
import { OTHER_CUSTOMER } from "../common/testing";
import { CUSTOMER, WORLD, monthlyInstalments } from "../account/testing";
import { codeOf, investigationKit, okOf } from "./testing";

const GROSS = 50_000_000;
const FEE = 1_815_000;

function customer(disbursement: Record<string, unknown>, loans = 1): CustomerSpec {
  return {
    customerId: CUSTOMER,
    loans: Array.from({ length: loans }, (_, index) => ({
      loanId: `L-000${index + 1}`,
      principal: GROSS,
      disbursedAtSim: "2026-10-06T10:00:00-03:00",
      instalments: monthlyInstalments(6),
      disbursement: { gross: GROSS, originationFee: FEE, net: GROSS - FEE, ...disbursement },
    })),
  };
}

async function setup(disbursement: Record<string, unknown>, others: readonly CustomerSpec[] = []) {
  return investigationKit([customer(disbursement), ...others], { type: "DISBURSEMENT_NOT_RECEIVED", subject: { loanId: "L-0001" } });
}

describe("[FL-046] disbursement credited", () => {
  it("[FL-046] get_disbursement answers CREDITED with gross, origination fee and net from the core, and leaves a DISBURSEMENT evidence", async () => {
    const kit = await setup({ status: "CREDITED", creditedAtSim: "2026-10-06T10:05:00-03:00" });
    const answer = okOf(await kit.call("get_disbursement", {}));
    expect(answer).toMatchObject({
      loanId: "L-0001",
      status: "CREDITED",
      gross: { text: "$ 500.000,00" },
      originationFee: { text: "$ 18.150,00" },
      net: { text: "$ 481.850,00" },
      creditedAtText: "martes 06/10 10:05",
      overdue: false,
    });
    const evidence = await kit.connector.caseItems.getEvidence(WORLD, kit.complaint.complaintId, String(answer["evidenceId"]));
    expect(evidence).toMatchObject({ kind: "DISBURSEMENT", details: { loanId: "L-0001", status: "CREDITED", net: GROSS - FEE } });
    expect((await kit.auditRows()).find((row) => row.action === "GET_DISBURSEMENT")).toMatchObject({ outcome: "CREDITED" });
  });
});

describe("[FL-047] disbursement delayed within and past its term", () => {
  it("[FL-047] PENDING within its term says when it is expected and is not overdue", async () => {
    const kit = await setup({ status: "PENDING", expectedBySim: "2026-10-08T18:00:00-03:00" });
    expect(okOf(await kit.call("get_disbursement", { loanId: "L-0001" }))).toMatchObject({ status: "PENDING", expectedByText: "jueves 08/10 18:00", overdue: false });
  });

  it("[FL-047] PENDING within its term: the code sets AWAITING_NETWORK and a FOLLOW_UP an hour after the expected time, once", async () => {
    const kit = await setup({ status: "PENDING", expectedBySim: "2026-10-08T15:00:00-03:00" });
    expect(okOf(await kit.call("get_disbursement", {}))).toMatchObject({ status: "PENDING", overdue: false, complaintStatus: "AWAITING_NETWORK", followUpAtText: "jueves 08/10 16:00" });
    expect(okOf(await kit.call("get_disbursement", {}))).toMatchObject({ complaintStatus: "AWAITING_NETWORK" });
    expect(await kit.connector.complaints.get(WORLD, kit.complaint.complaintId)).toMatchObject({ status: "AWAITING_NETWORK" });
    const followUps = (await kit.connector.timers.listByOwner(WORLD, `CMP#${kit.complaint.complaintId}`)).filter((timer) => timer.kind === "FOLLOW_UP");
    expect(followUps).toEqual([expect.objectContaining({ status: "SCHEDULED", dueAtSim: "2026-10-08T16:00:00-03:00" })]);
    expect(kit.gate.requests).toEqual([]);
  });

  it("[FL-047] PENDING past its term is overdue, so the case goes to a person", async () => {
    const kit = await setup({ status: "PENDING", expectedBySim: "2026-10-07T09:00:00-03:00" });
    const answer = okOf(await kit.call("get_disbursement", {}));
    expect(answer).toMatchObject({ status: "PENDING", overdue: true });
    expect(answer["complaintStatus"]).toBeUndefined();
    expect((await kit.connector.timers.listByOwner(WORLD, `CMP#${kit.complaint.complaintId}`)).filter((timer) => timer.kind === "FOLLOW_UP")).toEqual([]);
  });
});

describe("[FL-048] disbursement failed or held", () => {
  it.each(["FAILED_RETURNED", "HELD_REVIEW"])("[FL-048] answers %s as the core says it, with no action of its own", async (status) => {
    const kit = await setup({ status, ...(status === "FAILED_RETURNED" ? { returnedAtSim: "2026-10-06T15:00:00-03:00" } : {}) });
    const answer = okOf(await kit.call("get_disbursement", {}));
    expect(answer["status"]).toBe(status);
    expect(kit.gate.requests).toEqual([]);
    expect((await kit.connector.complaints.get(WORLD, kit.complaint.complaintId))?.status).toBe("INVESTIGATING");
  });

  it("[FL-048] a loan of someone else is FORBIDDEN; without a loan named nor in the complaint, the latest loan is read", async () => {
    const other: CustomerSpec = { customerId: OTHER_CUSTOMER, phoneHash: "f".repeat(64), loans: [{ loanId: "L-0099", principal: GROSS, instalments: monthlyInstalments(3), disbursement: { status: "CREDITED", gross: GROSS, originationFee: FEE, net: GROSS - FEE } }] };
    const kit = await setup({ status: "CREDITED" }, [other]);
    expect(codeOf(await kit.call("get_disbursement", { loanId: "L-0099" }))).toBe("FORBIDDEN");

    const twoLoans = await investigationKit([customer({ status: "CREDITED" }, 2)], { type: "DISBURSEMENT_NOT_RECEIVED" });
    expect(okOf(await twoLoans.call("get_disbursement", {}))).toMatchObject({ loanId: "L-0002" });
  });
});
