// What the complaint's case file adds to the grounding of the agent's text (outbound/case-facts.ts): only
// what code validated and what is the customer's own, amounts written as the tools write them.
import { describe, expect, it } from "vitest";
import type { Action, Approval, Evidence } from "../domain/case-items";
import { caseFactsOf } from "./case-facts";

const base = { worldId: "demo", complaintId: "cmp-1", atSim: "2026-10-07T10:00:00-03:00", actor: "AGENT" as const };
const evidence = (evidenceId: string, kind: Evidence["kind"], details: Evidence["details"]): Evidence => ({ ...base, evidenceId, kind, details });

describe("case facts of a complaint", () => {
  it("[FL-024] keeps a READ reading's fields, a MATCHED line, and the amounts of actions and approvals", () => {
    const file = {
      evidence: [
        evidence("e1", "RECEIPT_READING", { result: "READ", fields: { network: "NORTE", operationCode: "NTE-20261005-010014-0", amount: 31_240_000, paidAtLocal: "2026-10-05T10:00" } }),
        evidence("e2", "SETTLEMENT_MATCH", { result: "MATCHED", line: { operationCode: "NTE-20261005-010014-0", amount: 31_240_000 } }),
      ],
      actions: [{ ...base, actionId: "a1", kind: "APPLY_PAYMENT", status: "EXECUTED", amountCents: 31_240_000, coreRef: "mov-77", idempotencyKey: "k" } as Action],
      approvals: [{ amountCents: 31_240_000 } as Approval],
    };
    const facts = JSON.stringify(caseFactsOf(file));
    expect(facts).toContain("NTE-20261005-010014-0");
    expect(facts).toContain("$ 312.400,00");
    expect(facts).toContain("mov-77");
  });

  it("never grounds on a reading that failed validation, a disagreement or another payer's line", () => {
    const file = {
      evidence: [
        evidence("e1", "RECEIPT_READING", { result: "INVALID_RECEIPT", fields: { operationCode: "NTE-1111", amount: 100 } }),
        evidence("e2", "RECEIPT_READING", { result: "DISAGREE", disagreement: { bedrock: { operationCode: "NTE-2222" } } }),
        evidence("e3", "SETTLEMENT_MATCH", { result: "PAYER_MISMATCH", line: { operationCode: "NTE-3333", amount: 999 } }),
      ],
      actions: [],
      approvals: [],
    };
    expect(caseFactsOf(file)).toEqual([]);
  });
});
