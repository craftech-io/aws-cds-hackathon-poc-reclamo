// Numbering in the act (docs/architecture.md §8.2, ADR-0015): number, complaint, `FILED`, milestones,
// idempotency and audit in ONE transaction; correlative per world, epoch and year; no gap after a
// cancellation; a repeated event gets the same number.
import { describe, expect, it } from "vitest";
import { SIM_NOW } from "../connector/testing";
import { registerComplaint, type RegistrationInput } from "./numbering";
import { GENESIS_HASH, chainHash } from "./register";
import { TEST_CHAIN_KEY, TEST_HOLIDAYS, complaintsKit } from "./testing";

function input(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    worldId: "demo",
    customerId: "cus-0001",
    kind: "RECLAMO",
    type: "PAYMENT_NOT_REFLECTED",
    channel: "WHATSAPP",
    summary: "Pago de la cuota 4 no reflejado",
    subject: { loanId: "L-0001", instalment: 4 },
    sourceMessageId: "msg-in-0001",
    eventId: "evt-0001",
    presenter: { docType: "DNI", docNumberMasked: "••••4417" },
    filedAtSim: SIM_NOW,
    holidays: TEST_HOLIDAYS,
    actor: "SYSTEM",
    ...overrides,
  };
}

describe("registerComplaint [FL-010] [FL-014]", () => {
  it("[FL-010] gives R-2026-000001 with its FILED entry, the complaint, three milestones, the claim and the audit in one transaction", async () => {
    const transactions: number[] = [];
    const kit = complaintsKit({ beforeWrite: (ops) => void (ops.length > 1 && transactions.push(ops.length)) });
    await kit.seedWorld();
    transactions.length = 0;
    const registration = await registerComplaint(kit.deps, input());
    expect(registration.created).toBe(true);
    expect(registration.complaint).toMatchObject({ complaintNumber: "R-2026-000001", status: "REGISTERED", deadlineSim: "2026-10-22T23:59:59-03:00", origin: "LIVE", epoch: 1 });
    expect(registration.deadlineText).toBe("jueves 22/10");
    // counter + head + entry + complaint + 3 timers + idempotency + audit
    expect(transactions).toEqual([9]);
    const [filed] = await kit.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000001");
    expect(filed).toMatchObject({ eventType: "FILED", seq: 1, prevHash: GENESIS_HASH, presenter: { docType: "DNI", docNumberMasked: "••••4417" }, status: "REGISTERED" });
    expect(filed && chainHash(TEST_CHAIN_KEY, filed.prevHash, filed)).toBe(filed?.hash);
    expect(registration.filedHash).toBe(filed?.hash);
    expect(await kit.connector.counters.getComplaintCounter("demo", 1, 2026)).toBe(1);
    expect((await kit.connector.timers.listByOwner("demo", `CMP#${registration.complaint.complaintId}`)).map((timer) => timer.status)).toEqual(["SCHEDULED", "SCHEDULED", "SCHEDULED"]);
    expect(await kit.connector.claims.getIdempotency("demo", "REGISTER", "evt-0001")).toMatchObject({ result: { complaintNumber: "R-2026-000001" } });
    expect((await kit.connector.audit.listByAction("demo", "COMPLAINT_REGISTERED")).map((entry) => entry.refs.complaintNumber)).toEqual(["R-2026-000001"]);
    expect(kit.anchorRequests).toHaveLength(1);
  });

  it("[FL-010] numbers correlatively and the same event twice gets the same number back", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    const first = await registerComplaint(kit.deps, input());
    const second = await registerComplaint(kit.deps, input({ eventId: "evt-0002", type: "DUPLICATE_DEBIT", subject: {} }));
    const replay = await registerComplaint(kit.deps, input());
    expect([first.complaint.complaintNumber, second.complaint.complaintNumber]).toEqual(["R-2026-000001", "R-2026-000002"]);
    expect(replay).toMatchObject({ created: false, complaint: { complaintNumber: "R-2026-000001", complaintId: first.complaint.complaintId }, filedHash: first.filedHash });
    expect(kit.store.dump("Register")).toHaveLength(2);
  });

  it("[FL-014] two concurrent registrations get consecutive numbers and seq without a gap", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    const results = await Promise.all([registerComplaint(kit.deps, input()), registerComplaint(kit.deps, input({ eventId: "evt-0002", customerId: "cus-0002" }))]);
    expect(results.map((result) => result.complaint.complaintNumber).sort()).toEqual(["R-2026-000001", "R-2026-000002"]);
    const { entries } = await kit.connector.chains.listRegister("REG", "demo", 1);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.complaintNumber).sort()).toEqual(["R-2026-000001", "R-2026-000002"]);
  });

  it("[FL-014] a number taken by someone else after the counter was read is retried, never skipped", async () => {
    let raced = false;
    const kit = complaintsKit({
      beforeWrite: async (ops) => {
        if (raced || !ops.some((op) => op.table === "Register")) return;
        raced = true;
        await registerComplaint(kit.deps, input({ eventId: "evt-racer", customerId: "cus-0009" }));
      },
    });
    await kit.seedWorld();
    const mine = await registerComplaint(kit.deps, input());
    expect(mine.complaint.complaintNumber).toBe("R-2026-000002");
    expect(await kit.connector.counters.getComplaintCounter("demo", 1, 2026)).toBe(2);
    expect(kit.store.dump("Complaints").filter((row) => row.sk === "META")).toHaveLength(2);
  });

  it("a retry of the same event that lost the race to its own twin returns the twin's number", async () => {
    let raced = false;
    const kit = complaintsKit({
      beforeWrite: async (ops) => {
        if (raced || !ops.some((op) => op.table === "Register")) return;
        raced = true;
        await registerComplaint(kit.deps, input());
      },
    });
    await kit.seedWorld();
    const result = await registerComplaint(kit.deps, input());
    expect(result).toMatchObject({ created: false, complaint: { complaintNumber: "R-2026-000001" } });
    expect(kit.store.dump("Register")).toHaveLength(1);
  });

  it("[FL-010] takes the year from the world clock in Argentina and starts each year at 1", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    const lastOfYear = await registerComplaint(kit.deps, input({ filedAtSim: "2026-12-31T23:30:00-03:00" }));
    const firstOfYear = await registerComplaint(kit.deps, input({ eventId: "evt-0002", customerId: "cus-0002", filedAtSim: "2027-01-04T09:00:00-03:00" }));
    expect(lastOfYear.complaint.complaintNumber).toBe("R-2026-000001");
    expect(firstOfYear.complaint.complaintNumber).toBe("R-2027-000001");
  });

  it("masks the summary before it is stored and keeps a consulta as an information request", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    const registration = await registerComplaint(kit.deps, input({ summary: "Escribime a cliente.real@example.com por el pago" }));
    expect(registration.complaint.summary).not.toContain("cliente.real@example.com");
    await expect(registerComplaint(kit.deps, input({ eventId: "evt-x", kind: "CONSULTA" }))).rejects.toMatchObject({ code: "INVALID" });
    await expect(registerComplaint(kit.deps, input({ eventId: "evt-y", type: "INFORMATION_REQUEST" }))).rejects.toMatchObject({ code: "INVALID" });
    const consulta = await registerComplaint(kit.deps, input({ eventId: "evt-z", kind: "CONSULTA", type: "INFORMATION_REQUEST", subject: {} }));
    expect(consulta.complaint).toMatchObject({ kind: "CONSULTA", type: "INFORMATION_REQUEST" });
  });

  it("refuses a world without an epoch and asks the scheduler for the three milestones", async () => {
    const scheduled: string[][] = [];
    const kit = complaintsKit({ milestones: { schedule: async (_world, timers) => void scheduled.push(timers.map((timer) => timer.timerId)), cancel: async () => undefined } });
    await expect(registerComplaint(kit.deps, input())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await kit.seedWorld();
    const registration = await registerComplaint(kit.deps, input());
    const id = registration.complaint.complaintId;
    expect(scheduled).toEqual([[`${id}-OPERATOR_REMINDER`, `${id}-SUPERVISOR_ESCALATION`, `${id}-DEADLINE`]]);
  });
});
