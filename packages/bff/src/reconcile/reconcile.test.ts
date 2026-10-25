import { createHash } from "node:crypto";
import { type Operation, type SettlementBatch, type SettlementLine, formatSettlementCsv } from "@reclamo/core-contract";
import { ToolError } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { evidence, testConnector } from "../connector/testing";
import type { CoreClient } from "../core/client";
import { createSettlementFileReader } from "../networks/settlement-files";
import { testLog } from "../receipts/testing";
import { candidateBusinessDates, decideMovement } from "./decide";
import { type ReconcileRequest, reconcilePayment } from "./service";

type EvidenceDetails = NonNullable<Parameters<typeof evidence>[1]>["details"];

const SIM_NOW = new Date("2026-10-08T10:00:00-03:00");
const CODE = "NTE-20261006-004817-2";
const READING = { network: "NORTE", operationCode: CODE, amount: 11_864_000, paidAtLocal: "2026-10-06T18:40", payerReference: "cus-0001" };

function line(overrides: Partial<SettlementLine> = {}): SettlementLine {
  return { network: "NORTE", businessDate: "2026-10-07", operationCode: CODE, paidAt: "2026-10-06T18:40:00-03:00", amount: 11_864_000, customerRef: "cus-0001", loanRef: "L-0001", instalment: 4, terminal: "T-0412", ...overrides };
}

const OTHER_PAYER = line({ operationCode: "NTE-20261007-912345-3", customerRef: "cus-9001", loanRef: "L-9001", paidAt: "2026-10-06T11:47:00-03:00", amount: 5_000_000 });

interface World {
  readonly batches: SettlementBatch[];
  readonly files: Map<string, Uint8Array>;
  applied?: { network: "NORTE" | "SUR" | "WALLET" | "TRANSFER"; operationCode: string; appliedAtSim: string }[];
  operations?: Operation[];
}

function published(businessDate: string, batchLines: SettlementLine[], world: World, tamper = false): SettlementBatch {
  const lines = batchLines.map((entry) => ({ ...entry, businessDate }));
  const bytes = new TextEncoder().encode(formatSettlementCsv(lines));
  const s3Key = `W/demo/NORTE/${businessDate}/batch-1.csv`;
  world.files.set(s3Key, tamper ? new TextEncoder().encode(formatSettlementCsv([...lines, { ...OTHER_PAYER, businessDate }])) : bytes);
  return { network: "NORTE", businessDate, status: "PUBLISHED", publishAtSim: `${businessDate}T08:30:00-03:00`, publishedAtSim: `${businessDate}T08:30:00-03:00`, s3Key, lineCount: lines.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function pending(businessDate: string): SettlementBatch {
  return { network: "NORTE", businessDate, status: "PENDING", publishAtSim: `${businessDate}T08:30:00-03:00` };
}

function fakeCore(world: World): CoreClient {
  const call = async (operation: string, _ctx: unknown, input: { params: Record<string, string> }) => {
    if (operation === "getCustomer") return { customerId: input.params.customerId, loans: [{ loanId: "L-0001", label: "Préstamo", status: "ACTIVE", outstanding: 1 }] };
    if (operation === "listInstalments") {
      const payments = (world.applied ?? []).map((payment, index) => ({ paymentId: `pay-${index}`, ...payment, amount: 11_864_000, paidAtSim: "2026-10-06T18:40:00-03:00" }));
      return { loanId: input.params.loanId, customerId: "cus-0001", instalments: [{ number: 4, payments }] };
    }
    if (operation === "listOperations") return { customerId: "cus-0001", from: "x", to: "y", operations: world.operations ?? [], truncated: false };
    throw new Error(`unexpected ${operation}`);
  };
  return { call: call as unknown as CoreClient["call"], health: async () => ({ status: "ok" }) as never };
}

async function setup(world: World, reading: EvidenceDetails = { result: "READ", source: "BOTH_AGREE", fields: READING }) {
  const mc = testConnector();
  await mc.connector.caseItems.putEvidence(evidence("demo", { complaintId: "cmp-0001", evidenceId: "evd-rdg-1", kind: "RECEIPT_READING", refId: "rdg-1", details: reading }));
  const s3 = { send: async (command: { input: { Key?: string } }) => ({ ContentLength: world.files.get(command.input.Key ?? "")?.length ?? 0, Body: { transformToByteArray: async () => world.files.get(command.input.Key ?? "") ?? new Uint8Array() } }) };
  const { log, lines } = testLog();
  const deps = {
    connector: mc.connector,
    core: fakeCore(world),
    network: { listSettlements: async () => ({ network: "NORTE" as const, batches: world.batches }) },
    readFile: createSettlementFileReader({ s3: s3 as never, bucket: "settlements" }),
    now: () => new Date("2026-10-08T13:00:00.000Z"),
    log,
    newId: () => "r1",
  };
  const request: ReconcileRequest = { worldId: "demo", epoch: 1, complaintId: "cmp-0001", customerId: "cus-0001", source: "SETTLEMENT", readingId: "rdg-1", simNow: SIM_NOW, actor: "AGENT", turnId: "turn-1" };
  return { mc, deps, request, lines };
}

const newWorld = (): World => ({ batches: [], files: new Map() });

describe("reconciliation against the published settlement files", () => {
  it("[FL-016] MATCHED: same code, amount and date, line of the session's customer and loan", async () => {
    const world = newWorld();
    world.batches.push(published("2026-10-07", [OTHER_PAYER, line()], world));
    const { mc, deps, request } = await setup(world);
    const response = await reconcilePayment(deps, request);
    expect(response).toMatchObject({ result: "MATCHED", reconciliationId: "rcn-r1", evidenceId: "evd-rcn-r1" });
    const stored = await mc.connector.caseItems.getEvidence("demo", "cmp-0001", "evd-rcn-r1");
    expect(stored).toMatchObject({ kind: "SETTLEMENT_MATCH", refId: "rcn-r1", details: { result: "MATCHED", line: { customerRef: "cus-0001", loanRef: "L-0001", batchSha256: world.batches[0]?.sha256 } } });
  });

  it("[FL-111] PAYER_MISMATCH: the code is in a line of ANOTHER customer; nothing of the other payer goes out, audited", async () => {
    const world = newWorld();
    world.batches.push(published("2026-10-07", [line({ customerRef: "cus-9001", loanRef: "L-9001" })], world));
    const { mc, deps, request, lines } = await setup(world);
    const response = await reconcilePayment(deps, request);
    expect(response.result).toBe("PAYER_MISMATCH");
    const stored = await mc.connector.caseItems.getEvidence("demo", "cmp-0001", "evd-rcn-r1");
    expect(JSON.stringify(stored)).not.toContain("cus-9001");
    expect(JSON.stringify(stored)).not.toContain("L-9001");
    expect(JSON.stringify(response)).not.toContain("cus-9001");
    const audit = await mc.connector.audit.listByAction("demo", "PAYER_MISMATCH");
    expect(audit[0]).toMatchObject({ actor: "AGENT", outcome: "RECEIPT_DOUBT", refs: { complaintId: "cmp-0001", reconciliationId: "rcn-r1" } });
    expect(JSON.stringify(audit)).not.toContain("cus-9001");
    expect(lines().some((entry) => entry.metric === "PayerMismatch")).toBe(true);
  });

  it("[FL-111] PAYER_MISMATCH too when the customer is his but the loan is not, and whatever the amount", async () => {
    const world = newWorld();
    world.batches.push(published("2026-10-07", [line({ loanRef: "L-9002" })], world));
    expect((await reconcilePayment((await setup(world)).deps, (await setup(world)).request)).result).toBe("PAYER_MISMATCH");
    const other = newWorld();
    other.batches.push(published("2026-10-07", [line({ customerRef: "cus-9001", loanRef: "L-9001", amount: 1_000 })], other));
    const { deps, request } = await setup(other);
    expect((await reconcilePayment(deps, request)).result).toBe("PAYER_MISMATCH");
  });

  it("[FL-022] ALREADY_APPLIED: the code is applied to THIS customer, with its date", async () => {
    const world = newWorld();
    world.applied = [{ network: "NORTE", operationCode: CODE, appliedAtSim: "2026-10-07T09:00:00-03:00" }];
    world.batches.push(published("2026-10-07", [line()], world));
    const { deps, request } = await setup(world);
    expect((await reconcilePayment(deps, request)).decision).toMatchObject({ result: "ALREADY_APPLIED", appliedAtSim: "2026-10-07T09:00:00-03:00", loanId: "L-0001" });
  });

  it("[FL-017] PENDING_BATCH: a possible batch is still pending and no published line matches", async () => {
    const world = newWorld();
    world.batches.push(pending("2026-10-07"), published("2026-10-08", [OTHER_PAYER], world));
    const { deps, request } = await setup(world);
    expect((await reconcilePayment(deps, request)).decision).toMatchObject({ result: "PENDING_BATCH", pending: { network: "NORTE", businessDate: "2026-10-07", publishAtSim: "2026-10-07T08:30:00-03:00" } });
  });

  it("[FL-018] NOT_FOUND: every possible batch is published and no line has the code; the batches reviewed are kept", async () => {
    const world = newWorld();
    world.batches.push(published("2026-10-06", [OTHER_PAYER], world), published("2026-10-07", [OTHER_PAYER], world));
    const { mc, deps, request } = await setup(world);
    const response = await reconcilePayment(deps, request);
    expect(response.result).toBe("NOT_FOUND");
    expect((await mc.connector.caseItems.getEvidence("demo", "cmp-0001", "evd-rcn-r1"))?.details).toMatchObject({ reviewed: [{ businessDate: "2026-10-06", status: "PUBLISHED" }, { businessDate: "2026-10-07", status: "PUBLISHED" }] });
  });

  it("AMOUNT_MISMATCH: the code is in the customer's own line with another amount", async () => {
    const world = newWorld();
    world.batches.push(published("2026-10-07", [line({ amount: 11_000_000 })], world));
    const { deps, request } = await setup(world);
    expect((await reconcilePayment(deps, request)).result).toBe("AMOUNT_MISMATCH");
  });

  it("[FL-111] a SETTLEMENT reconciliation needs the readingId of a READ reading", async () => {
    const { deps, request } = await setup(newWorld());
    const { readingId: _unused, ...withoutReading } = request;
    await expect(reconcilePayment(deps, withoutReading)).rejects.toMatchObject({ code: "INVALID" });
    const unreadable = await setup(newWorld(), { result: "UNREADABLE", source: "BEDROCK" });
    await expect(reconcilePayment(unreadable.deps, unreadable.request)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
    await expect(reconcilePayment(deps, { ...request, readingId: "rdg-404" })).rejects.toBeInstanceOf(ToolError);
  });

  it("[FL-018] a file that is not the one the network published proves nothing: UNAVAILABLE, never NOT_FOUND", async () => {
    const world = newWorld();
    world.batches.push(published("2026-10-07", [line()], world, true));
    const { mc, deps, request } = await setup(world);
    await expect(reconcilePayment(deps, request)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await mc.connector.caseItems.getEvidence("demo", "cmp-0001", "evd-rcn-r1")).toBeUndefined();
  });

  it("[FL-017] looks at the receipt's date (or the next business day) and the business day after it", () => {
    expect(candidateBusinessDates("2026-10-06T18:40", [])).toEqual(["2026-10-06", "2026-10-07"]);
    // Saturday 10/10 and the holiday on Monday 12/10: the payment settles on Tuesday 13/10.
    expect(candidateBusinessDates("2026-10-10T09:00", ["2026-10-12"])).toEqual(["2026-10-13"]);
    expect(candidateBusinessDates("2026-10-09T17:00", ["2026-10-12"])).toEqual(["2026-10-09", "2026-10-13"]);
  });
});

describe("wallet and transfer payments [FL-026]", () => {
  const debit: Operation = { operationId: "mvp-0015-01", kind: "PAYMENT", atSim: "2026-10-05T08:00:00-03:00", amount: 4_500_000, direction: "OUT", description: "Pago de la cuota 5", status: "COMPLETED", ref: { loanId: "L-0001", instalment: 5 } };

  it("[FL-026] finds the customer's own wallet movement and matches it", async () => {
    const world = newWorld();
    world.operations = [debit];
    const { mc, deps, request } = await setup(world);
    const response = await reconcilePayment(deps, { ...request, source: "WALLET", movementId: "mvp-0015-01", readingId: undefined as never });
    expect(response).toMatchObject({ result: "MATCHED", source: "WALLET", decision: { movement: { operationId: "mvp-0015-01", amount: 4_500_000, loanId: "L-0001", instalment: 5 } } });
    expect((await mc.connector.caseItems.getEvidence("demo", "cmp-0001", "evd-rcn-r1"))?.details).toMatchObject({ result: "MATCHED", source: "WALLET" });
  });

  it("[FL-026] already applied, another amount, another kind or unknown movement", () => {
    const base = { source: "WALLET" as const, movementId: debit.operationId, loanIds: ["L-0001"], applied: [] };
    expect(decideMovement({ ...base, operations: [{ ...debit, ref: { ...debit.ref, paymentId: "pay-1" } }] })).toMatchObject({ result: "ALREADY_APPLIED" });
    expect(decideMovement({ ...base, operations: [debit], applied: [{ network: "WALLET", operationCode: "BIL-20261005-000123-1", loanId: "L-0001", appliedAtSim: "2026-10-06T10:00:00-03:00" }], reading: { operationCode: "BIL-20261005-000123-1", amount: 4_500_000 } })).toMatchObject({ result: "ALREADY_APPLIED", appliedAtSim: "2026-10-06T10:00:00-03:00" });
    expect(decideMovement({ ...base, operations: [debit], reading: { operationCode: "BIL-20261005-000123-1", amount: 1 } })).toMatchObject({ result: "AMOUNT_MISMATCH" });
    expect(decideMovement({ ...base, operations: [{ ...debit, kind: "TRANSFER_IN", direction: "IN" }] })).toEqual({ result: "NOT_FOUND" });
    expect(decideMovement({ ...base, operations: [{ ...debit, ref: { loanId: "L-9001" } }] })).toEqual({ result: "NOT_FOUND" });
    expect(decideMovement({ ...base, operations: [] })).toEqual({ result: "NOT_FOUND" });
  });

  it("[FL-026] a wallet reconciliation needs the movement", async () => {
    const { deps, request } = await setup(newWorld());
    await expect(reconcilePayment(deps, { ...request, source: "WALLET" })).rejects.toMatchObject({ code: "INVALID" });
  });
});
