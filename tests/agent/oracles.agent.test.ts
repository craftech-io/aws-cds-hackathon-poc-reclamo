// The standing oracles of support/oracles.ts that read a conversation without a model: what they flag
// and what they accept. Model-free, so it runs on scripted runs too.
import type { LocalTurn } from "@craftech/agent-testkit";
import { describe, expect, it } from "vitest";
import { falseOnTimeClaims, latePaidInstalments, operationsWindowDays } from "./support/oracles";

type Call = LocalTurn["calls"][number];

const call = (name: string, input: Record<string, unknown>, output: unknown): Call => ({ toolUseId: `tu-${name}`, name, input, status: "success", output });

const INSTALMENTS = call("account___get_instalments", { loanId: "L-0022" }, {
  ok: true,
  loanId: "L-0022",
  instalments: [
    { number: 1, dueText: "viernes 10/07", payments: [{ appliedAtText: "jueves 09/07 10:00" }] },
    { number: 2, dueText: "lunes 10/08", payments: [{ appliedAtText: "sábado 15/08 11:20" }] },
    { number: 3, dueText: "jueves 10/09", payments: [{ appliedAtText: "jueves 10/09 09:00" }] },
  ],
});

describe("oracles of the conversation", () => {
  it("flags 'paid on time' when a read showed an instalment paid after its due date, and only then", () => {
    const turns = [{ calls: [INSTALMENTS] }];
    expect(latePaidInstalments(turns)).toEqual([2]);
    expect(falseOnTimeClaims(["Las cuotas 1, 2 y 3 están pagadas a su vencimiento, por lo que no corrió interés punitorio."], turns)).toHaveLength(1);
    expect(falseOnTimeClaims(["La cuota 2 se pagó el sábado 15/08 y su vencimiento era el lunes 10/08."], turns)).toEqual([]);
    expect(falseOnTimeClaims(["Las cuotas están pagadas a su vencimiento."], [{ calls: [] }])).toEqual([]);
    // A day-month text carries no year: a payment that reads earlier in the calendar is never flagged (no false alarm).
    const wrap = [{ calls: [call("account___get_instalments", {}, { instalments: [{ number: 6, dueText: "jueves 10/12", payments: [{ appliedAtText: "lunes 04/01 09:00" }] }] })] }];
    expect(latePaidInstalments(wrap)).toEqual([]);
  });

  it("counts the preloaded charges window and a CHARGE call without fromDate as 90 days", () => {
    const preloaded = { userText: '<event type="CUSTOMER_MESSAGE" id="e" at="2026-10-07T10:00:00-03:00"/><tool-result tool="list_operations">{}</tool-result><tool-result tool="list_operations">{}</tool-result>', calls: [] };
    expect([...operationsWindowDays([preloaded])].sort()).toEqual([30, 90]);
    const called = { userText: "", calls: [call("account___list_operations", { kind: "CHARGE", toDate: "2026-10-07" }, { ok: true })] };
    expect([...operationsWindowDays([called])]).toEqual([90]);
  });
});
