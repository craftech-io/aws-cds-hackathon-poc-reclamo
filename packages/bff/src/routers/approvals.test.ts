import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import type { StaffRole } from "@reclamo/shared";
import { AUTH_REASON } from "../auth/errors";
import { claimsOf, createTestDeps, staffRow } from "../auth/testing";
import { complaintsKit } from "../complaints/testing";
import { SIM_NOW, TEST_NOW, approval, complaint } from "../connector/testing";
import { createEnqueuer } from "../worker/enqueue";
import { type OperationsServices, bindOperations } from "./inbox";
import { approvalsRouter } from "./approvals";
import { createContextFactory, router } from "./trpc";

const PEOPLE = {
  operator: { staffId: "stf-operator-01", role: "OPERATOR" },
  supervisor: { staffId: "stf-supervisor-01", role: "SUPERVISOR" },
} as const satisfies Record<string, { staffId: string; role: StaffRole }>;

async function approvalsWorld() {
  const kit = complaintsKit({ worldId: "demo" });
  await kit.seedWorld();
  await kit.connector.runtime.putClock({ worldId: "demo", mode: "PAUSED", pausedSimNow: SIM_NOW, worldEpoch: 1 });
  const sent: SendMessageCommandInput[] = [];
  let next = 0;
  const services: OperationsServices = {
    data: kit.connector,
    chains: () => kit.deps,
    enqueuer: (log) => createEnqueuer({ data: kit.connector, send: async (input) => void sent.push(input), queueUrl: (queue) => `https://sqs.us-east-1.amazonaws.com/776805327629/${queue}`, now: () => TEST_NOW, log }),
    core: () => ({ call: async () => Promise.reject(new Error("approving never reads the core")) }),
    images: () => ({ get: async () => undefined }),
    presignMedia: async (key) => `https://media.invalid/${key}`,
    newId: (prefix) => `${prefix}-${String(++next).padStart(4, "0")}`,
  };
  const { issuer, directory, deps } = createTestDeps();
  directory.setWorld("demo", "READY", 1);
  for (const [name, person] of Object.entries(PEOPLE)) directory.putStaff(staffRow("demo", person.staffId, person.role, `sub-${name}`));
  bindOperations(deps, services);
  const contextFor = createContextFactory(() => deps);
  const as = async (name: keyof typeof PEOPLE, signedInSecondsAgo = 0) => {
    const now = Math.floor(Date.now() / 1000);
    const token = issuer.idToken({ sub: `sub-${name}`, ...claimsOf({ worldId: "demo", ...PEOPLE[name] }, name), auth_time: now - signedInSecondsAgo, iat: now });
    return router({ approvals: approvalsRouter }).createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}` } } }));
  };
  await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo", { status: "AWAITING_APPROVAL" }))]);
  /** A pending approval of `cmp-0001` (operator tier, $ 300.000 by default). */
  const request = (overrides: Parameters<typeof approval>[1] = {}) => kit.connector.caseItems.createApproval(approval("demo", overrides));
  const read = (approvalId = "apr-0001") => kit.connector.caseItems.getApproval("demo", "cmp-0001", approvalId);
  const events = () => sent.map((input) => ({ queue: input.QueueUrl?.split("/").pop(), group: input.MessageGroupId, dedup: input.MessageDeduplicationId, body: JSON.parse(input.MessageBody ?? "{}") as Record<string, unknown> }));
  const audit = (action: string) => kit.connector.audit.listByAction("demo", action);
  return { kit, as, request, read, events, audit };
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

const DECIDE = { complaintId: "cmp-0001", approvalId: "apr-0001" } as const;

describe("approvals in the console [FL-024] [FL-087]", () => {
  it("[FL-024] lists the agent's pending requests with the amount, the cap it went over, the expiry and who may decide", async () => {
    const { as, request } = await approvalsWorld();
    await request();
    await request({ approvalId: "apr-0002", action: "REVERSE_CHARGE", amountCents: 21_200_000, capTier: "SUPERVISOR" });
    const { items } = await (await as("operator")).approvals.list();
    expect(items.map((item) => [item.approvalId, item.capTier, item.decidableByMe])).toEqual([
      ["apr-0001", "OPERATOR", true],
      ["apr-0002", "SUPERVISOR", false],
    ]);
    expect(items[0]).toMatchObject({ complaintNumber: "R-2026-000123", customerId: "cus-0001", amount: { amount: 300_000, text: "$ 300.000,00" }, capExceeded: { tier: "AGENT" }, expiresText: "viernes 09/10", lapsed: false, requestedBy: "AGENT" });
    expect((await (await as("supervisor")).approvals.list()).items.every((item) => item.decidableByMe)).toBe(true);
  });

  it("[FL-024] [FL-087] an operator with a recent sign-in approves; the console only enqueues APPROVAL_DECIDED with the approval's locator", async () => {
    const { as, read, events, audit, kit } = await approvalsWorld();
    await kit.connector.caseItems.createApproval(approval("demo"));
    const result = await (await as("operator")).approvals.decide({ ...DECIDE, decision: "APPROVED" });
    expect(result).toMatchObject({ decision: "APPROVED", replay: false, eventId: "evt-apr-apr-0001" });
    expect(await read()).toMatchObject({ decision: "APPROVED", decidedBy: "stf-operator-01", decidedAtSim: new Date(SIM_NOW).toISOString() });
    expect((await read())?.executedAt).toBeUndefined();
    expect(events()).toEqual([
      {
        queue: "CustomerEvents",
        group: "demo#cus-0001",
        dedup: "evt-apr-apr-0001",
        body: expect.objectContaining({ type: "APPROVAL_DECIDED", worldId: "demo", customerId: "cus-0001", epoch: 1, payload: { approvalId: "apr-0001", complaintId: "cmp-0001" } }),
      },
    ]);
    expect(await audit("APPROVED")).toEqual([expect.objectContaining({ actor: "OPERATOR:stf-operator-01", outcome: "APPROVED", refs: expect.objectContaining({ approvalId: "apr-0001", staffId: "stf-operator-01" }) })]);
    // The console moves no money: no action, no execution.
    const file = await kit.connector.caseItems.caseFile("demo", "cmp-0001");
    expect([file.actions, file.executions]).toEqual([[], []]);
  });

  it("[FL-087] a sign-in older than 15 minutes is refused (the console asks for the password) and nothing changes", async () => {
    const { as, request, read, events } = await approvalsWorld();
    await request();
    expect(await refusal(async () => (await as("operator", 20 * 60)).approvals.decide({ ...DECIDE, decision: "APPROVED" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.LOGIN_NOT_RECENT });
    expect((await read())?.decision).toBe("PENDING");
    expect(events()).toEqual([]);
  });

  it("[FL-087] decides once: asking again re-enqueues the same event, anyone else gets a conflict", async () => {
    const { as, request, events } = await approvalsWorld();
    await request();
    const operator = await as("operator");
    await operator.approvals.decide({ ...DECIDE, decision: "APPROVED" });
    expect(await operator.approvals.decide({ ...DECIDE, decision: "APPROVED" })).toMatchObject({ replay: true, eventId: "evt-apr-apr-0001" });
    expect(new Set(events().map((event) => event.dedup))).toEqual(new Set(["evt-apr-apr-0001"]));
    expect(await refusal(async () => (await as("supervisor")).approvals.decide({ ...DECIDE, decision: "REJECTED", reason: "Corresponde" }))).toEqual({ code: "CONFLICT", reason: "NOT_PENDING" });
  });

  it("[FL-087] an expired approval, or one of an earlier epoch, cannot be decided", async () => {
    const { as, request } = await approvalsWorld();
    await request({ expiresAtSim: "2026-10-07T10:00:00-03:00" });
    await request({ approvalId: "apr-0002", epoch: 0 });
    const operator = await as("operator");
    expect(await refusal(() => operator.approvals.decide({ ...DECIDE, decision: "APPROVED" }))).toEqual({ code: "PRECONDITION_FAILED", reason: "EXPIRED" });
    expect(await refusal(() => operator.approvals.decide({ ...DECIDE, approvalId: "apr-0002", decision: "APPROVED" }))).toEqual({ code: "PRECONDITION_FAILED", reason: "OTHER_EPOCH" });
  });
});

describe("approval of a mischarge above the agent cap [FL-034]", () => {
  it("[FL-034] the operator approves a reversal within the operator's cap; the worker executes it from the approval", async () => {
    const { as, request, read, events } = await approvalsWorld();
    await request({ action: "REVERSE_CHARGE", amountCents: 3_890_000 });
    await (await as("operator")).approvals.decide({ ...DECIDE, decision: "APPROVED" });
    expect(await read()).toMatchObject({ decision: "APPROVED", action: "REVERSE_CHARGE", amountCents: 3_890_000 });
    expect(events().map((event) => event.body["type"])).toEqual(["APPROVAL_DECIDED"]);
  });
});

describe("rejected approval [FL-035]", () => {
  it("[FL-035] a rejection with its reason sends the case back to a person, with its register entry, and moves no money", async () => {
    const { as, request, read, events, audit, kit } = await approvalsWorld();
    await request({ action: "REVERSE_CHARGE" });
    const result = await (await as("operator")).approvals.decide({ ...DECIDE, decision: "REJECTED", reason: "El cargo corresponde a un pedido del 02/09" });
    expect(result).toMatchObject({ decision: "REJECTED", status: "HUMAN_REVIEW" });
    expect(await read()).toMatchObject({ decision: "REJECTED", decidedBy: "stf-operator-01", reason: "El cargo corresponde a un pedido del 02/09" });
    const moved = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(moved).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "OTHER" } });
    expect(moved?.statusHistory.at(-1)).toMatchObject({ from: "AWAITING_APPROVAL", to: "HUMAN_REVIEW", cause: "APPROVAL_REJECTED", actor: "OPERATOR:stf-operator-01" });
    expect((await kit.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).map((entry) => [entry.eventType, entry.status])).toEqual([["STATUS", "HUMAN_REVIEW"]]);
    expect(await audit("REJECTED")).toHaveLength(1);
    expect(events()).toEqual([]);
  });

  it("[FL-035] a rejection without a reason is refused before anything is read", async () => {
    const { as, request, read } = await approvalsWorld();
    await request();
    expect(await refusal(async () => (await as("operator")).approvals.decide({ ...DECIDE, decision: "REJECTED" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect((await read())?.decision).toBe("PENDING");
  });
});

describe("amount above the operator cap: only a supervisor [FL-036]", () => {
  it("[FL-036] the operator gets 403 with AuditLog DENY CAP_TIER; the supervisor approves", async () => {
    const { as, request, read, events, audit } = await approvalsWorld();
    await request({ action: "REVERSE_CHARGE", amountCents: 21_200_000, capTier: "SUPERVISOR" });
    expect(await refusal(async () => (await as("operator")).approvals.decide({ ...DECIDE, decision: "APPROVED" }))).toEqual({ code: "FORBIDDEN", reason: "CAP_TIER" });
    expect(await audit("DENY")).toEqual([expect.objectContaining({ outcome: "CAP_TIER", actor: "OPERATOR:stf-operator-01", refs: expect.objectContaining({ capTier: "SUPERVISOR", role: "OPERATOR" }) })]);
    expect((await read())?.decision).toBe("PENDING");
    expect(events()).toEqual([]);
    await (await as("supervisor")).approvals.decide({ ...DECIDE, decision: "APPROVED" });
    expect(await read()).toMatchObject({ decision: "APPROVED", decidedBy: "stf-supervisor-01" });
    expect(events()).toHaveLength(1);
  });

  it("[FL-036] an id of another world is refused with 403 CROSS_WORLD", async () => {
    const { as, request } = await approvalsWorld();
    await request();
    expect(await refusal(async () => (await as("supervisor")).approvals.decide({ ...DECIDE, worldId: "g02", decision: "APPROVED" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_WORLD });
  });
});
