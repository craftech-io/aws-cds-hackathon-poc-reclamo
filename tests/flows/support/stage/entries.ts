// The entry points of the stage, in process: the same handler factories the Lambdas export, over the
// ports of stage/context.ts (docs/test-plan.md §3, "Flujos locales"):
//
//   inboundWhatsApp(event)   `InboundWhatsApp` (handlers/inbound-whatsapp.ts) with intake/stage.ts's wiring
//   emailEvent(event)        `EmailEvents` (handlers/email-events.ts), as the account's function
//   mediaScanned(key, st)    GuardDuty tags the object and `MediaIntake` gets the scan result
//   timerFire(timerKey)      `ScheduleDispatch` with the input its schedule carries
//   drain()                  the queues delivered to `EventWorker` / `SignupEventWorker` / `QaEventWorker`
//                            (worker/production.ts's wiring) and the due `ScanDeadlines` to `MediaIntake`
import type { CoreCaller } from "@reclamo/core-mock/http/caller";
import { waInboundTopicArn } from "@reclamo/bff/channels/whatsapp/config";
import { s3MediaBucket } from "@reclamo/bff/channels/whatsapp/media-store";
import type { InboundSummary } from "@reclamo/bff/channels/whatsapp/inbound";
import { createSnsVerifier } from "@reclamo/bff/channels/whatsapp/sns-signature";
import { configurationSetName } from "@reclamo/bff/channels/email/config";
import type { AdmitOutcome } from "@reclamo/bff/email-events/admit";
import { createEmailEventsHandler } from "@reclamo/bff/handlers/email-events";
import { createInboundWhatsAppHandler } from "@reclamo/bff/handlers/inbound-whatsapp";
import { type MediaIntakeSummary, createMediaIntakeHandler } from "@reclamo/bff/handlers/media-intake";
import { createScheduleDispatchHandler } from "@reclamo/bff/handlers/schedule-dispatch";
import { createIntake } from "@reclamo/bff/intake/accept";
import { intakeEffects } from "@reclamo/bff/intake/effects";
import { gateFixedReplies } from "@reclamo/bff/intake/replies";
import { coreConsentRecorder, coreCustomerDirectory } from "@reclamo/bff/intake/stage";
import type { Logger } from "@reclamo/bff/lib/log";
import { s3MediaObjects } from "@reclamo/bff/media-intake/objects";
import { SCAN_STATUS_TAG } from "@reclamo/bff/media-intake/schema";
import { createSettlementFileReader } from "@reclamo/bff/networks/settlement-files";
import { rerouteThroughGate } from "@reclamo/bff/outbound/gate";
import { replyToUnknownSender } from "@reclamo/bff/outbound/unknown-sender";
import type { ScheduledResult } from "@reclamo/bff/timers/dispatch";
import { scheduleNameOf } from "@reclamo/bff/timers/schedule-name";
import type { HarnessClient } from "@reclamo/bff/agent/harness-client";
import { type MemoryRetriever, NO_MEMORY } from "@reclamo/bff/agent/memory";
import { type CustomerQueue, emailEventEnqueue, mediaEventEnqueue } from "@reclamo/bff/worker/enqueue";
import type { WorkerDeps } from "@reclamo/bff/worker/ports";
import { stageEventHandlers } from "@reclamo/bff/worker/stage/handlers";
import { type EventWorker, createEventWorker } from "@reclamo/bff/worker/worker";
import { LOCAL_KEYS, PHONE_HASH_SUBKEY } from "../keys";
import { APP, LOCAL_CHANNEL_MODES, STAGE, type StageContext, asS3Client, documentStore } from "./context";
import { workerReads } from "./targets";

const ACCOUNT = "776805327629";
const SCHEDULE_GROUP = `${APP}-${STAGE}-timers`;
const WORKER_ROLES: Readonly<Record<CustomerQueue, CoreCaller & ("EventWorker" | "SignupEventWorker" | "QaEventWorker")>> = {
  CustomerEvents: "EventWorker",
  SignupCustomerEvents: "SignupEventWorker",
  QaCustomerEvents: "QaEventWorker",
};

/** GuardDuty Malware Protection's verdicts (media-intake/schema.ts `GuardDutyScanStatus`). */
export type ScanVerdict = "NO_THREATS_FOUND" | "THREATS_FOUND" | "UNSUPPORTED" | "ACCESS_DENIED" | "FAILED";

export interface EntryOptions {
  readonly harness: HarnessClient;
  readonly memory?: MemoryRetriever;
  /** The SNS signing certificate of live records (a test's own key pair; never fetched from AWS). */
  readonly snsCertificatePem?: string;
}

export interface LocalEntries {
  inboundWhatsApp(event: unknown): Promise<InboundSummary>;
  emailEvent(event: unknown): Promise<AdmitOutcome>;
  mediaScanned(objectKey: string, verdict: ScanVerdict): Promise<MediaIntakeSummary>;
  timerFire(worldId: string, timerKey: string): Promise<ScheduledResult>;
  /** Delivers every queued event and due scan deadline; answers how many deliveries it made. */
  drain(): Promise<number>;
}

function inboundDeps(stage: StageContext, log: Logger, coldStart: boolean, snsCertificatePem: string | undefined) {
  const { connector } = stage;
  const core = () => stage.mocks.core("InboundWhatsApp");
  const complaints = stage.complaints(log);
  const gate = stage.gate("InboundWhatsApp");
  const effectPorts = { complaints, gate, core, consent: coreConsentRecorder(core, log.correlationId), documents: documentStore(stage.s3), realNow: stage.now };
  const enqueuer = stage.enqueuer(log);
  return {
    data: connector,
    keys: { phoneHash: PHONE_HASH_SUBKEY, simEnvelope: { console: LOCAL_KEYS.simEnvelope.console, qa: LOCAL_KEYS.simEnvelope.qa } },
    topicArn: waInboundTopicArn(),
    sns: createSnsVerifier(async () => {
      if (snsCertificatePem === undefined) throw new Error("this world has no SNS certificate: live records cannot be verified");
      return snsCertificatePem;
    }),
    stageModes: LOCAL_CHANNEL_MODES,
    customers: coreCustomerDirectory(core, connector, log.correlationId),
    replies: gateFixedReplies({ gate, unknownSender: (reply, call) => replyToUnknownSender(stage.outboundDeps("InboundWhatsApp", call.log), reply, call), log }),
    effects: intakeEffects({ ...effectPorts, data: connector, log }),
    intake: createIntake({
      data: connector,
      classifier: { realNow: stage.now, model: stage.classifier },
      acknowledge: { complaints, gate, core, realNow: stage.now, coldStart, agentMode: "SCRIPTED" },
      effects: effectPorts,
      media: { objects: s3MediaObjects("Media", stage.s3), now: stage.now },
      enqueuer,
      log,
    }),
    bucket: s3MediaBucket({ mediaBucket: "Media", seedBucket: "Seed", client: asS3Client(stage.s3) }),
    realClock: stage.realClock,
    log,
  };
}

function workerDeps(stage: StageContext, options: EntryOptions, role: (typeof WORKER_ROLES)[CustomerQueue]): WorkerDeps {
  const log = stage.loggerFor(`local-${role}`);
  const complaints = stage.complaints(log);
  const gate = stage.gate(role);
  const readFile = createSettlementFileReader({ s3: stage.s3, bucket: "Settlements" });
  return {
    data: stage.connector,
    complaints,
    gate,
    reroute: rerouteThroughGate(stage.outboundDeps(role, log)),
    turn: { harness: options.harness, prefilter: stage.guardrails.g1, memory: options.memory ?? NO_MEMORY, reads: workerReads(stage, role), sessionKey: () => LOCAL_KEYS.session, agentMode: "SCRIPTED" },
    handlers: stageEventHandlers({
      data: stage.connector,
      gate,
      complaints: () => complaints,
      core: () => stage.mocks.core(role),
      networks: () => stage.mocks.networks(role),
      settlementFiles: () => readFile,
      documents: documentStore(stage.s3),
    }),
    enqueuer: stage.enqueuer(log),
    queue: { releaseNow: async (receiptHandle) => void stage.queues.released.push(receiptHandle) },
    now: stage.now,
    loggerFor: stage.loggerFor,
  };
}

export function createLocalEntries(stage: StageContext, options: EntryOptions): LocalEntries {
  const logSink = (line: string) => void stage.lines.push(line);
  let requests = 0;
  const context = (fn: string) => ({ awsRequestId: `local-${fn}-${++requests}`, invokedFunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${APP}-${STAGE}-${fn}` });
  const inbound = createInboundWhatsAppHandler({ deps: (log, coldStart) => inboundDeps(stage, log, coldStart, options.snsCertificatePem), logger: stage.loggerFor });
  const emailEvents = createEmailEventsHandler(() => ({ connector: stage.connector, enqueue: (log) => emailEventEnqueue(stage.enqueuer(log)), configurationSet: configurationSetName(APP, STAGE), now: stage.now, logSink }));
  const mediaIntakeDeps = { connector: stage.connector, objects: s3MediaObjects("Media", stage.s3), enqueue: (log: Logger) => mediaEventEnqueue(stage.enqueuer(log)), now: stage.now, mediaBucket: "Media", logSink };
  const mediaIntake = createMediaIntakeHandler(() => mediaIntakeDeps);
  const dispatch = createScheduleDispatchHandler(
    (log) => stage.timerDeps(log, "ScheduleDispatch"),
    () => ({ group: SCHEDULE_GROUP }),
    () => stage.loggerFor(`local-schedule-dispatch-${++requests}`),
  );
  const workers = new Map<CustomerQueue, EventWorker>();
  const workerOf = (queue: CustomerQueue): EventWorker => {
    let worker = workers.get(queue);
    if (worker === undefined) {
      worker = createEventWorker(workerDeps(stage, options, WORKER_ROLES[queue]));
      workers.set(queue, worker);
    }
    return worker;
  };
  return {
    inboundWhatsApp: (event) => inbound(event, context("InboundWhatsApp")),
    emailEvent: (event) => emailEvents(event, context("EmailEvents")),
    async mediaScanned(objectKey, verdict) {
      stage.s3.tag("Media", objectKey, SCAN_STATUS_TAG, verdict);
      const event = {
        source: "aws.guardduty",
        "detail-type": "GuardDuty Malware Protection Object Scan Result",
        account: ACCOUNT,
        time: stage.now().toISOString(),
        detail: { scanStatus: "COMPLETED", resourceType: "S3_OBJECT", s3ObjectDetails: { bucketName: "Media", objectKey }, scanResultDetails: { scanResultStatus: verdict } },
      };
      return mediaIntake(event, context("MediaIntake"));
    },
    async timerFire(worldId, timerKey) {
      const timer = await stage.connector.timers.getByKey(worldId, timerKey);
      if (timer === undefined) throw new Error(`no timer ${timerKey} in ${worldId}`);
      const scheduleArn = `arn:aws:scheduler:us-east-1:${ACCOUNT}:schedule/${SCHEDULE_GROUP}/${scheduleNameOf(worldId, timer.epoch, timerKey)}`;
      return dispatch({ worldId, timerKey, version: timer.version, epoch: timer.epoch, dueAtSim: timer.dueAtSim, scheduleArn }, context("ScheduleDispatch"));
    },
    drain: () =>
      stage.queues.drain({
        customer: (queue, record) => workerOf(queue)({ Records: [record] }),
        scanDeadline: async (body) => {
          await mediaIntake({ Records: [{ messageId: `local-deadline-${++requests}`, body, eventSource: "aws:sqs" }] }, context("MediaIntake"));
        },
      }),
  };
}
