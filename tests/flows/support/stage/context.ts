// The ports of the stage, built once per in-process world over the memory connector, the in-process
// mocks, the fake buckets, the fake queues and the scripted models (docs/test-plan.md §3, "Flujos
// locales"). Each piece is what a Lambda's `stage*` / `production*` builder would hand its modules, with
// the link replaced by a local value: the gate is the real `createOutboundGate`, the email client the
// real `createEmailClient` (its SES call recorded with the exact MIME), the WhatsApp transport the real
// simulated one, the producer the real `createEnqueuer`. A function of the stage that calls the core
// does it with its own role (`mocks.core(<caller>)`), so the mocks' per-role fences hold here too.
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { addressHash } from "@reclamo/shared";
import { type EmailClient, type SesSendFn, createEmailClient } from "@reclamo/bff/channels/email/outbound";
import { configurationSetName } from "@reclamo/bff/channels/email/config";
import type { EmailObjectStore } from "@reclamo/bff/channels/email/store";
import { simulatedWhatsAppTransport } from "@reclamo/bff/channels/whatsapp/simulated-transport";
import { referenceTemplateStatus } from "@reclamo/bff/channels/whatsapp/template-records";
import type { AnchorRequest, AnchorRequester } from "@reclamo/bff/complaints/anchors";
import { MemoryAnchorLog } from "@reclamo/bff/complaints/testing";
import { writeAnchors } from "@reclamo/bff/handlers/anchor-writer";
import type { ComplaintsDeps } from "@reclamo/bff/complaints/deps";
import type { Connector } from "@reclamo/bff/connector/port";
import { type Clock, worldClock } from "@reclamo/bff/lib/clock";
import { ulid } from "@reclamo/bff/lib/crypto";
import { type Logger, createLogger } from "@reclamo/bff/lib/log";
import type { ChannelModes } from "@reclamo/bff/lib/resource";
import type { OutboundDeps } from "@reclamo/bff/outbound/deps";
import { coreCustomerReader, coreDebtReader, coreRecipients, personaRecipients, simulatorEmailDirectory } from "@reclamo/bff/outbound/directory";
import { s3DocumentStore } from "@reclamo/bff/outbound/documents";
import { createOutboundGate } from "@reclamo/bff/outbound/gate";
import type { OutboundGate } from "@reclamo/bff/outbound/types";
import type { TimerDeps } from "@reclamo/bff/timers/deps";
import { enqueuerSink } from "@reclamo/bff/timers/sink";
import { type Enqueuer, createEnqueuer } from "@reclamo/bff/worker/enqueue";
import type { S3Client } from "@aws-sdk/client-s3";
import { LOCAL_KEYS, PHONE_HASH_SUBKEY } from "../keys";
import type { CoreCallerRole, InProcessMocks, NetworkCallerRole } from "../mocks";
import type { FakeS3 } from "../fakes/s3";
import { type FakeQueues, queueUrlOf } from "../fakes/queue";
import type { EvalClassifier, EvalReceiptReader, ScriptedGuardrails } from "../fakes/models";

export const APP = "aws-cds-hackathon-poc-reclamo";
export const STAGE = "poc";
/** Email is live on the stage (against SES's mailbox simulator); WhatsApp is simulated in every world. */
export const LOCAL_CHANNEL_MODES: ChannelModes = { email: "live", whatsapp: { liveWorlds: [] } };

/** One `SendEmail` the email client made: the exact input (raw MIME included) and the id SES answered. */
export interface SentEmail {
  readonly input: SendEmailCommandInput;
  readonly providerMessageId: string;
}

export interface StageInput {
  readonly connector: Connector;
  readonly mocks: InProcessMocks;
  readonly s3: FakeS3;
  readonly queues: FakeQueues;
  readonly classifier: EvalClassifier;
  readonly reader: EvalReceiptReader;
  readonly guardrails: ScriptedGuardrails;
  /** Real time of the world (fixed; only a test moves it). */
  readonly now: () => Date;
  /** Every JSON log line the stage's modules wrote. */
  readonly lines: string[];
}

export interface StageContext extends StageInput {
  readonly realClock: Clock;
  /** Every `AnchorWriter` request the chains made (the stage invokes it asynchronously). */
  readonly anchors: AnchorRequest[];
  /** The anchor log group: what the real `writeAnchors` put, read back by the register's verification. */
  readonly anchorLog: MemoryAnchorLog;
  /** The chains' requester: records the request and runs `AnchorWriter` in process at once. */
  readonly anchorRequester: AnchorRequester;
  readonly emails: SentEmail[];
  readonly email: EmailClient;
  loggerFor(correlationId: string): Logger;
  /** Deterministic ids: `<prefix>-l<n>`, one counter per world. */
  newId(prefix: string): string;
  /** The world's simulated "now" from its stored clock. */
  simNow(worldId: string): Promise<Date>;
  complaints(log: Logger): ComplaintsDeps;
  /** The real gate as it runs inside the function whose role calls the core. */
  gate(caller: CoreCallerRole): OutboundGate;
  outboundDeps(caller: CoreCallerRole, log: Logger): OutboundDeps;
  enqueuer(log: Logger): Enqueuer;
  /** The timers' deps of a function: its producer and, when its role reaches the networks, their client. */
  timerDeps(log: Logger, networks?: NetworkCallerRole): TimerDeps;
}

const noWait = async (): Promise<void> => undefined;

function documentsBucket(s3: FakeS3): EmailObjectStore {
  return { put: async (key, body, contentType) => s3.put("Documents", key, body, contentType) };
}

/** The fake bucket where the S3 helpers of the BFF take an `S3Client` (they only call `send`). */
export function asS3Client(s3: FakeS3): S3Client {
  return s3 as unknown as S3Client;
}

export function createStageContext(input: StageInput): StageContext {
  const { connector, mocks, s3, now } = input;
  const realClock: Clock = { now: async () => now() };
  const anchors: AnchorRequest[] = [];
  const anchorLog = new MemoryAnchorLog();
  const emails: SentEmail[] = [];
  let ids = 0;
  let entropy = 0;
  const random = (size: number): Uint8Array => {
    entropy += 1;
    return Uint8Array.from({ length: size }, (_, index) => (entropy * 37 + index * 11) % 256);
  };
  const loggerFor = (correlationId: string): Logger => createLogger({ correlationId, level: "debug", now, sink: (line) => void input.lines.push(line) });
  const log = loggerFor("local-stage");
  const anchorRequester: AnchorRequester = {
    async request(request) {
      anchors.push(request);
      await writeAnchors(request, { connector, sink: anchorLog.sink(), log, now });
    },
  };
  const sesSend: SesSendFn = async (sendInput) => {
    const providerMessageId = `0100019a-local-${String(emails.length + 1).padStart(4, "0")}-000000`;
    emails.push({ input: sendInput, providerMessageId });
    return { MessageId: providerMessageId };
  };
  const email = createEmailClient({
    connector,
    objects: { put: async (key, body, contentType) => s3.put("Emails", key, body, contentType) },
    sendRaw: sesSend,
    demoRecipients: () => [],
    configurationSet: configurationSetName(APP, STAGE),
    stage: STAGE,
    now,
    newMailId: () => ulid(now().getTime(), random),
    log,
  });
  const simNow = (worldId: string): Promise<Date> => worldClock(worldId, connector.runtime.clockState, realClock).now();
  const newId = (prefix: string): string => `${prefix}-l${String(++ids).padStart(6, "0")}`;
  const complaints = (callLog: Logger): ComplaintsDeps => ({
    connector,
    chainKey: LOCAL_KEYS.registerChain,
    anchors: anchorRequester,
    log: callLog,
    realNow: now,
    newId,
    retry: { sleep: noWait, random: () => 0 },
  });
  const simulated = simulatedWhatsAppTransport({ data: connector, recipients: personaRecipients, templates: referenceTemplateStatus(connector), realClock, log, newWamid: (nowMs) => `wamid.SIM.${ulid(nowMs, random)}` });
  const outboundDeps = (caller: CoreCallerRole, callLog: Logger): OutboundDeps => {
    const core = mocks.core(caller);
    return {
      chains: complaints(callLog),
      simNow,
      customers: coreCustomerReader(core),
      emails: simulatorEmailDirectory,
      recipients: coreRecipients({ core, simNow, stageModes: LOCAL_CHANNEL_MODES }),
      phoneHash: (phoneE164) => addressHash("WHATSAPP", phoneE164, PHONE_HASH_SUBKEY),
      debts: coreDebtReader(core),
      documents: s3DocumentStore({ bucket: "Documents", reference: connector, client: asS3Client(s3) }),
      guardrail: input.guardrails.g2,
      email,
      whatsapp: { simulated },
      stageModes: LOCAL_CHANNEL_MODES,
      demoRecipients: () => ({ emails: [], phones: [] }),
      newNonce: (nowMs) => ulid(nowMs, random),
    };
  };
  const gates = new Map<string, OutboundGate>();
  const enqueuer = (callLog: Logger): Enqueuer => createEnqueuer({ data: connector, send: input.queues.send, queueUrl: queueUrlOf, now, log: callLog, sleep: noWait });
  return {
    ...input,
    realClock,
    anchors,
    anchorLog,
    anchorRequester,
    emails,
    email,
    loggerFor,
    newId,
    simNow,
    complaints,
    outboundDeps,
    gate(caller) {
      let gate = gates.get(caller);
      if (gate === undefined) {
        gate = createOutboundGate(outboundDeps(caller, loggerFor(`local-gate-${caller}`)));
        gates.set(caller, gate);
      }
      return gate;
    },
    enqueuer,
    timerDeps(callLog, networks) {
      return {
        connector,
        sink: enqueuerSink(enqueuer(callLog)),
        ...(networks === undefined ? {} : { networks: mocks.networks(networks) }),
        log: callLog,
        realNow: now,
        newId,
      };
    },
  };
}

/** `Documents` as complaints/ and the worker's written answer write their PDFs. */
export function documentStore(s3: FakeS3): () => EmailObjectStore {
  const store = documentsBucket(s3);
  return () => store;
}
