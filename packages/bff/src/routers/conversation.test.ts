import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import type { StaffRole } from "@reclamo/shared";
import { AUTH_REASON } from "../auth/errors";
import { claimsOf, createTestDeps, staffRow } from "../auth/testing";
import { complaintsKit } from "../complaints/testing";
import { SIM_NOW, TEST_NOW, complaint, conversation, message } from "../connector/testing";
import { createLogger } from "../lib/log";
import { appendTape } from "../outbound/tape";
import { createEnqueuer } from "../worker/enqueue";
import { consoleRerouteDeps, conversationRouter } from "./conversation";
import { type OperationsServices, bindOperations } from "./inbox";
import { createContextFactory, router } from "./trpc";

const PEOPLE = {
  operator: { staffId: "stf-operator-01", role: "OPERATOR" },
  other: { staffId: "stf-operator-02", role: "OPERATOR" },
} as const satisfies Record<string, { staffId: string; role: StaffRole }>;

const LATER = "2026-10-07T10:20:00-03:00";
const silent = createLogger({ sink: () => undefined });

async function conversationWorld() {
  const kit = complaintsKit({ worldId: "demo" });
  await kit.seedWorld();
  await kit.connector.runtime.putClock({ worldId: "demo", mode: "PAUSED", pausedSimNow: SIM_NOW, worldEpoch: 1 });
  await kit.connector.transact([
    kit.connector.conversations.createOp(conversation("demo")),
    kit.connector.complaints.createOp(complaint("demo", { status: "INVESTIGATING" })),
    kit.connector.complaints.createOp(complaint("demo", { complaintId: "cmp-0009", complaintNumber: "R-2026-000124", customerId: "cus-0009" })),
  ]);
  const sent: SendMessageCommandInput[] = [];
  let next = 0;
  const services: OperationsServices = {
    data: kit.connector,
    chains: () => kit.deps,
    enqueuer: (log) => createEnqueuer({ data: kit.connector, send: async (input) => void sent.push(input), queueUrl: (queue) => `https://sqs.us-east-1.amazonaws.com/776805327629/${queue}`, now: () => TEST_NOW, log }),
    core: () => ({ call: async () => Promise.reject(new Error("the conversation never reads the core")) }),
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
    return router({ conversation: conversationRouter }).createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}` } } }));
  };
  const events = () => sent.map((input) => JSON.parse(input.MessageBody ?? "{}") as { type: string; eventId: string; customerId: string; payload: Record<string, unknown> });
  const meta = () => kit.connector.conversations.getMeta("demo", "cus-0001");
  return { kit, as, events, meta };
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

describe("take the conversation [FL-084]", () => {
  it("[FL-084] moves control to the operator with its history, mirrors it on the open complaints and audits TAKEOVER", async () => {
    const { as, meta, kit, events } = await conversationWorld();
    expect(await (await as("operator")).conversation.take({ customerId: "cus-0001" })).toEqual({ control: "OPERATOR", already: false });
    expect(await meta()).toMatchObject({ control: "OPERATOR", controlledBy: "stf-operator-01", controlHistory: [{ from: "AGENT", to: "OPERATOR", by: "OPERATOR:stf-operator-01" }] });
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.control).toBe("OPERATOR");
    expect((await kit.connector.complaints.get("demo", "cmp-0009"))?.control).toBe("AGENT");
    expect(await kit.connector.audit.listByAction("demo", "TAKEOVER")).toEqual([expect.objectContaining({ actor: "OPERATOR:stf-operator-01", ruleIds: ["CH-CONTROL"], refs: expect.objectContaining({ customerId: "cus-0001" }) })]);
    expect(events()).toEqual([]);
  });

  it("[FL-084] taking it again is a no-op for the same person and a conflict for another", async () => {
    const { as } = await conversationWorld();
    await (await as("operator")).conversation.take({ customerId: "cus-0001" });
    expect(await (await as("operator")).conversation.take({ customerId: "cus-0001" })).toEqual({ control: "OPERATOR", already: true });
    expect(await refusal(async () => (await as("other")).conversation.take({ customerId: "cus-0001" }))).toEqual({ code: "CONFLICT", reason: "CONTROL_TAKEN" });
    expect(await refusal(async () => (await as("other")).conversation.take({ customerId: "cus-0404" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(async () => (await as("other")).conversation.take({ customerId: "cus-0001", worldId: "g07" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_WORLD });
  });
});

describe("the operator writes in the thread [FL-085]", () => {
  it("[FL-085] enqueues OPERATOR_SEND with the operator as sender; the console stores and sends nothing", async () => {
    const { as, events, kit } = await conversationWorld();
    const operator = await as("operator");
    await operator.conversation.take({ customerId: "cus-0001" });
    const queued = await operator.conversation.send({ customerId: "cus-0001", text: "Hola, soy Lucía. Ya estoy mirando tu pago.", complaintId: "cmp-0001" });
    expect(queued).toMatchObject({ status: "QUEUED", messageId: expect.stringMatching(/^opm-/) });
    expect(events()).toEqual([
      expect.objectContaining({
        type: "OPERATOR_SEND",
        customerId: "cus-0001",
        payload: { staffId: "stf-operator-01", messageId: queued.messageId, channel: "WHATSAPP", kind: "OPERATOR_MESSAGE", text: "Hola, soy Lucía. Ya estoy mirando tu pago.", complaintId: "cmp-0001" },
      }),
    ]);
    expect(await kit.connector.conversations.listMessages("demo", "cus-0001")).toEqual([]);
  });

  it("[FL-085] a template goes as a complaint update; text and template together, another customer's complaint or no body are refused", async () => {
    const { as, events } = await conversationWorld();
    const operator = await as("operator");
    await operator.conversation.send({ customerId: "cus-0001", template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"] } });
    expect(events()[0]?.payload).toMatchObject({ kind: "COMPLAINT_UPDATE", template: { name: "reclamo_novedad" } });
    expect(await refusal(() => operator.conversation.send({ customerId: "cus-0001", text: "Hola", template: { name: "reclamo_resuelto", params: ["R-2026-000123"] } }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await refusal(() => operator.conversation.send({ customerId: "cus-0001" }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await refusal(() => operator.conversation.send({ customerId: "cus-0001", text: "Hola", complaintId: "cmp-0009" }))).toEqual({ code: "FORBIDDEN", reason: "COMPLAINT_OF_ANOTHER_CUSTOMER" });
    expect(events()).toHaveLength(1);
  });
});

describe("hand back to the agent [FL-086]", () => {
  it("[FL-086] gives control back and enqueues OPERATOR_RELEASED with what the operator wrote since the take-over", async () => {
    const { as, events, meta, kit } = await conversationWorld();
    const operator = await as("operator");
    await kit.connector.conversations.putMessage(message("demo", { messageId: "msg-before", direction: "OUT", sender: "OPERATOR:stf-operator-01", status: "SENT", atSim: "2026-10-07T09:00:00-03:00" }));
    await operator.conversation.take({ customerId: "cus-0001" });
    await kit.connector.conversations.putMessage(message("demo", { messageId: "msg-op-1", direction: "OUT", sender: "OPERATOR:stf-operator-01", kind: "OPERATOR_MESSAGE", status: "SENT", atSim: LATER }));
    await kit.connector.conversations.putMessage(message("demo", { messageId: "msg-op-2", direction: "OUT", sender: "OPERATOR:stf-operator-01", kind: "COLLECTION_REMINDER", status: "BLOCKED", atSim: LATER }));
    await kit.connector.conversations.putMessage(message("demo", { messageId: "msg-in", direction: "IN", status: "RECEIVED", atSim: LATER }));
    const released = await operator.conversation.release({ customerId: "cus-0001" });
    expect(released).toEqual({ control: "AGENT", eventId: "evt-rel-cus-0001-v3", messageIds: ["msg-op-1"] });
    expect(await meta()).toMatchObject({ control: "AGENT", controlHistory: [{ to: "OPERATOR" }, { from: "OPERATOR", to: "AGENT" }] });
    expect((await meta())?.controlledBy).toBeUndefined();
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.control).toBe("AGENT");
    expect(events()).toEqual([expect.objectContaining({ type: "OPERATOR_RELEASED", eventId: "evt-rel-cus-0001-v3", payload: { staffId: "stf-operator-01", messageIds: ["msg-op-1"] } })]);
    expect(await kit.connector.audit.listByAction("demo", "RELEASE")).toHaveLength(1);
  });

  it("[FL-086] releasing a conversation the agent holds is a conflict", async () => {
    const { as, events } = await conversationWorld();
    expect(await refusal(async () => (await as("operator")).conversation.release({ customerId: "cus-0001" }))).toEqual({ code: "CONFLICT", reason: "NOT_TAKEN" });
    expect(events()).toEqual([]);
  });
});

describe("reroute of a blocked collection attempt", () => {
  async function blockedAttempt(kit: Awaited<ReturnType<typeof conversationWorld>>["kit"]) {
    return appendTape(
      { chains: kit.deps },
      { worldId: "demo", epoch: 1, atSim: SIM_NOW, decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"], ruleSetVersion: "ch-2026.10.06", sender: "OPERATOR:stf-operator-01", channel: "WHATSAPP", kind: "COLLECTION_REMINDER", customerId: "cus-0001", messageId: "opm-0100" },
      silent,
    );
  }

  it("sends a blocked message to the human queue: a task, REROUTED on the tape, nothing sent", async () => {
    const { as, kit, events } = await conversationWorld();
    const blocked = await blockedAttempt(kit);
    const result = await (await as("operator")).conversation.reroute({ tapeId: blocked.tapeId, route: "HUMAN_QUEUE", customerId: "cus-0001" });
    expect(result).toMatchObject({ decision: "REROUTED", reroutedTo: "HUMAN_QUEUE" });
    expect(await kit.connector.conversations.listTasks("demo", "cus-0001")).toEqual([expect.objectContaining({ author: "OPERATOR:stf-operator-01", task: expect.objectContaining({ status: "OPEN", route: "HUMAN_QUEUE", tapeId: blocked.tapeId }) })]);
    expect(await kit.connector.chains.listTapeByDecision("demo", "REROUTED")).toEqual([expect.objectContaining({ rerouteOf: blocked.tapeId, reroute: { route: "HUMAN_QUEUE" }, sender: "OPERATOR:stf-operator-01" })]);
    // Picked twice, it answers the first pick.
    expect(await (await as("other")).conversation.reroute({ tapeId: blocked.tapeId, route: "HUMAN_QUEUE", customerId: "cus-0001" })).toMatchObject({ decision: "REROUTED", tapeId: result.tapeId });
    expect(events()).toEqual([]);
  });

  it("enqueues the formal email for the worker with the blocked entry and the path, and answers a second pick with the first", async () => {
    const { as, kit, events } = await conversationWorld();
    const blocked = await blockedAttempt(kit);
    const result = await (await as("operator")).conversation.reroute({ tapeId: blocked.tapeId, route: "FORMAL_EMAIL", customerId: "cus-0001" });
    expect(result).toMatchObject({ decision: "QUEUED", reroutedTo: "FORMAL_EMAIL", tapeId: null, messageId: `rr-op-${blocked.tapeId}` });
    expect(events()).toEqual([
      expect.objectContaining({
        type: "OPERATOR_SEND",
        eventId: `evt-rr-op-${blocked.tapeId}`,
        customerId: "cus-0001",
        payload: { staffId: "stf-operator-01", messageId: `rr-op-${blocked.tapeId}`, channel: "EMAIL", kind: "COLLECTION_NOTICE_EMAIL", rerouteOf: blocked.tapeId, route: "FORMAL_EMAIL" },
      }),
    ]);
    // Nothing is decided or written by the console: the worker writes REROUTED with the child's entry.
    expect(await kit.connector.chains.listTapeByDecision("demo", "REROUTED")).toEqual([]);
    const human = await (await as("other")).conversation.reroute({ tapeId: blocked.tapeId, route: "HUMAN_QUEUE", customerId: "cus-0001" });
    expect(await (await as("operator")).conversation.reroute({ tapeId: blocked.tapeId, route: "FORMAL_EMAIL", customerId: "cus-0001" })).toMatchObject({ decision: "REROUTED", tapeId: human.tapeId, reroutedTo: "HUMAN_QUEUE" });
    expect(events()).toHaveLength(1);
  });

  it("refuses an unknown block, another customer's block and a path the block does not offer", async () => {
    const { as, kit } = await conversationWorld();
    const blocked = await blockedAttempt(kit);
    const operator = await as("operator");
    expect(await refusal(() => operator.conversation.reroute({ tapeId: "tp-unknown", route: "HUMAN_QUEUE", customerId: "cus-0001" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(() => operator.conversation.reroute({ tapeId: blocked.tapeId, route: "HUMAN_QUEUE", customerId: "cus-0009" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(() => operator.conversation.reroute({ tapeId: blocked.tapeId, route: "HUMAN_QUEUE" }))).toEqual({ code: "BAD_REQUEST", reason: "CUSTOMER_REQUIRED" });
    expect(await kit.connector.chains.listTapeByDecision("demo", "REROUTED")).toEqual([]);
  });

  it("gives the console's reroute ports that can never reach a customer", async () => {
    const { kit } = await conversationWorld();
    const deps = consoleRerouteDeps(kit.deps);
    expect(() => deps.email.checkRecipient({} as never)).toThrow(/never sends/);
    await expect(Promise.resolve().then(() => deps.whatsapp.simulated.send({} as never))).rejects.toThrow(/never sends/);
    expect((await deps.simNow("demo")).toISOString()).toBe(new Date(SIM_NOW).toISOString());
  });
});
