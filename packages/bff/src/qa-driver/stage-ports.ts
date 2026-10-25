/// <reference path="../../sst-env.d.ts" />
// The QaDriver's ports inside the stage (docs/architecture.md §14 row `QaDriver`, infra/bff.ts): what SST
// links into the Lambda, read through lib/resource.ts and lib/secrets.ts (never `process.env`), built once
// per container and lazily, so an action that does not need a link never reads it. Each port is the module
// that owns the thing (the world factory, the clock, the gate, the enqueuer, the sign-up service), with the
// driver's own role: IAM and the invoked Lambdas fence it again.
import { randomBytes } from "node:crypto";
import { addressHash } from "@reclamo/shared";
import { checkRecipientFence } from "../channels/email/recipient-fence";
import { stageEmailClient } from "../channels/email/stage";
import type { WhatsAppTransport } from "../channels/whatsapp/transport";
import { cloudWatchAnchorReader } from "../complaints/anchors";
import { dynamoConnector } from "../connector/dynamo/connector";
import { DynamoStore } from "../connector/dynamo/engine";
import { linkedCoreClient } from "../core/linked";
import { signupService } from "../guests/signup";
import { stageSignupDeps } from "../guests/runtime";
import { deriveSubkey } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import { channelModes, readLinked } from "../lib/resource";
import { keySecret } from "../lib/secrets";
import { linkedNetworkClient } from "../networks/linked";
import { createBedrockG2 } from "../outbound/g2";
import { createOutboundGate } from "../outbound/gate";
import { LeadNoticeLink, sesLeadNoticeTransport } from "../outbound/transports/lead-notice";
import { stageOutboundDeps } from "../outbound/stage";
import { readReceiptImage } from "../receipts/reader";
import { linkedBedrockReceiptReader } from "../receipts/linked";
import { defaultDeps } from "../routers/deps";
import { type SimulatorPorts, lambdaInboundDelivery, s3UploadPresigner } from "../routers/simulator";
import { worldWhatsAppMode } from "../channels/whatsapp/registry";
import { SchedulerLink } from "../timers/scheduler-client";
import { stageTimerDeps } from "../timers/stage";
import { linkedG1Prefilter } from "../turns/prefilter";
import { linkedEnqueuer } from "../worker/enqueue";
import { lambdaJanitorInvoker, stageWorldsDeps } from "../worlds/stage";
import type { QaPorts } from "./ports";
import { stageQaCognito } from "./stage-cognito";
import { stageTamper } from "./stage-tamper";
import {
  bffWithoutEdge,
  directMockInvoke,
  invokeLinked,
  malwarePlanStatus,
  mockUrlPost,
  qaDlqAlarmHistory,
  seedBytes,
  seedText,
  stageDlq,
  stageMemoryInspector,
  stageObjects,
} from "./stage-aws";
import { BATCH_INPUTS_SEED_KEY, MODELS_SEED_KEY, ModelsDocument, type ModelsSource, modelsSettlementKey } from "./world-models";

function once<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

/** The models, their files and the batch inputs, memoized for the container (they change only with a deploy). */
export function s3ModelsSource(): ModelsSource {
  let models: Promise<ModelsDocument> | undefined;
  const files = new Map<string, Promise<string>>();
  return {
    read() {
      models ??= seedText(MODELS_SEED_KEY).then((text) => ModelsDocument.parse(JSON.parse(text)));
      models.catch(() => (models = undefined));
      return models;
    },
    settlementCsv(seedPath) {
      let file = files.get(seedPath);
      if (file === undefined) {
        file = seedText(modelsSettlementKey(seedPath));
        files.set(seedPath, file);
        file.catch(() => files.delete(seedPath));
      }
      return file;
    },
    batchInputs: () => seedText(BATCH_INPUTS_SEED_KEY),
  };
}

/** `arn:aws:scheduler:<region>:<account>:schedule/<group>/<name>` of the app's group (the linked `Scheduler`). */
function scheduleArnOf(name: string): string {
  const link = readLinked("Scheduler", SchedulerLink);
  const [, , , region, account] = link.targetArn.split(":");
  return `arn:aws:scheduler:${region}:${account}:schedule/${link.groupName}/${name}`;
}

/** The phone simulator of `console.simulator.*` run by the driver: same path, signed with its own key (`kid = qa`). */
const qaSimulatorPorts = once((): SimulatorPorts => {
  const connector = dynamoConnector();
  return {
    connector,
    whatsAppMode: async (worldId) => worldWhatsAppMode(worldId, await connector.worlds.getSettings(worldId), channelModes()),
    envelopeKey: () => keySecret("QaSimEnvelopeKey"),
    envelopeKid: "qa",
    deliver: lambdaInboundDelivery(),
    presignUpload: s3UploadPresigner(),
  };
});

/** The real gate whose email transport records instead of calling SES; WhatsApp is the simulated one. */
function probeGate(log: Logger): ReturnType<QaPorts["probeGate"]> {
  const sent: { channel: string }[] = [];
  const deps = stageOutboundDeps(log);
  const simulated = deps.whatsapp.simulated;
  const recordingWhatsApp: WhatsAppTransport = {
    mode: simulated.mode,
    send: (request) => {
      sent.push({ channel: "WHATSAPP" });
      return simulated.send(request);
    },
  };
  const email = stageEmailClient({
    sendRaw: async () => {
      sent.push({ channel: "EMAIL" });
      return { MessageId: `qa-probe-${randomBytes(8).toString("hex")}` };
    },
    connector: deps.chains.connector,
    log,
  });
  return { gate: createOutboundGate({ ...deps, email, whatsapp: { simulated: recordingWhatsApp } }), sent: () => [...sent] };
}

/** 12+ characters with upper case, lower case and a digit (the pool's policy); used inside the Lambda only. */
export function newPassword(): string {
  return `Qa9-${randomBytes(18).toString("base64url")}`;
}

export function stagePorts(): QaPorts {
  const data = dynamoConnector();
  const now = () => new Date();
  const phoneKey = once(() => deriveSubkey("PhoneHashKey", keySecret("PhoneHashKey"), "phone-hash"));
  const cognito = once(() => stageQaCognito(now));
  const deliver = lambdaInboundDelivery();
  const log = createLogger({ bindings: { service: "qa-driver" } });
  return {
    data,
    store: new DynamoStore(),
    worlds: once(() => stageWorldsDeps({ log })),
    models: s3ModelsSource(),
    console: () => ({ ...defaultDeps(), simulatorPorts: qaSimulatorPorts() }),
    clock: (log) => stageTimerDeps(log, { networks: true, scheduler: true }),
    janitor: lambdaJanitorInvoker(log),
    enqueuer: (log) => linkedEnqueuer(data, log),
    inbound: { key: () => keySecret("QaSimEnvelopeKey"), deliver },
    objects: stageObjects,
    scheduleDispatch: { scheduleArn: scheduleArnOf, invoke: (input) => invokeLinked("ScheduleDispatch", input) },
    probeGate,
    g2: once(() => createBedrockG2()),
    g1: once(() => linkedG1Prefilter()),
    emailFence: (intent) => checkRecipientFence(intent, () => []),
    stageModes: channelModes,
    networks: linkedNetworkClient,
    phoneHash: (phoneE164) => addressHash("WHATSAPP", phoneE164, phoneKey()),
    mocks: {
      async health() {
        const [core, networks] = await Promise.allSettled([linkedCoreClient().health(), linkedNetworkClient().health()]);
        const state = (result: PromiseSettledResult<unknown>) => (result.status === "fulfilled" ? "OK" : result.reason instanceof Error ? result.reason.name : "FAILED");
        return { core: state(core), networks: state(networks) };
      },
      urlPost: mockUrlPost,
      directInvoke: directMockInvoke,
    },
    janitorDirect: (event) => invokeLinked("WorldJanitor", event),
    policyAudit: (worldId) => invokeLinked("PolicyAudit", { worldId }),
    receipts: {
      async read(input) {
        const bytes = await seedBytes(input.seedKey);
        return readReceiptImage({ worldId: input.worldId, bytes, contentType: "image/png", simNow: input.simNow, forceFallback: input.forceFallback }, { bedrock: linkedBedrockReceiptReader(log), log });
      },
    },
    cognito,
    signup: (log) => signupService(stageSignupDeps(log)),
    edge: bffWithoutEdge,
    noticeProbe: once(() => sesLeadNoticeTransport(readLinked("LeadNotice", LeadNoticeLink).from, undefined, "PROBE")),
    tamper: once(stageTamper),
    anchors: cloudWatchAnchorReader(),
    chainKey: () => keySecret("RegisterChainKey"),
    dlq: stageDlq(),
    alarmHistory: qaDlqAlarmHistory,
    malwarePlan: malwarePlanStatus,
    memory: once(stageMemoryInspector),
    newPassword,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
