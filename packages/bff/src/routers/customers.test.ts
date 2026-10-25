import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { coreRoutes } from "@reclamo/core-contract";
import type { StaffRole } from "@reclamo/shared";
import { AUTH_REASON } from "../auth/errors";
import { claimsOf, createTestDeps, staffRow } from "../auth/testing";
import { complaintsKit } from "../complaints/testing";
import { SIM_NOW, TEST_NOW, complaint, conversation } from "../connector/testing";
import type { CoreOperation } from "../core/client";
import { createEnqueuer } from "../worker/enqueue";
import { COMPOSE_KINDS, customersRouter } from "./customers";
import { type OperationsServices, bindOperations } from "./inbox";
import { createContextFactory, router } from "./trpc";

const PEOPLE = {
  operator: { staffId: "stf-operator-01", role: "OPERATOR" },
  compliance: { staffId: "stf-compliance-01", role: "COMPLIANCE" },
} as const satisfies Record<string, { staffId: string; role: StaffRole }>;

const INSTALMENT = { principal: 9_000_000, interest: 1_800_000, vat: 378_000, lateInterest: 0, payments: [] };

/** What the core answers for `cus-0009` (synthetic, masked as the core masks it), checked against the contract. */
const CORE_ANSWERS: Partial<Record<CoreOperation, unknown>> = {
  getCustomer: {
    customerId: "cus-0009",
    firstName: "Martín",
    lastName: "Olmedo",
    document: { type: "DNI", numberMasked: "••••4417" },
    phoneMasked: "+54 9 11 •••• 1009",
    emailMasked: "m•••@…",
    whatsapp: { optedIn: true, optedOut: false },
    account: { status: "ACTIVE" },
    wallet: { balance: 1_250_050, cvuMasked: "•••• 4821", outgoingFrozen: false },
    loans: [{ loanId: "L-0009", label: "Préstamo personal", status: "IN_ARREARS", outstanding: 32_105_000 }],
  },
  listOperations: {
    customerId: "cus-0009",
    from: "2026-08-08",
    to: "2026-10-07",
    operations: [{ operationId: "op-1", kind: "DEBIT", atSim: "2026-09-25T09:00:00-03:00", amount: 6_421_000, direction: "OUT", description: "Débito cuota 3", status: "REJECTED", ref: { loanId: "L-0009", instalment: 3 } }],
    truncated: false,
  },
  listInstalments: {
    loanId: "L-0009",
    customerId: "cus-0009",
    instalments: [1, 2, 3].map((number) => ({ ...INSTALMENT, number, dueDate: `2026-0${6 + number}-25`, amount: 11_178_000, outstanding: number === 3 ? 11_178_000 : 0, status: number === 3 ? "OVERDUE" : "PAID" })),
  },
};

async function customerWorld() {
  const kit = complaintsKit({ worldId: "demo" });
  await kit.seedWorld();
  await kit.connector.runtime.putClock({ worldId: "demo", mode: "PAUSED", pausedSimNow: SIM_NOW, worldEpoch: 1 });
  await kit.connector.transact([
    kit.connector.conversations.createOp(conversation("demo", { customerId: "cus-0009" })),
    kit.connector.complaints.createOp(complaint("demo", { complaintId: "cmp-0009", customerId: "cus-0009", status: "ANSWERED" })),
    kit.connector.complaints.createOp(complaint("demo", { complaintId: "cmp-0001", complaintNumber: "R-2026-000124" })),
  ]);
  const sent: SendMessageCommandInput[] = [];
  const coreCalls: Array<{ operation: string; simNow: string; params: unknown; query: unknown }> = [];
  let next = 0;
  const services: OperationsServices = {
    data: kit.connector,
    chains: () => kit.deps,
    enqueuer: (log) => createEnqueuer({ data: kit.connector, send: async (input) => void sent.push(input), queueUrl: (queue) => `https://sqs.us-east-1.amazonaws.com/776805327629/${queue}`, now: () => TEST_NOW, log }),
    core: () => ({
      call: async (operation, ctx, input) => {
        coreCalls.push({ operation, simNow: ctx.simNow, params: input.params, query: input.query });
        return coreRoutes[operation].ok.parse(CORE_ANSWERS[operation]) as never;
      },
    }),
    images: () => ({ get: async () => undefined }),
    presignMedia: async (key) => `https://media.invalid/${key}`,
    newId: (prefix) => `${prefix}-${String(++next).padStart(4, "0")}`,
  };
  const { issuer, directory, deps } = createTestDeps();
  directory.setWorld("demo", "READY", 1);
  for (const [name, person] of Object.entries(PEOPLE)) directory.putStaff(staffRow("demo", person.staffId, person.role, `sub-${name}`));
  bindOperations(deps, services);
  const contextFor = createContextFactory(() => deps);
  const as = async (name: keyof typeof PEOPLE) => {
    const token = issuer.idToken({ sub: `sub-${name}`, ...claimsOf({ worldId: "demo", ...PEOPLE[name] }, name) });
    return router({ customers: customersRouter }).createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}` } } }));
  };
  const events = () => sent.map((input) => JSON.parse(input.MessageBody ?? "{}") as { type: string; customerId: string; payload: Record<string, unknown> });
  return { kit, as, events, coreCalls };
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return { code: error.code, reason: error.cause && typeof error.cause === "object" ? Reflect.get(error.cause, "reason") : undefined };
  }
  throw new Error("expected a refusal");
}

describe("the customer's file", () => {
  it("reads the core at the world's simulated now (read only, masked), with this world's complaints and the challenge's standing", async () => {
    const { as, coreCalls } = await customerWorld();
    const file = await (await as("operator")).customers.get({ customerId: "cus-0009" });
    expect(file.customer).toMatchObject({ firstName: "Martín", document: { numberMasked: "••••4417" }, wallet: { balanceMoney: { amount: 12_500.5, text: "$ 12.500,50" } } });
    expect(file.customer.loans[0]).toMatchObject({ loanId: "L-0009", outstandingMoney: { text: "$ 321.050,00" }, instalments: [{ status: "PAID" }, { status: "PAID" }, { status: "OVERDUE", number: 3 }] });
    expect(file.operations).toHaveLength(1);
    expect(file.complaints).toEqual([expect.objectContaining({ complaintId: "cmp-0009", open: false, deadlineText: "jueves 22/10" })]);
    expect(file.conversation).toMatchObject({ control: "AGENT" });
    expect(file.challenge).toEqual({ locked: false, failures: 0, attemptsLeft: 2 });
    expect(file.composeKinds).toEqual(COMPOSE_KINDS);
    expect(coreCalls.map((call) => call.operation)).toEqual(["getCustomer", "listOperations", "listInstalments"]);
    expect(coreCalls[1]).toMatchObject({ simNow: new Date(SIM_NOW).toISOString(), query: { from: "2026-08-08", to: "2026-10-07" } });
  });

  it("is not for compliance, and refuses an id of another world", async () => {
    const { as } = await customerWorld();
    expect(await refusal(async () => (await as("compliance")).customers.get({ customerId: "cus-0009" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.ROLE_NOT_ALLOWED });
    expect(await refusal(async () => (await as("operator")).customers.get({ customerId: "cus-0009", worldId: "qamin" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_WORLD });
  });
});

describe("the composer [FL-064]", () => {
  it("[FL-064] enqueues the person's collection reminder by WhatsApp as it is: the gate in the worker blocks it and the tape shows it", async () => {
    const { as, events } = await customerWorld();
    const queued = await (await as("operator")).customers.compose({ customerId: "cus-0009", kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Martín, tenés la cuota 3 vencida. Regularizá hoy." });
    expect(queued).toMatchObject({ status: "QUEUED", messageId: expect.stringMatching(/^opm-/) });
    expect(events()).toEqual([
      expect.objectContaining({ type: "OPERATOR_SEND", customerId: "cus-0009", payload: expect.objectContaining({ staffId: "stf-operator-01", kind: "COLLECTION_REMINDER", channel: "WHATSAPP", messageId: queued.messageId }) }),
    ]);
  });

  it("offers every kind an operator may send except the written answer and the formal notice, on the channel the person picks", async () => {
    const { as, events } = await customerWorld();
    expect([...COMPOSE_KINDS].sort()).toEqual(["COLLECTION_REMINDER", "COMPLAINT_UPDATE", "OPERATOR_MESSAGE", "REPLY"]);
    const operator = await as("operator");
    await operator.customers.compose({ customerId: "cus-0009", kind: "COMPLAINT_UPDATE", channel: "EMAIL", text: "Hay una novedad en tu reclamo.", complaintId: "cmp-0009" });
    expect(events()[0]?.payload).toMatchObject({ kind: "COMPLAINT_UPDATE", channel: "EMAIL", complaintId: "cmp-0009" });
    for (const kind of ["FORMAL_ANSWER", "COLLECTION_NOTICE_EMAIL", "HANDOFF_NOTICE"] as const) {
      expect(await refusal(() => operator.customers.compose({ customerId: "cus-0009", kind, channel: "EMAIL", text: "x" }))).toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await refusal(() => operator.customers.compose({ customerId: "cus-0009", kind: "REPLY", channel: "WHATSAPP", text: "Hola", complaintId: "cmp-0001" }))).toEqual({ code: "FORBIDDEN", reason: "COMPLAINT_OF_ANOTHER_CUSTOMER" });
    expect(events()).toHaveLength(1);
  });
});

describe("lifting a locked identity challenge [FL-004]", () => {
  it("[FL-004] a person lifts the lock: audited CHALLENGE_UNLOCKED first, then the ledger is cleared", async () => {
    const { as, kit } = await customerWorld();
    await kit.connector.caps.recordChallengeFailure("demo", "cus-0009");
    await kit.connector.caps.lockChallenge("demo", "cus-0009");
    const operator = await as("operator");
    expect((await operator.customers.get({ customerId: "cus-0009" })).challenge).toMatchObject({ locked: true, attemptsLeft: 0 });
    expect(await operator.customers.unlockChallenge({ customerId: "cus-0009" })).toEqual({ cleared: true, wasLocked: true });
    expect(await kit.connector.caps.getChallenge("demo", "cus-0009")).toBeUndefined();
    expect(await kit.connector.audit.listByAction("demo", "CHALLENGE_UNLOCKED")).toEqual([
      expect.objectContaining({ actor: "OPERATOR:stf-operator-01", outcome: "LOCKED", primaryRef: "CUS#cus-0009", refs: expect.objectContaining({ customerId: "cus-0009", staffId: "stf-operator-01" }) }),
    ]);
    expect(await operator.customers.unlockChallenge({ customerId: "cus-0009" })).toEqual({ cleared: false, wasLocked: false });
    expect(await kit.connector.audit.listByAction("demo", "CHALLENGE_UNLOCKED")).toHaveLength(1);
  });

  it("[FL-004] compliance cannot lift it", async () => {
    const { as } = await customerWorld();
    expect(await refusal(async () => (await as("compliance")).customers.unlockChallenge({ customerId: "cus-0009" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.READ_ONLY_ROLE });
  });
});
