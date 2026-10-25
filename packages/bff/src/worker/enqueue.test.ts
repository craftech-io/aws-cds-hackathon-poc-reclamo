// `enqueue_customer_event` (docs/architecture.md §7, docs/architecture-guests.md §7): the only producer of
// the customer queues and of `ScanDeadlines`. The queue comes from the world's id alone (a `gs-*` never
// goes to `CustomerEvents.fifo`), a caller enqueues only for its own world, the event is in `inFlight`
// before the message exists, and a send is retried with backoff.
import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { ToolError } from "@reclamo/shared";
import { worldPending } from "../clock/busy";
import { keys } from "../connector/keys";
import { CUSTOMER, TEST_NOW, eventOf, recordOf, workerKit } from "./testing";
import { processRecord } from "./worker";
import { EnqueueError, SCAN_DEADLINE_DELAY_SECONDS, createEnqueuer, crossWorldReason, emailEventEnqueue, queueFor, queueOfArn, sendMessageInput } from "./enqueue";
import { CustomerEvent, EVENT_MAX_LIFE_MS } from "./events";
import { QUEUE_VISIBILITY_TIMEOUT_SECONDS } from "./queue-limits";

const WORKER = (worldId: string) => ({ kind: "WORKER" as const, worldId, eventId: "evt-source" });

describe("[FL-125] the queue of a world", () => {
  it.each([
    ["demo", "CustomerEvents"],
    ["g01", "CustomerEvents"],
    ["g99", "CustomerEvents"],
    ["gtest", "CustomerEvents"],
    ["gprobe", "CustomerEvents"],
    ["gs-abcdefghij", "SignupCustomerEvents"],
    ["gs-zz2234567a", "SignupCustomerEvents"],
    ["qa-run1-sc24", "QaCustomerEvents"],
    ["qamin", "QaCustomerEvents"],
    ["sim-batch1", "QaCustomerEvents"],
  ])("[FL-125] %s → %s", (worldId, queue) => {
    expect(queueFor(worldId)).toBe(queue);
  });

  it("[FL-125] a self-signup world's event is sent only to SignupCustomerEvents.fifo", async () => {
    const kit = await workerKit({ worldId: "gs-abcdefghij" });
    await kit.deps.enqueuer.enqueueCustomerEvent(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-source" }, { worldId: "gs-abcdefghij" }), WORKER("gs-abcdefghij"));
    expect(kit.sent.map((input) => input.QueueUrl)).toEqual(["https://sqs.us-east-1.amazonaws.com/000000000000/reclamo-poc-SignupCustomerEvents.fifo"]);
    expect(kit.sent.some((input) => input.QueueUrl?.endsWith("-CustomerEvents.fifo") && !input.QueueUrl.includes("Signup"))).toBe(false);
  });

  it("refuses an id that is not a world", () => {
    expect(() => queueFor("not-a-world")).toThrow(ToolError);
  });

  it("reads the queue of an event source ARN, longest name first", () => {
    expect(queueOfArn("arn:aws:sqs:us-east-1:000000000000:app-poc-SignupCustomerEvents.fifo")).toBe("SignupCustomerEvents");
    expect(queueOfArn("arn:aws:sqs:us-east-1:000000000000:app-poc-QaCustomerEvents.fifo")).toBe("QaCustomerEvents");
    expect(queueOfArn("arn:aws:sqs:us-east-1:000000000000:app-poc-CustomerEvents.fifo")).toBe("CustomerEvents");
    expect(queueOfArn("arn:aws:sqs:us-east-1:000000000000:app-poc-ScanDeadlines")).toBeUndefined();
  });
});

describe("the message", () => {
  it("groups by world and customer and deduplicates by event id", () => {
    const event = CustomerEvent.parse(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-source" }, { eventId: "obl-1" }));
    expect(sendMessageInput("https://queue", event)).toEqual({ QueueUrl: "https://queue", MessageBody: JSON.stringify(event), MessageGroupId: `demo#${CUSTOMER}`, MessageDeduplicationId: "obl-1" });
  });

  it("puts the event in inFlight before the message exists", async () => {
    const kit = await workerKit();
    const seen: string[][] = [];
    const enqueuer = createEnqueuer({
      data: kit.connector,
      send: async () => void seen.push([...(await kit.connector.runtime.getWorldState("demo")).inFlight]),
      queueUrl: () => "https://queue",
      now: () => TEST_NOW,
      log: kit.deps.loggerFor("corr-enqueue"),
    });
    await enqueuer.enqueueCustomerEvent(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-source" }, { eventId: "obl-2" }), WORKER("demo"));
    expect(seen).toEqual([[`${CUSTOMER}#obl-2~${TEST_NOW.getTime()}`]]);
  });

  it("replaces an inFlight seeded as an empty list with the set of its token, and sends", async () => {
    const kit = await workerKit();
    await kit.connector.write({ kind: "put", table: "Runtime", item: { ...keys.runtime("demo", "WORLDSTATE"), entity: "WorldState", worldId: "demo", inFlight: [] } });
    await kit.deps.enqueuer.enqueueCustomerEvent(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-source" }, { eventId: "obl-list" }), WORKER("demo"));
    expect((await kit.connector.runtime.getWorldState("demo")).inFlight).toEqual([`${CUSTOMER}#obl-list~${TEST_NOW.getTime()}`]);
    expect(kit.sent).toHaveLength(1);
  });

  it("refuses a malformed event before it becomes a message", async () => {
    const kit = await workerKit();
    await expect(kit.deps.enqueuer.enqueueCustomerEvent({ ...eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-source" }), extra: true } as never, WORKER("demo"))).rejects.toThrow();
    expect(kit.sent).toEqual([]);
  });

  it("retries a failing send with backoff and gives up as a retryable EnqueueError", async () => {
    const kit = await workerKit();
    let calls = 0;
    const flaky = createEnqueuer({ data: kit.connector, send: async () => (++calls < 3 ? Promise.reject(new Error("throttled")) : undefined), queueUrl: () => "https://queue", now: () => TEST_NOW, log: kit.deps.loggerFor("corr-flaky"), sleep: async () => undefined });
    await flaky.enqueueCustomerEvent(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-source" }, { eventId: "obl-3" }), WORKER("demo"));
    expect(calls).toBe(3);
    const down = createEnqueuer({ data: kit.connector, send: async () => Promise.reject(new Error("down")), queueUrl: () => "https://queue", now: () => TEST_NOW, log: kit.deps.loggerFor("corr-down"), sleep: async () => undefined });
    await expect(down.enqueueCustomerEvent(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-source" }, { eventId: "obl-4" }), WORKER("demo"))).rejects.toBeInstanceOf(EnqueueError);
  });
});

describe("who may enqueue for a world", () => {
  it("refuses another world's event: DENY CROSS_WORLD in the caller's world, nothing sent, nothing in flight", async () => {
    const kit = await workerKit();
    const attempt = kit.deps.enqueuer.enqueueCustomerEvent(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-source" }, { worldId: "g07" }), WORKER("demo"));
    await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN", reason: "CROSS_WORLD" });
    expect(kit.sent).toEqual([]);
    expect((await kit.connector.runtime.getWorldState("g07")).inFlight).toEqual([]);
    const denied = await kit.audited("DENY");
    expect(denied[0]).toMatchObject({ outcome: "CROSS_WORLD", refs: expect.objectContaining({ targetWorld: "g07", reason: "CALLER_WORLD" }) });
  });

  it("lets a QA caller enqueue only for QA worlds", () => {
    expect(crossWorldReason({ kind: "QA", worldId: "demo", eventId: "step-1" }, "demo")).toBe("QA_OUTSIDE_QA");
    expect(crossWorldReason({ kind: "QA", worldId: "qa-run1-x", eventId: "step-1" }, "qa-run1-x")).toBeUndefined();
    expect(crossWorldReason({ kind: "CHANNEL", worldId: "gs-abcdefghij", eventId: "wa-1" }, "gs-abcdefghij")).toBeUndefined();
  });

  it("keeps POISON and HEALTH_PROBE in the QA queue", async () => {
    const kit = await workerKit();
    await expect(kit.deps.enqueuer.enqueueCustomerEvent(eventOf("POISON", {}), { kind: "CONSOLE", worldId: "demo", staffId: "stf-operator", role: "OPERATOR", eventId: "req-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(kit.sent).toEqual([]);
  });
});

describe("the other messages of the producer", () => {
  it("puts a scan deadline on ScanDeadlines with its 120 s delay", async () => {
    const kit = await workerKit();
    await kit.deps.enqueuer.enqueueScanDeadline({ worldId: "demo", announceKey: "W/demo/up/obj-1.jpg", messageId: "msg-0001", boundAtReal: TEST_NOW.toISOString() }, { kind: "CHANNEL", worldId: "demo", eventId: "wa-1" });
    const [input] = kit.sent as [SendMessageCommandInput];
    expect(input.QueueUrl).toBe("https://sqs.us-east-1.amazonaws.com/000000000000/reclamo-poc-ScanDeadlines");
    expect(input.DelaySeconds).toBe(SCAN_DEADLINE_DELAY_SECONDS);
    expect(JSON.parse(input.MessageBody ?? "{}")).toMatchObject({ kind: "SCAN_DEADLINE", worldId: "demo", messageId: "msg-0001" });
    expect(input.MessageGroupId).toBeUndefined();
  });

  it("turns what EmailEvents admitted into an EMAIL_EVENT of its world and epoch, with the channel's caller", async () => {
    const kit = await workerKit();
    const payload = { worldId: "demo", epoch: 1, customerId: CUSTOMER, mailId: "mail-0001", sentAtSim: "2026-10-07T10:10:00-03:00", providerMessageId: "0100018f-abc", type: "DELIVERY", occurredAtReal: TEST_NOW.toISOString() } as const;
    await emailEventEnqueue(kit.deps.enqueuer)({ type: "EMAIL_EVENT", eventId: "email-0001", worldId: "demo", customerId: CUSTOMER, payload });
    const event = JSON.parse(kit.sent[0]?.MessageBody ?? "{}") as { type: string; eventAtSim: string; epoch: number };
    expect(event).toMatchObject({ type: "EMAIL_EVENT", eventAtSim: payload.sentAtSim, epoch: 1 });
  });
});

describe("an event enqueued again after it was processed", () => {
  const message = () => eventOf("CUSTOMER_MESSAGE", { messageId: "msg-0001", messageAtSim: "2026-10-07T10:10:00-03:00", complaintIds: [] }, { eventId: "evt-retried-intake" });
  const channel = { kind: "CHANNEL" as const, worldId: "demo", eventId: "wa-1" };

  it("is not enqueued again, so no token is left in inFlight that nobody would remove", async () => {
    const kit = await workerKit();
    await kit.addInbound("msg-0001", "hola");
    await kit.deps.enqueuer.enqueueCustomerEvent(message(), channel);
    expect(await processRecord(kit.deps, recordOf(kit.sent[0]?.MessageBody))).toBe("PROCESSED");
    await kit.deps.enqueuer.enqueueCustomerEvent(message(), channel);
    expect(kit.sent).toHaveLength(1);
    expect((await kit.connector.runtime.getWorldState("demo")).inFlight).toEqual([]);
  });

  it("adds no second token for a copy enqueued while the first is queued, still sends it, and the worker leaves inFlight empty", async () => {
    const kit = await workerKit();
    await kit.addInbound("msg-0001", "hola");
    await kit.deps.enqueuer.enqueueCustomerEvent(message(), channel);
    kit.advanceReal(60_000);
    await kit.deps.enqueuer.enqueueCustomerEvent(message(), channel);
    expect((await kit.connector.runtime.getWorldState("demo")).inFlight).toEqual([`${CUSTOMER}#evt-retried-intake~${TEST_NOW.getTime()}`]);
    expect(kit.sent.map((input) => input.MessageDeduplicationId)).toEqual(["evt-retried-intake", "evt-retried-intake"]);
    await processRecord(kit.deps, recordOf(kit.sent[0]?.MessageBody));
    expect((await kit.connector.runtime.getWorldState("demo")).inFlight).toEqual([]);
  });

  it("resends an event whose first send failed after its ADD, under the token it already has", async () => {
    const kit = await workerKit();
    let fail = true;
    const sent: SendMessageCommandInput[] = [];
    const enqueuer = createEnqueuer({ data: kit.connector, send: async (input) => (fail ? Promise.reject(new Error("down")) : void sent.push(input)), queueUrl: () => "https://queue", now: () => TEST_NOW, log: kit.deps.loggerFor("corr-resend"), sleep: async () => undefined });
    await expect(enqueuer.enqueueCustomerEvent(message(), channel)).rejects.toBeInstanceOf(EnqueueError);
    fail = false;
    await enqueuer.enqueueCustomerEvent(message(), channel);
    expect(sent).toHaveLength(1);
    expect((await kit.connector.runtime.getWorldState("demo")).inFlight).toHaveLength(1);
  });

  it("keeps waiting for a token while its message may be alive (a redelivery 36 minutes later) and reports it stale only beyond the message's life", async () => {
    const kit = await workerKit();
    await kit.deps.enqueuer.enqueueCustomerEvent(message(), channel);
    const view = { stored: { worldId: "demo" }, simNow: new Date("2026-10-07T13:10:00.000Z") } as Parameters<typeof worldPending>[1];
    const at = (ms: number) => new Date(TEST_NOW.getTime() + ms);
    expect(await worldPending(kit.connector, view, TEST_NOW)).toEqual([expect.objectContaining({ kind: "EVENT", detail: "evt-retried-intake", stale: false })]);
    expect(await worldPending(kit.connector, view, at(QUEUE_VISIBILITY_TIMEOUT_SECONDS * 1000 + 60_000))).toEqual([expect.objectContaining({ kind: "EVENT", stale: false })]);
    expect(await worldPending(kit.connector, view, at(EVENT_MAX_LIFE_MS))).toEqual([expect.objectContaining({ kind: "EVENT", stale: false })]);
    expect(await worldPending(kit.connector, view, at(EVENT_MAX_LIFE_MS + 1))).toEqual([expect.objectContaining({ kind: "EVENT", detail: "evt-retried-intake", stale: true })]);
  });
});
