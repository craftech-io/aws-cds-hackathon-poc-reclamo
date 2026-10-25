/// <reference path="../../sst-env.d.ts" />
// What `InboundWhatsApp` runs with in the stage (infra/messaging-whatsapp.ts), from what SST links into
// the function through lib/resource.ts and lib/secrets.ts, never `process.env`:
//
//   data         DynamoDB                                          connector/dynamo
//   keys         `PhoneHashKey` (subkey `phone-hash`), `SimEnvelopeKey` (`console`), `QaSimEnvelopeKey` (`qa`)
//   sns          the SNS signature verifier (certificate cached per container)
//   customers    the core's `getCustomerByPhone`                   CoreMock (Function URL)
//   consent      the core's `recordWhatsAppOptOut` (FL-006)        CoreMock (Function URL)
//   gate         `sendThroughGate`, the one exit                   outbound/gate.ts
//   complaints   chain key, `AnchorWriter`, milestones             RegisterChainKey, AnchorWriter, Scheduler (optional)
//   model        `Resource.Classifier.modelId` (optional until WP-31 links it)
//   queues       the single producer (worker/enqueue.ts)           the three customer queues and ScanDeadlines
//   media        `Media` (and `Seed` for the copies of synthetic receipts), live media once a number is configured
//
// Heavy clients are built once per container; the ports that carry the invocation's logger per event.
import { ChannelError, ToolError } from "@reclamo/shared";
import { s3EmailObjectStore } from "../channels/email/store";
import { NOT_CONNECTED } from "../channels/whatsapp/live-transport";
import { s3MediaBucket } from "../channels/whatsapp/media-store";
import type { CustomerDirectory, WhatsAppInboundDeps } from "../channels/whatsapp/ports";
import type { MediaBucket } from "../channels/whatsapp/transport";
import { createSnsVerifier } from "../channels/whatsapp/sns-signature";
import { waInboundTopicArn } from "../channels/whatsapp/config";
import { type ComplaintsDeps, type MilestoneScheduler, stageComplaintsDeps } from "../complaints/deps";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import type { CoreClient } from "../core/client";
import { CoreError } from "../core/errors";
import { linkedCoreClient } from "../core/linked";
import { systemClock, worldClock } from "../lib/clock";
import { deriveSubkey } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { bucketName, channelModes } from "../lib/resource";
import { keySecret, secretValue } from "../lib/secrets";
import { s3MediaObjects } from "../media-intake/objects";
import { sendThroughGate } from "../outbound/gate";
import { sendToUnknownSender } from "../outbound/unknown-sender";
import { timerMilestoneScheduler } from "../timers/milestones";
import { linkedScheduleGroup, stageTimerDeps } from "../timers/stage";
import { linkedEnqueuer } from "../worker/enqueue";
import { createIntake } from "./accept";
import type { ConsentRecorder } from "./effects";
import { intakeEffects } from "./effects";
import { linkedIntakeModel } from "./model";
import { gateFixedReplies } from "./replies";

/** `phoneHash` → customer through the core; `NOT_FOUND` is a number without a customer (FL-002). */
export function coreCustomerDirectory(core: () => CoreClient, data: Pick<Connector, "runtime">, correlationId: string): CustomerDirectory {
  return {
    async findByPhoneHash(worldId, phoneHash) {
      const simNow = (await worldClock(worldId, data.runtime.clockState).now()).toISOString();
      try {
        return await core().call("getCustomerByPhone", { worldId, simNow, correlationId }, { params: { phoneHash } });
      } catch (error) {
        if (error instanceof CoreError && error.code === "NOT_FOUND") return undefined;
        throw error;
      }
    },
  };
}

/**
 * The customer's opt-out in the core (`recordWhatsAppOptOut`), where the channel policy reads consent
 * (`CH-OPTOUT`, outbound/context.ts). Idempotent by the message that carried it; a core that does not
 * answer throws, so the inbound record is delivered again and the opt-out is never lost.
 */
export function coreConsentRecorder(core: () => CoreClient, correlationId: string): ConsentRecorder {
  return {
    async optOut(input) {
      await core().call("recordWhatsAppOptOut", { worldId: input.worldId, simNow: input.atSim, correlationId }, { params: { customerId: input.customerId }, body: { via: input.via, idempotencyKey: `${input.caller.eventId}:opt-out` } });
      return true;
    },
  };
}

/** The schedules of the milestones where `Scheduler` is linked (the role holds `TIMERS`). */
function linkedMilestones(log: Logger): MilestoneScheduler | undefined {
  return linkedScheduleGroup() === undefined ? undefined : timerMilestoneScheduler(stageTimerDeps(log, { networks: false, scheduler: true }));
}

function phoneNumberId(): string | undefined {
  try {
    const value = secretValue("WhatsAppPhoneNumberId");
    return value === NOT_CONNECTED ? undefined : value;
  } catch (error) {
    if (error instanceof ToolError) return undefined;
    throw error;
  }
}

/** `Media`, and `Seed` for the server-side copy of a synthetic receipt; without `Seed` linked only that copy fails. */
function inboundMediaBucket(): MediaBucket {
  let seedBucket: string | undefined;
  try {
    seedBucket = bucketName("Seed");
  } catch {
    // Not linked to this function: every other operation of `Media` still works.
    seedBucket = undefined;
  }
  const bucket = s3MediaBucket({ mediaBucket: bucketName("Media"), seedBucket: seedBucket ?? "" });
  if (seedBucket !== undefined) return bucket;
  return {
    ...bucket,
    copyFromSeed: async () => {
      throw new ChannelError("UNAVAILABLE", "WHATSAPP", "the Seed bucket is not linked to InboundWhatsApp", { retryable: false });
    },
  };
}

/** A value built on its first use and kept for the container. */
function once<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

const container = {
  data: once(dynamoConnector),
  keys: once(() => ({ phoneHash: deriveSubkey("PhoneHashKey", keySecret("PhoneHashKey"), "phone-hash"), simEnvelope: { console: keySecret("SimEnvelopeKey"), qa: keySecret("QaSimEnvelopeKey") } })),
  sns: once(() => createSnsVerifier()),
  bucket: once(inboundMediaBucket),
  objects: once(() => s3MediaObjects(bucketName("Media"))),
  documents: once(() => s3EmailObjectStore(bucketName("Documents"))),
  phoneNumberId: once(phoneNumberId),
};

/** The deps of one invocation of `InboundWhatsApp`. */
export function stageInboundDeps(log: Logger, coldStart: boolean): WhatsAppInboundDeps {
  const data = container.data();
  const now = (): Date => new Date();
  const complaints: ComplaintsDeps = { ...stageComplaintsDeps({ log, ...withMilestones(log) }), connector: data };
  const effectPorts = { complaints, gate: sendThroughGate, core: linkedCoreClient, consent: coreConsentRecorder(linkedCoreClient, log.correlationId), documents: container.documents, realNow: now };
  const enqueuer = linkedEnqueuer(data, log);
  const model = linkedIntakeModel(log);
  const liveNumber = container.phoneNumberId();
  return {
    data,
    keys: container.keys(),
    topicArn: waInboundTopicArn(),
    sns: container.sns(),
    stageModes: channelModes(),
    customers: coreCustomerDirectory(linkedCoreClient, data, log.correlationId),
    replies: gateFixedReplies({ gate: sendThroughGate, unknownSender: sendToUnknownSender, log }),
    effects: intakeEffects({ ...effectPorts, data, log }),
    intake: createIntake({
      data,
      classifier: { realNow: now, ...(model === undefined ? {} : { model }) },
      acknowledge: { complaints, gate: sendThroughGate, core: linkedCoreClient, realNow: now, coldStart },
      effects: effectPorts,
      media: { objects: container.objects(), now },
      enqueuer,
      log,
    }),
    ...(liveNumber === undefined ? {} : { liveMedia: { phoneNumberId: liveNumber, mediaBucketName: bucketName("Media") } }),
    bucket: container.bucket(),
    realClock: systemClock,
    log,
  };
}

function withMilestones(log: Logger): { milestones?: MilestoneScheduler } {
  const milestones = linkedMilestones(log);
  return milestones === undefined ? {} : { milestones };
}
