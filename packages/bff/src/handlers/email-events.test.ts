// Lambda entry of `EmailEvents` (FL-090): the account it accepts is the one in its own ARN, it only
// enqueues (its dependencies hold no sender at all), a fabricated event is rejected without a retry,
// and an event it cannot place yet fails so EventBridge delivers it again.
import { describe, expect, it } from "vitest";
import { TEST_CONFIGURATION_SET, TEST_PROVIDER_ID } from "../channels/email/testing";
import type { Connector } from "../connector/port";
import { testConnector } from "../connector/testing";
import type { EmailEventMessage } from "../email-events/schema";
import { TEST_ACCOUNT, seedSentEmail, sesEvent } from "../email-events/testing";
import { EnqueueError } from "../worker/enqueue";
import { type EmailEventsDeps, accountOfFunctionArn, createEmailEventsHandler } from "./email-events";

const CONTEXT = { invokedFunctionArn: `arn:aws:lambda:us-east-1:${TEST_ACCOUNT}:function:reclamo-poc-EmailEvents`, awsRequestId: "req-0001" };

function handlerOver(connector: Connector) {
  const queued: EmailEventMessage[] = [];
  const deps: EmailEventsDeps = { connector, enqueue: () => async (message) => void queued.push(message), configurationSet: TEST_CONFIGURATION_SET, now: () => new Date("2026-10-07T13:10:06.000Z"), logSink: () => undefined };
  return { handler: createEmailEventsHandler(() => deps), queued, deps };
}

describe("EmailEvents handler [FL-090]", () => {
  it("enqueues the event of an email this world sent, and nothing else happens", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { handler, queued, deps } = handlerOver(connector);
    expect(await handler(sesEvent("Email Delivered"), CONTEXT)).toMatchObject({ outcome: "ENQUEUED" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ type: "DELIVERY", providerMessageId: TEST_PROVIDER_ID });
    // No sender among its dependencies: it can only enqueue (no PIPELINE).
    expect(Object.keys(deps).sort()).toEqual(["configurationSet", "connector", "enqueue", "logSink", "now"]);
    expect(await connector.runtime.listPending("g01")).toHaveLength(1);
  });

  it("accepts only the account of its own ARN", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { handler, queued } = handlerOver(connector);
    const elsewhere = { ...CONTEXT, invokedFunctionArn: "arn:aws:lambda:us-east-1:111122223333:function:reclamo-poc-EmailEvents" };
    expect(await handler(sesEvent("Email Delivered"), elsewhere)).toEqual({ outcome: "REJECTED", reason: "WRONG_ACCOUNT" });
    expect(queued).toEqual([]);
  });

  it("rejects a fabricated event (no EmailRecord) without throwing, so it is never retried", async () => {
    const { connector } = testConnector();
    const { handler, queued } = handlerOver(connector);
    expect(await handler(sesEvent("Email Delivered", { providerMessageId: "0100-fabricated-0002" }), CONTEXT)).toEqual({ outcome: "REJECTED", reason: "UNKNOWN_MAIL" });
    expect(await handler({ source: "aws.ses", detail: {} }, CONTEXT)).toEqual({ outcome: "REJECTED", reason: "INVALID_EVENT" });
    expect(queued).toEqual([]);
  });

  it("throws when the queue producer cannot send, so EventBridge keeps the event", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const failing = () => async () => {
      throw new EnqueueError("SendMessage of EMAIL_EVENT failed");
    };
    const handler = createEmailEventsHandler(() => ({ connector, enqueue: failing, configurationSet: TEST_CONFIGURATION_SET, now: () => new Date(), logSink: () => undefined }));
    await expect(handler(sesEvent("Email Delivered"), CONTEXT)).rejects.toMatchObject({ name: "EnqueueError", retryable: true });
  });

  it("reads the account from a Lambda ARN and refuses anything else", () => {
    expect(accountOfFunctionArn(CONTEXT.invokedFunctionArn)).toBe(TEST_ACCOUNT);
    expect(() => accountOfFunctionArn("not-an-arn")).toThrow();
  });
});
