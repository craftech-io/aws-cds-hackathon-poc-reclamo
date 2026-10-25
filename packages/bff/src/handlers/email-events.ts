/// <reference path="../../sst-env.d.ts" />
// Lambda entry of `EmailEvents` (docs/architecture-integrations.md §2): the EventBridge rule of the
// app's configuration set invokes it with each SES event. It validates and enqueues
// (email-events/admit.ts); it never sends and holds no `PIPELINE` capability. The account it accepts
// is its own, read from the invoked function's ARN; the configuration set is built from the linked
// app and stage (channels/email/stage.ts), never from the environment.
//
// A rejection or a tombstoned event returns normally (no retry, no dead letter, no alarm); "the SES id
// is not recorded yet" and a failed enqueue throw, so EventBridge's asynchronous retries deliver it again.
// The event leaves through the single producer of the customer queues (worker/enqueue.ts).
import type { Context } from "aws-lambda";
import { ChannelError } from "@reclamo/shared";
import { stageConfigurationSet } from "../channels/email/stage";
import { dynamoConnector } from "../connector/dynamo/connector";
import { type AdmitDeps, type AdmitOutcome, admitSesEvent } from "../email-events/admit";
import type { EmailEventEnqueue } from "../email-events/schema";
import { type LogSink, type Logger, correlationIdFrom, createLogger } from "../lib/log";
import { emailEventEnqueue, linkedEnqueuer } from "../worker/enqueue";

export type EmailEventsDeps = Omit<AdmitDeps, "expected" | "log" | "enqueue"> & {
  /** The single producer of the customer queues (worker/enqueue.ts), with the invocation's logger. */
  readonly enqueue: (log: Logger) => EmailEventEnqueue;
  readonly configurationSet: string;
  readonly logSink?: LogSink;
};

/** `123456789012` of `arn:aws:lambda:<region>:<account>:function:<name>`. */
export function accountOfFunctionArn(arn: string): string {
  const account = arn.split(":")[4];
  if (account === undefined || !/^\d{12}$/.test(account)) throw new ChannelError("INVALID", "EMAIL", "cannot read the account of this function");
  return account;
}

export function createEmailEventsHandler(deps: () => EmailEventsDeps) {
  return async (event: unknown, context: Pick<Context, "invokedFunctionArn" | "awsRequestId">): Promise<AdmitOutcome> => {
    const built = deps();
    const { configurationSet, logSink, enqueue, ...admit } = built;
    const log = createLogger({ correlationId: correlationIdFrom(context.awsRequestId), bindings: { fn: "EmailEvents" }, ...(logSink === undefined ? {} : { sink: logSink }) });
    const expected = { account: accountOfFunctionArn(context.invokedFunctionArn), configurationSet };
    return admitSesEvent(event, { ...admit, enqueue: enqueue(log), expected, log });
  };
}

let stageDeps: EmailEventsDeps | undefined;

function emailEventsDeps(): EmailEventsDeps {
  if (stageDeps === undefined) {
    const connector = dynamoConnector();
    stageDeps = {
      connector,
      enqueue: (log) => emailEventEnqueue(linkedEnqueuer(connector, log)),
      configurationSet: stageConfigurationSet(),
      now: () => new Date(),
    };
  }
  return stageDeps;
}

export const handler = createEmailEventsHandler(emailEventsDeps);
