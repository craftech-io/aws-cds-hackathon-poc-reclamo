// Orchestration per customer (docs/architecture.md §6, §7, §8.3, §12 and §14, ADR-0004, ADR-0020,
// docs/build-plan.md WP-20): the FIFO queues every change of a conversation or a complaint goes
// through, their dead letters, the workers that consume them and the Lambdas around them.
//
//   CustomerEvents.fifo        demo, gNN, gtest, gprobe            → EventWorker        (reserved 5)
//   SignupCustomerEvents.fifo  gs-* (self-signup guests)           → SignupEventWorker  (reserved 2)
//   QaCustomerEvents.fifo      qa-*, qamin, sim-*                  → QaEventWorker      (reserved 3)
//
//   The three workers run the same code (handlers/event-worker.ts, WP-33): timeout 360 s, batch 1,
//   visibility 2,160 s (6 × the timeout), 2 receives → `<queue>Dlq.fifo` (14 days; alarms WP-37; the QA
//   one is read and cleaned only by the QaDriver through `QaCustomerEventsDlq`). The event source
//   mapping is capped at the reserved concurrency: a receive the function would throttle still counts
//   toward maxReceiveCount 2 and would dead-letter a healthy event. MessageGroupId = <worldId>#<customerId>
//   and MessageDeduplicationId = eventId, set by worker/enqueue.ts (content-based deduplication off).
//   SignupEventWorker is fenced by `dynamodb:LeadingKeys` to `W#gs-*` and `GLOBALCAP#SIGNUP#*` (reads
//   also `KILL#AGENT`) and by object prefix to `W/gs-` in its buckets: a burst of self-signups never
//   takes execution capacity from demo or a gNN, and its role cannot touch them.
//   ScanDeadlines              standard queue, 120 s delay, consumed by MediaIntake (docs/architecture.md §6)
//   MediaIntake                also the target of the GuardDuty scan results (infra/malware.ts reads `mediaIntake`)
//   EmailEvents                the EventBridge rule of the configuration set (infra/messaging-email.ts); it only enqueues
//   ScheduleDispatch           invoked by EventBridge Scheduler (its role, WP-31, reads `scheduleDispatch`);
//                              publishes through NetworkMock's Function URL, never directly; programs the
//                              next schedules of a running world through `DispatchScheduler` (TIMERS)
//   AnchorWriter               the only writer of the anchors (fixed role name, the CI boundary names it):
//                              asynchronous, 2 retries, then `AnchorWriteFailures` (alarm `AnchorWriteFailed`, WP-37)
//
// Least privilege (infra/iam-capabilities.ts, through `functionData` of infra/mocks.ts): producers link
// the Linkable of the queue (`Resource.CustomerEvents.url` + `sqs:SendMessage` on that queue only);
// linking a queue component would grant `sqs:*`. A consumer polls only its own queue. Holders of ANCHOR
// link `anchorWriter` (`lambda:InvokeFunction` on it). Every caller of a mock runs under its fixed role
// name and gets its pair of resource permissions from `grantMockInvoke`.
//
// Names. Queues have fixed physical names `<app>-<stage>-<Queue>[.fifo]`, inside the `sqs:<app>-*` fence
// of the CI deploy role. SQS keeps a deleted name for 60 s: deploy a removal before a re-creation.
//
// Cost: per request and per invocation; nothing bills while no customer writes.
//
// Verify (reads only):
//   aws --profile craftech-demos sqs get-queue-attributes --queue-url <url of …-poc-CustomerEvents.fifo> --attribute-names All
//     → FifoQueue true · ContentBasedDeduplication false · VisibilityTimeout 2160 · RedrivePolicy maxReceiveCount 2
//   aws --profile craftech-demos lambda get-function-concurrency --function-name <EventWorker name>   → 5 (Signup 2, Qa 3)
//   aws --profile craftech-demos lambda list-event-source-mappings --function-name <EventWorker name> → BatchSize 1 · MaximumConcurrency 5
//   aws --profile craftech-demos lambda get-function-event-invoke-config --function-name <AnchorWriter name>
//     → MaximumRetryAttempts 2 · DestinationConfig.OnFailure …-poc-AnchorWriteFailures
//   aws --profile craftech-demos events list-targets-by-rule --rule aws-cds-hackathon-poc-reclamo-poc-email-events

import { GuardrailG1 } from "./guardrail";
import { QA_DRIVER_DLQ_ONLY_ACTIONS } from "./iam-capabilities";
import { lateLinks, links } from "./late-links";
import { emailConfigurationSetName } from "./messaging-email";
import { emailEventPattern } from "./messaging-email-spec";
import { pipelineLateLinks, pipelineLinks, sendWhatsAppPermissions } from "./messaging-whatsapp";
import { fixedRole, functionData, grantMockInvoke } from "./mocks";
import { buckets } from "./storage";
import {
  ANCHOR_FAILURES,
  CUSTOMER_QUEUE_SETTINGS,
  FUNCTION_BUDGETS,
  HANDLERS,
  LATE_LINKS,
  QUEUE_CONSUMER_ACTIONS,
  RESERVED_CONCURRENCY,
  SCAN_DEADLINES,
  WORKERS,
  WORKER_OWN_QUEUE_ACTIONS,
  emailEventsRuleName,
  queueName,
  type CustomerQueue,
  type QueueName,
  type Wp20Lambda,
  type WorkerName,
} from "./workers-spec";

const physical = (queue: QueueName): string => queueName($app.name, $app.stage, queue);
const budget = (fn: Wp20Lambda) => ({ timeout: `${FUNCTION_BUDGETS[fn].timeoutSeconds} seconds` as const, memory: `${FUNCTION_BUDGETS[fn].memoryMb} MB` as const });

// ---- Queues ------------------------------------------------------------------------------------------

function deadLetters(queue: QueueName, fifo: boolean): sst.aws.Queue {
  return new sst.aws.Queue(`${queue}Queue`, {
    fifo,
    transform: { queue: { name: physical(queue), messageRetentionSeconds: CUSTOMER_QUEUE_SETTINGS.dlqRetentionSeconds, sqsManagedSseEnabled: true } },
  });
}

function customerQueue(queue: CustomerQueue): { readonly main: sst.aws.Queue; readonly dlq: sst.aws.Queue } {
  const dlq = deadLetters(`${queue}Dlq`, true);
  const main = new sst.aws.Queue(`${queue}Queue`, {
    fifo: { contentBasedDeduplication: false },
    visibilityTimeout: `${CUSTOMER_QUEUE_SETTINGS.visibilityTimeoutSeconds} seconds`,
    dlq: { queue: dlq.arn, retry: CUSTOMER_QUEUE_SETTINGS.maxReceiveCount },
    transform: { queue: { name: physical(queue), sqsManagedSseEnabled: true } },
  });
  return { main, dlq };
}

export const customerQueues: Readonly<Record<CustomerQueue, ReturnType<typeof customerQueue>>> = {
  CustomerEvents: customerQueue("CustomerEvents"),
  SignupCustomerEvents: customerQueue("SignupCustomerEvents"),
  QaCustomerEvents: customerQueue("QaCustomerEvents"),
};

export const scanDeadlinesDlq = deadLetters("ScanDeadlinesDlq", false);
export const scanDeadlinesQueue = new sst.aws.Queue("ScanDeadlinesQueue", {
  delay: `${SCAN_DEADLINES.delaySeconds} seconds`,
  visibilityTimeout: `${SCAN_DEADLINES.visibilityTimeoutSeconds} seconds`,
  dlq: { queue: scanDeadlinesDlq.arn, retry: SCAN_DEADLINES.maxReceiveCount },
  transform: { queue: { name: physical("ScanDeadlines"), sqsManagedSseEnabled: true } },
});

export const anchorWriteFailures = deadLetters("AnchorWriteFailures", false);

/** Producer side of a queue: `Resource.<name>.url` and `sqs:SendMessage` on that queue only. */
function producer(name: QueueName, queue: sst.aws.Queue): sst.Linkable<{ url: $util.Output<string> }> {
  return new sst.Linkable(name, { properties: { url: queue.url }, include: [sst.aws.permission({ actions: ["sqs:SendMessage"], resources: [queue.arn] })] });
}

export const CustomerEvents = producer("CustomerEvents", customerQueues.CustomerEvents.main);
export const SignupCustomerEvents = producer("SignupCustomerEvents", customerQueues.SignupCustomerEvents.main);
export const QaCustomerEvents = producer("QaCustomerEvents", customerQueues.QaCustomerEvents.main);
export const ScanDeadlines = producer("ScanDeadlines", scanDeadlinesQueue);

const PRODUCERS: Readonly<Record<CustomerQueue, unknown>> = { CustomerEvents, SignupCustomerEvents, QaCustomerEvents };
const allCustomerQueues = Object.values(PRODUCERS);

/** The QaDriver's view of the QA dead letters (`dlq.find`, `dlq.delete`): url and its three actions only. */
export const QaCustomerEventsDlq = new sst.Linkable("QaCustomerEventsDlq", {
  properties: { url: customerQueues.QaCustomerEvents.dlq.url },
  include: [sst.aws.permission({ actions: [...QA_DRIVER_DLQ_ONLY_ACTIONS], resources: [customerQueues.QaCustomerEvents.dlq.arn] })],
});

// ---- AnchorWriter ------------------------------------------------------------------------------------

const anchorData = functionData("AnchorWriter");

export const anchorWriter = new sst.aws.Function("AnchorWriter", {
  description: "The only writer of the register anchors: re-reads each committed entry and anchors its stored hash.",
  handler: HANDLERS.AnchorWriter,
  ...budget("AnchorWriter"),
  retries: ANCHOR_FAILURES.retries,
  link: anchorData.links,
  permissions: [...anchorData.permissions, { actions: [...ANCHOR_FAILURES.destinationActions], resources: [anchorWriteFailures.arn] }],
  transform: {
    role: fixedRole("AnchorWriter"),
    eventInvokeConfig: (args) => {
      args.destinationConfig = { onFailure: { destination: anchorWriteFailures.arn } };
    },
  },
});

// ---- Event workers -----------------------------------------------------------------------------------

/** TIMERS (infra/scheduler.ts) and the Harness (infra/agentcore.ts), both WP-31: resolved once for the three workers. */
const workerLateLinks = [pipelineLateLinks("workers"), lateLinks("workers", "agentcore", () => import("./agentcore"), LATE_LINKS.workerAgent, "optional")];

function createEventWorker(name: WorkerName, description: string): sst.aws.Function {
  const { queue } = WORKERS[name];
  const own = customerQueues[queue].main;
  const data = functionData(name);
  const reserved = RESERVED_CONCURRENCY[name];
  const fn = new sst.aws.Function(name, {
    description,
    handler: HANDLERS[name],
    ...budget(name),
    concurrency: { reserved },
    link: links([...data.links, ...pipelineLinks, GuardrailG1, anchorWriter, PRODUCERS[queue]], ...workerLateLinks),
    permissions: $util
      .all([$util.output(data.permissions), sendWhatsAppPermissions, own.arn])
      .apply(([granted, whatsApp, queueArn]) => [...granted, ...whatsApp, { actions: [...QUEUE_CONSUMER_ACTIONS, ...WORKER_OWN_QUEUE_ACTIONS], resources: [queueArn] }]),
    transform: { role: fixedRole(name) },
  });
  grantMockInvoke(name, fn);
  own.subscribe(fn.arn, {
    batch: { size: CUSTOMER_QUEUE_SETTINGS.batchSize },
    transform: { eventSourceMapping: { scalingConfig: { maximumConcurrency: reserved } } },
  });
  return fn;
}

export const eventWorker = createEventWorker("EventWorker", "Consumes CustomerEvents.fifo (demo, gNN, gtest, gprobe): turns, timers, obligations, console sends.");
export const signupEventWorker = createEventWorker("SignupEventWorker", "Consumes SignupCustomerEvents.fifo: the same worker, only for self-signup guest worlds.");
export const qaEventWorker = createEventWorker("QaEventWorker", "Consumes QaCustomerEvents.fifo: the same worker, only for QA and simulated-load worlds.");

// ---- MediaIntake -------------------------------------------------------------------------------------

const mediaData = functionData("MediaIntake");

export const mediaIntake = new sst.aws.Function("MediaIntake", {
  description: "GuardDuty scan result or scan deadline of a Media object: validates, quarantines or rejects, and enqueues.",
  handler: HANDLERS.MediaIntake,
  ...budget("MediaIntake"),
  link: [...mediaData.links, ...allCustomerQueues],
  permissions: $util.all([$util.output(mediaData.permissions), buckets.Media.arn, scanDeadlinesQueue.arn]).apply(([granted, mediaArn, deadlinesArn]) => [
    ...granted,
    // The deadline reads GuardDuty's tag of the object when no scan result arrived (docs/architecture.md §6).
    { actions: ["s3:GetObjectTagging"], resources: [`${mediaArn}/*`] },
    { actions: [...QUEUE_CONSUMER_ACTIONS], resources: [deadlinesArn] },
  ]),
});

export const mediaIntakeDeadlines = scanDeadlinesQueue.subscribe(mediaIntake.arn, { batch: { size: SCAN_DEADLINES.batchSize } });

// ---- EmailEvents -------------------------------------------------------------------------------------

const emailData = functionData("EmailEvents");

export const emailEvents = new sst.aws.Function("EmailEvents", {
  description: "SES events of the configuration set: validated against the EmailRecord and enqueued; never sends.",
  handler: HANDLERS.EmailEvents,
  ...budget("EmailEvents"),
  link: [...emailData.links, anchorWriter, ...allCustomerQueues],
  permissions: emailData.permissions,
});

export const emailEventsRule = new aws.cloudwatch.EventRule("EmailEventsRule", {
  name: emailEventsRuleName($app.name, $app.stage),
  description: "SES events of the app's configuration set, for EmailEvents",
  eventPattern: JSON.stringify(emailEventPattern(emailConfigurationSetName)),
});

const emailEventsInvoke = new aws.lambda.Permission("EmailEventsInvoke", {
  action: "lambda:InvokeFunction",
  function: emailEvents.name,
  principal: "events.amazonaws.com",
  sourceArn: emailEventsRule.arn,
});

export const emailEventsTarget = new aws.cloudwatch.EventTarget("EmailEventsTarget", { rule: emailEventsRule.name, arn: emailEvents.arn }, { dependsOn: [emailEventsInvoke] });

// ---- ScheduleDispatch --------------------------------------------------------------------------------

const dispatchData = functionData("ScheduleDispatch");

export const scheduleDispatch = new sst.aws.Function("ScheduleDispatch", {
  description: "A due timer of EventBridge Scheduler: decides from the stored timer and clock, publishes batches, enqueues.",
  handler: HANDLERS.ScheduleDispatch,
  ...budget("ScheduleDispatch"),
  // TIMERS late (infra/scheduler.ts imports this module): the next schedules of a running world.
  link: links([...dispatchData.links, ...allCustomerQueues], lateLinks("workers", "scheduler", () => import("./scheduler"), LATE_LINKS.dispatchScheduler, "optional")),
  permissions: dispatchData.permissions,
  transform: { role: fixedRole("ScheduleDispatch") },
});

export const scheduleDispatchMockGrants = grantMockInvoke("ScheduleDispatch", scheduleDispatch);
