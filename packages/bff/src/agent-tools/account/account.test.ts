import { describe, expect, it } from "vitest";
import { INSTALMENT_STATUS_TEXT, LOAN_STATUS_TEXT } from "../../copy";
import { isCollection } from "../../channel-policy/collection-lexicon";
import type { CustomerSpec } from "@reclamo/core-mock/ledger/testing";
import { gatewayContext } from "../common/principal";
import { OTHER_CUSTOMER, workerCaller } from "../common/testing";
import { createAccountTarget } from "./target";
import { CUSTOMER, WORLD, codeOf, monthlyInstalments, okOf, targetsKit } from "./testing";

const LOANS = [
  { loanId: "L-0001", principal: 60_000_000, instalments: monthlyInstalments(), payments: [] },
  { loanId: "L-0002", principal: 20_000_000, instalments: monthlyInstalments(3, 7_500_000) },
];

function customer(overrides: Partial<CustomerSpec> = {}): CustomerSpec {
  return {
    customerId: CUSTOMER,
    balance: 1_250_000,
    loans: LOANS,
    movements: [
      { movementId: "mov-pay-1", kind: "PAYMENT", atSim: "2026-10-05T09:00:00-03:00", amount: 11_864_000, ref: { loanId: "L-0001", instalment: 3 } },
      { movementId: "mov-chg-1", kind: "CHARGE", atSim: "2026-09-20T09:00:00-03:00", amount: 250_000, ref: { chargeId: "CHG-1" } },
      { movementId: "mov-old", kind: "TRANSFER_IN", atSim: "2026-06-01T09:00:00-03:00", amount: 1_000_000, ref: { transferId: "TRF-OLD" } },
    ],
    ...overrides,
  };
}

async function setup(customers: readonly CustomerSpec[] = [customer()]) {
  const kit = await targetsKit(customers);
  const account = createAccountTarget(kit.toolDeps, { core: kit.core });
  const call = (tool: string, input: Record<string, unknown>) => account.handle(input, gatewayContext(`account___${tool}`));
  await kit.identify();
  const turn = await kit.openTurn();
  return { kit, account, call, token: turn.token };
}


describe("[FL-005] customer with two loans", () => {
  it("[FL-005] get_account lists both loans with their outstanding amount as text, and nothing personal in clear", async () => {
    const { call, token } = await setup();
    const answer = okOf(await call("get_account", { sessionToken: token }));
    expect(answer["loans"]).toEqual([
      expect.objectContaining({ loanId: "L-0001", status: "IN_ARREARS", label: "Préstamo L-0001", outstanding: expect.objectContaining({ text: expect.stringMatching(/^\$ /) }) }),
      expect.objectContaining({ loanId: "L-0002" }),
    ]);
    expect(answer).toMatchObject({ account: { status: "ACTIVE", emailMasked: expect.stringContaining("***") }, wallet: { balance: { amount: 12_500, text: "$ 12.500,00" }, cvuMasked: "•••• 0001", outgoingFrozen: false } });
    expect(JSON.stringify(answer)).not.toMatch(/\+549|liveE164|9990000/);
  });

  it("[FL-064] every loan and instalment status comes with its neutral statusText of copy/, which reads as service on WhatsApp", async () => {
    const { call, token } = await setup();
    const account = okOf(await call("get_account", { sessionToken: token }));
    expect((account["loans"] as Record<string, unknown>[])[0]).toMatchObject({ status: "IN_ARREARS", statusText: LOAN_STATUS_TEXT.IN_ARREARS });
    expect(okOf(await call("get_loan", { sessionToken: token, loanId: "L-0001" }))).toMatchObject({ loan: { status: "IN_ARREARS", statusText: LOAN_STATUS_TEXT.IN_ARREARS } });
    const instalments = okOf(await call("get_instalments", { sessionToken: token, loanId: "L-0001" }))["instalments"] as Record<string, unknown>[];
    for (const instalment of instalments) expect(instalment["statusText"]).toBe(INSTALMENT_STATUS_TEXT[instalment["status"] as keyof typeof INSTALMENT_STATUS_TEXT]);
    for (const text of [...Object.values(LOAN_STATUS_TEXT), ...Object.values(INSTALMENT_STATUS_TEXT)]) expect(isCollection(`Tu cuota 3 está ${text}.`), text).toBe(false);
  });

  it("[FL-005] get_loan and get_instalments read either loan of the customer; a loan of someone else is FORBIDDEN and audited", async () => {
    const other: CustomerSpec = { customerId: OTHER_CUSTOMER, phoneHash: "b".repeat(64), loans: [{ loanId: "L-0099", principal: 10_000_000, instalments: monthlyInstalments(3) }] };
    const { kit, call, token } = await setup([customer(), other]);
    expect(okOf(await call("get_loan", { sessionToken: token, loanId: "L-0002" }))).toMatchObject({ loan: { loanId: "L-0002", instalmentsCount: 3, nextDue: { dueText: expect.any(String) } } });
    const instalments = okOf(await call("get_instalments", { sessionToken: token, loanId: "L-0001" }));
    expect((instalments["instalments"] as unknown[]).at(2)).toMatchObject({ number: 3, dueText: "lunes 05/10", amount: { text: "$ 118.640,00" } });
    expect(codeOf(await call("get_loan", { sessionToken: token, loanId: "L-0099" }))).toBe("FORBIDDEN");
    expect(codeOf(await call("get_instalments", { sessionToken: token, loanId: "L-0099" }))).toBe("FORBIDDEN");
    const denied = (await kit.auditRows()).filter((row) => row.action === "DENY");
    expect(denied).toHaveLength(2);
    expect(denied.map((row) => `${row.ruleIds?.join(",")}:${row.refs["deniedTool"]}`).sort()).toEqual(["LAM-SCOPE:GET_INSTALMENTS", "LAM-SCOPE:GET_LOAN"]);
  });

  it("[FL-005] list_operations: the last 30 days by default, newest first, with dates as text and the core's description escaped", async () => {
    const { call, token } = await setup();
    const answer = okOf(await call("list_operations", { sessionToken: token }));
    const operations = answer["operations"] as Array<Record<string, unknown>>;
    expect(operations.map((operation) => operation["operationId"])).toEqual(["mov-pay-1", "mov-chg-1"]);
    expect(operations[0]).toMatchObject({ kind: "PAYMENT", atText: "lunes 05/10 09:00", amount: { text: "$ 118.640,00" }, ref: { loanId: "L-0001", instalment: 3 } });
    expect(answer["truncated"]).toBe(false);
    expect(okOf(await call("list_operations", { sessionToken: token, fromDate: "2026-07-15", kind: "TRANSFER_IN" }))["operations"]).toEqual([]);
    expect(okOf(await call("list_operations", { sessionToken: token, fromDate: "2026-07-10" }))["operations"]).toHaveLength(2);
  });

  it("[FL-032] list_operations of kind CHARGE without fromDate covers 90 days: a disputed charge older than 30 days is listed", async () => {
    const old = { movementId: "mov-chg-old", kind: "CHARGE" as const, atSim: "2026-08-15T09:00:00-03:00", amount: 180_000, ref: { chargeId: "CHG-OLD" } };
    const { call, token } = await setup([customer({ movements: [...customer().movements ?? [], old] })]);
    const charges = okOf(await call("list_operations", { sessionToken: token, kind: "CHARGE", toDate: "2026-10-07" }));
    expect((charges["operations"] as Array<Record<string, unknown>>).map((operation) => operation["operationId"])).toEqual(["mov-chg-1", "mov-chg-old"]);
    expect(charges["fromText"]).toBe("jueves 09/07");
    const all = okOf(await call("list_operations", { sessionToken: token }));
    expect((all["operations"] as Array<Record<string, unknown>>).map((operation) => operation["operationId"])).not.toContain("mov-chg-old");
  });

  it("[FL-005] list_operations refuses more than 90 days, a reversed range and an unknown kind", async () => {
    const { call, token } = await setup();
    expect(codeOf(await call("list_operations", { sessionToken: token, fromDate: "2026-06-01", toDate: "2026-10-07" }))).toBe("INVALID");
    expect(codeOf(await call("list_operations", { sessionToken: token, fromDate: "2026-10-07", toDate: "2026-10-01" }))).toBe("INVALID");
    expect(codeOf(await call("list_operations", { sessionToken: token, kind: "CREDIT_OFFER" }))).toBe("INVALID");
  });

  it("[FL-005] returns at most 50 operations and says it truncated", async () => {
    const movements = Array.from({ length: 60 }, (_, index) => ({ movementId: `mov-${index}`, kind: "DEBIT" as const, atSim: `2026-10-0${1 + (index % 6)}T${String(8 + Math.floor(index / 6)).padStart(2, "0")}:00:00-03:00`, amount: 1_000 }));
    const { call, token } = await setup([customer({ movements })]);
    const answer = okOf(await call("list_operations", { sessionToken: token }));
    expect(answer["operations"]).toHaveLength(50);
    expect(answer["truncated"]).toBe(true);
  });

  it("[FL-005] the worker preloads get_account and list_operations with the same fences", async () => {
    const { kit, account, token } = await setup();
    expect(okOf(await account.invoke("get_account", { sessionToken: token }, workerCaller()))).toHaveProperty("loans");
    expect(okOf(await account.invoke("list_operations", { sessionToken: token }, workerCaller()))).toHaveProperty("operations");
    expect(codeOf(await account.invoke("get_loan", { sessionToken: token, loanId: "L-0001" }, workerCaller()))).toBe("FORBIDDEN");
    expect((await kit.connector.sessions.listTurnResults(WORLD, (await kit.connector.sessions.getSession(WORLD, token.split(".")[1] ?? ""))?.turnId ?? "")).map((row) => row.tool)).toEqual(["get_account", "list_operations"]);
  });

  it("[FL-005] quote_early_payoff answers the core's quote with its breakdown and audits it", async () => {
    const { kit, call, token } = await setup();
    const quote = okOf(await call("quote_early_payoff", { sessionToken: token, loanId: "L-0001" }));
    expect(quote).toMatchObject({ loanId: "L-0001", total: { text: expect.stringMatching(/^\$ /) }, breakdown: { principal: expect.any(Object), accruedInterest: expect.any(Object), fee: expect.any(Object) }, validUntilText: expect.any(String) });
    expect((await kit.auditRows()).find((row) => row.action === "QUOTE_EARLY_PAYOFF")).toMatchObject({ outcome: "QUOTED", refs: { loanId: "L-0001", quoteId: quote["quoteId"] } });
  });

  it("[FL-005] every account read but get_terms needs the customer identified", async () => {
    const kit = await targetsKit([customer()]);
    const account = createAccountTarget(kit.toolDeps, { core: kit.core });
    const turn = await kit.openTurn();
    for (const [tool, input] of [["get_account", {}], ["list_operations", {}], ["get_loan", { loanId: "L-0001" }], ["get_instalments", { loanId: "L-0001" }], ["get_fee_rules", {}], ["quote_early_payoff", { loanId: "L-0001" }]] as const) {
      expect(codeOf(await account.handle({ sessionToken: turn.token, ...input }, gatewayContext(`account___${tool}`))), tool).toBe("NOT_IDENTIFIED");
    }
    // Only the ownership reads of LAM-SCOPE reached the core: no quote was asked.
    expect(kit.coreCalls.filter((path) => path.startsWith("POST"))).toEqual([]);
  });
});

describe("[FL-051] blocked account: category and human verification", () => {
  it("[FL-051] get_account shows BLOCKED with its category and the fixed text of copy/, never an internal detail", async () => {
    const { call, token } = await setup([customer({ accountStatus: "BLOCKED", blockCategory: "IDENTITY_VALIDATION" })]);
    const answer = okOf(await call("get_account", { sessionToken: token }));
    expect(answer["account"]).toEqual({
      status: "BLOCKED",
      blockReason: { category: "IDENTITY_VALIDATION", text: expect.stringContaining("validar tu identidad") },
      emailMasked: expect.any(String),
    });
  });

  it("[FL-051] no account tool offers a way to unblock: the target declares only reads and the quote", async () => {
    const { account } = await setup();
    expect(account.target).toBe("account");
    const { ACCOUNT_TOOLS } = await import("./schema");
    expect(Object.keys(ACCOUNT_TOOLS).filter((tool) => /unblock|unlock|unfreeze/i.test(tool))).toEqual([]);
  });
});

describe("[FL-030] [FL-052] the account reads a complaint is resolved on", () => {
  it("[FL-030] [FL-052] get_loan and quote_early_payoff leave their facts as evidence on the complaint of the turn; without one, nothing", async () => {
    const kit = await targetsKit([customer()]);
    const account = createAccountTarget(kit.toolDeps, { core: kit.core });
    const call = (tool: string, input: Record<string, unknown>) => account.handle(input, gatewayContext(`account___${tool}`));
    await kit.identify();
    const bare = await kit.openTurn();
    okOf(await call("get_loan", { sessionToken: bare.token, loanId: "L-0002" }));
    const complaint = await kit.addComplaint({ type: "CLOSURE_OR_EARLY_PAYOFF" });
    expect(await kit.connector.caseItems.listEvidence(WORLD, complaint.complaintId)).toEqual([]);

    const { token } = await kit.openTurn({ complaintIds: [complaint.complaintId] });
    okOf(await call("get_loan", { sessionToken: token, loanId: "L-0002" }));
    okOf(await call("quote_early_payoff", { sessionToken: token, loanId: "L-0002" }));
    const evidence = await kit.connector.caseItems.listEvidence(WORLD, complaint.complaintId);
    expect(evidence.map((item) => item.kind).sort()).toEqual(["LOAN_STATUS", "PAYOFF_QUOTE"]);
    expect(evidence.find((item) => item.kind === "LOAN_STATUS")?.details).toMatchObject({ loanId: "L-0002", status: expect.any(String), outstandingCents: expect.any(Number) });
    expect(evidence.find((item) => item.kind === "PAYOFF_QUOTE")?.details).toMatchObject({ loanId: "L-0002", totalCents: expect.any(Number) });
  });
});
