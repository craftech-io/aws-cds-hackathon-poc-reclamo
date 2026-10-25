import { describe, expect, it } from "vitest";
import { gatewayContext } from "../common/principal";
import { createComplaintsTarget } from "../complaints/handler";
import { FEES_REFERENCE } from "./reference";
import { createAccountTarget } from "./target";
import { CUSTOMER, WORLD, monthlyInstalments, okOf, targetsKit } from "./testing";

const FEES = [{ code: "FEE-PUNIT", concept: "Interés punitorio", base: "50 % de la tasa compensatoria, diario", when: "Desde el día siguiente al vencimiento", clauseIds: ["T-3.2"] }];
const INVESTIGATING = { status: "INVESTIGATING" as const, statusHistory: [{ from: null, to: "INVESTIGATING" as const, atSim: "2026-10-07T10:00:00-03:00", cause: "SEED", actor: "SYSTEM" }] };

async function setup() {
  const kit = await targetsKit([
    {
      customerId: CUSTOMER,
      loans: [
        { loanId: "L-0001", principal: 60_000_000, instalments: monthlyInstalments() },
        { loanId: "L-0002", principal: 20_000_000, instalments: monthlyInstalments(3, 7_500_000) },
      ],
    },
  ]);
  for (const fee of FEES) await kit.connector.write({ kind: "put", table: "Reference", item: { pk: `REF#${FEES_REFERENCE.type}#${FEES_REFERENCE.scope}`, sk: fee.code, entity: "FeeSchedule", ...fee } });
  await kit.identify();
  const account = createAccountTarget(kit.toolDeps, { core: kit.core });
  const complaints = createComplaintsTarget(kit.toolDeps, { core: () => kit.coreClient, gate: kit.gate.gate, complaints: () => kit.complaintsDeps, documents: () => ({ put: async () => undefined }) });
  const read = (token: string, tool: string, input: Record<string, unknown> = {}) => account.handle({ sessionToken: token, ...input }, gatewayContext(`account___${tool}`));
  const update = (token: string, input: Record<string, unknown>) => complaints.handle({ sessionToken: token, ...input }, gatewayContext("complaints___update_complaint"));
  return { kit, read, update };
}

describe("[FL-030] [FL-032] an account read is evidence only on the complaint it investigates", () => {
  it("[FL-032] get_fee_rules on an unrecognized charge nobody checked leaves nothing, and RESOLVED stays EVIDENCE_REQUIRED", async () => {
    const { kit, read, update } = await setup();
    const charge = await kit.addComplaint({ type: "UNRECOGNIZED_CHARGE", ...INVESTIGATING });
    const { token } = await kit.openTurn({ complaintIds: [charge.complaintId] });
    okOf(await read(token, "get_fee_rules"));
    expect(await kit.connector.caseItems.listEvidence(WORLD, charge.complaintId)).toEqual([]);
    expect(await update(token, { status: "RESOLVED", outcome: "NOT_IN_FAVOUR" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED" } });
  });

  it("[FL-032] a clause read founds nothing on a charge even when it is there: only the charge check does", async () => {
    const { kit, read, update } = await setup();
    const charge = await kit.addComplaint({ type: "UNRECOGNIZED_CHARGE", ...INVESTIGATING });
    await kit.addEvidence({ complaintId: charge.complaintId, evidenceId: "evd-term", kind: "TERMS_CLAUSE", details: { clauseIds: ["T-3.2"] } });
    const { token } = await kit.openTurn({ complaintIds: [charge.complaintId] });
    expect(await update(token, { status: "RESOLVED", outcome: "NOT_IN_FAVOUR" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED" } });
    await kit.addEvidence({ complaintId: charge.complaintId, evidenceId: "evd-chk", kind: "CHARGE_CHECK", details: { result: "CORRECT" } });
    okOf(await read(token, "get_fee_rules"));
    expect((await kit.connector.caseItems.listEvidence(WORLD, charge.complaintId)).filter((item) => item.kind === "TERMS_CLAUSE")).toHaveLength(2);
    expect(await update(token, { status: "RESOLVED", outcome: "NOT_IN_FAVOUR" })).toMatchObject({ ok: true, status: "RESOLVED" });
  });

  it("[FL-030] get_loan lands on the closure about that loan, never on a newer complaint of another type or loan", async () => {
    const { kit, read } = await setup();
    const closure = await kit.addComplaint({ type: "CLOSURE_OR_EARLY_PAYOFF", subject: { loanId: "L-0001" }, ...INVESTIGATING });
    const charge = await kit.addComplaint({ type: "UNRECOGNIZED_CHARGE", ...INVESTIGATING });
    const { token } = await kit.openTurn({ complaintIds: [closure.complaintId, charge.complaintId] });
    okOf(await read(token, "get_loan", { loanId: "L-0002" }));
    expect(await kit.connector.caseItems.listEvidence(WORLD, closure.complaintId)).toEqual([]);
    expect(await kit.connector.caseItems.listEvidence(WORLD, charge.complaintId)).toEqual([]);
    okOf(await read(token, "get_loan", { loanId: "L-0001" }));
    expect(await kit.connector.caseItems.listEvidence(WORLD, closure.complaintId)).toEqual([expect.objectContaining({ kind: "LOAN_STATUS", details: expect.objectContaining({ loanId: "L-0001" }) })]);
    expect(await kit.connector.caseItems.listEvidence(WORLD, charge.complaintId)).toEqual([]);
  });

  it("[FL-063] get_terms on an information request is its foundation", async () => {
    const { kit, read, update } = await setup();
    const question = await kit.addComplaint({ type: "INFORMATION_REQUEST", ...INVESTIGATING });
    const { token } = await kit.openTurn({ complaintIds: [question.complaintId] });
    okOf(await read(token, "get_fee_rules"));
    expect(await update(token, { status: "RESOLVED", outcome: "INFORMATIONAL" })).toMatchObject({ ok: true, status: "RESOLVED" });
  });
});
