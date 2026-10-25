// Test support of the intake: the real adapter and the real intake over the memory connector, with a
// recording gate, a fake core (customers by phone hash, masked document and email), the real single
// queue producer over a recording `SendMessage`, the real complaints module (chain key of the tests,
// no anchors) and a scripted model. Nothing here is used outside tests and local flows.
import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import type { ChannelMode } from "@reclamo/shared";
import type { MemoryConnector } from "../connector/memory/connector";
import { TEST_NOW, testConnector, worldMeta, worldSettings } from "../connector/testing";
import type { ComplaintsDeps } from "../complaints/deps";
import { TEST_CHAIN_KEY, TEST_HOLIDAYS } from "../complaints/testing";
import { keys } from "../connector/keys";
import type { CoreClient } from "../core/client";
import { CoreError } from "../core/errors";
import type { WhatsAppInboundDeps } from "../channels/whatsapp/ports";
import { MemoryBucket, TEST_PHONE, TEST_PHONE_KEY, TEST_SIM_KEYS, TEST_TOPIC_ARN, testPhoneHash, testSnsVerifier } from "../channels/whatsapp/testing";
import { SIM_NOW } from "../connector/testing";
import { fixedClock } from "../lib/clock";
import { type Logger, createLogger } from "../lib/log";
import { MemoryObjects } from "../media-intake/testing";
import type { GateOutcome, OutboundCall, OutboundGate, OutboundRequest } from "../outbound/types";
import type { UnknownSenderReply } from "../outbound/unknown-sender";
import { createEnqueuer } from "../worker/enqueue";
import { createIntake } from "./accept";
import type { ConsentRecorder } from "./effects";
import { intakeEffects } from "./effects";
import type { IntakeModel, ModelOutcome } from "./model";
import { gateFixedReplies } from "./replies";

export { SIM_NOW, TEST_NOW, TEST_PHONE };
export const WORLD = "g07";
export const CUSTOMER = "cus-0001";

export interface RecordedGate {
  readonly gate: OutboundGate;
  readonly requests: OutboundRequest[];
}

/** A gate that allows everything and records what it was asked (the real one is tested in outbound/). */
export function recordingGate(decide: (request: OutboundRequest) => GateOutcome = (request) => ({ ok: true, decision: "ALLOWED", messageId: request.messageId ?? "msg-gate", ruleIds: [], providerMessageId: "prov-1" })): RecordedGate {
  const requests: OutboundRequest[] = [];
  return {
    requests,
    gate: async (request: OutboundRequest, _call: OutboundCall) => {
      requests.push(request);
      return decide(request);
    },
  };
}

/** A core with one customer per phone hash; every customer has the same masked document and email. */
export function fakeCore(customersByHash: Readonly<Record<string, string>>, calls: string[] = []): CoreClient {
  const call = async (operation: string, ctx: { worldId: string; simNow?: string }, input: { params: Record<string, string> }) => {
    calls.push(operation);
    if (operation === "getCustomerByPhone") {
      const customerId = customersByHash[`${ctx.worldId}#${input.params.phoneHash ?? ""}`];
      if (customerId === undefined) throw new CoreError("NOT_FOUND", "no customer with that phone", { attempts: 1, status: 404 });
      return { customerId };
    }
    if (operation === "recordWhatsAppOptOut") return { optedOut: true, changed: true, optedOutAtSim: ctx.simNow ?? SIM_NOW };
    if (operation === "getCustomer") {
      return { customerId: input.params.customerId, firstName: "Valeria", emailMasked: "s•••@simulator.amazonses.com", document: { type: "DNI", numberMasked: "••••4417" } };
    }
    throw new Error(`unexpected core operation ${operation}`);
  };
  return { call: call as unknown as CoreClient["call"], health: async () => ({ status: "ok" }) as never };
}

/** A model that answers what the test scripts, and counts its calls. */
export function scriptedModel(answer: ModelOutcome | ((text: string) => ModelOutcome)): IntakeModel & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    classify: async (text) => {
      calls.push(text);
      return typeof answer === "function" ? answer(text) : answer;
    },
  };
}

export interface IntakeRig {
  readonly mc: MemoryConnector;
  readonly deps: WhatsAppInboundDeps;
  /** The same ports with the acknowledgement's `coldStart` set (the handler's factory). */
  depsFor(coldStart: boolean): WhatsAppInboundDeps;
  readonly gate: RecordedGate;
  readonly sent: SendMessageCommandInput[];
  readonly coreCalls: string[];
  readonly objects: MemoryObjects;
  readonly bucket: MemoryBucket;
  readonly lines: Record<string, unknown>[];
  readonly phoneHash: string;
  /** `gate:<kind>` and `sqs:<type>` in the order they happened. */
  readonly timeline: string[];
  /** The fixed replies to a number without a customer (outbound/unknown-sender.ts). */
  readonly unknownReplies: UnknownSenderReply[];
}

export interface IntakeRigOptions {
  readonly worldId?: string;
  readonly customerId?: string;
  /** No customer for the test phone (FL-002). */
  readonly unlinked?: boolean;
  readonly model?: IntakeModel;
  readonly mode?: ChannelMode;
  readonly status?: "READY" | "RESETTING";
  readonly consent?: ConsentRecorder;
  readonly coldStart?: boolean;
  readonly gate?: RecordedGate;
  /** Real-clock instant after the acknowledgement left (`ackLatencyMs`). */
  readonly ackAcceptedAt?: Date;
}

/** A world `READY` at epoch 1 with a paused clock at `SIM_NOW`, and the whole inbound path over it. */
export async function intakeRig(options: IntakeRigOptions = {}): Promise<IntakeRig> {
  const worldId = options.worldId ?? WORLD;
  const customerId = options.customerId ?? CUSTOMER;
  const mc = testConnector({ now: () => new Date(TEST_NOW.getTime()) });
  const data = mc.connector;
  await data.worlds.register(worldMeta(worldId, { status: options.status ?? "READY" }));
  await data.worlds.putSettings({ ...worldSettings(worldId), channelModes: { whatsapp: options.mode ?? "simulated" }, rateLimitPerHour: 20 });
  await data.runtime.putClock({ worldId, mode: "PAUSED", pausedSimNow: new Date(SIM_NOW).toISOString(), worldEpoch: 1 });
  await data.transact([data.counters.initEpochOp(worldId, 1)]);

  const phoneHash = await testPhoneHash();
  const coreCalls: string[] = [];
  const core = fakeCore(options.unlinked ? {} : { [`${worldId}#${phoneHash}`]: customerId }, coreCalls);
  const gate = options.gate ?? recordingGate();
  const sent: SendMessageCommandInput[] = [];
  const timeline: string[] = [];
  const traced: OutboundGate = async (request, call) => {
    timeline.push(`gate:${request.kind}`);
    return gate.gate(request, call);
  };
  const unknownReplies: UnknownSenderReply[] = [];
  const unknownSender = async (reply: UnknownSenderReply): Promise<GateOutcome> => {
    unknownReplies.push(reply);
    timeline.push("gate:UNKNOWN_SENDER");
    return { ok: true, decision: "ALLOWED", messageId: reply.messageId, ruleIds: [] };
  };
  const lines: Record<string, unknown>[] = [];
  const log: Logger = createLogger({ sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), level: "debug", correlationId: "corr-intake-0001" });
  let counter = 0;
  const complaints: ComplaintsDeps = {
    connector: data,
    chainKey: TEST_CHAIN_KEY,
    anchors: { request: async () => undefined },
    log,
    realNow: () => new Date(TEST_NOW.getTime()),
    newId: (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`,
    retry: { sleep: async () => undefined, random: () => 0 },
  };
  const send = async (input: SendMessageCommandInput): Promise<void> => {
    sent.push(input);
    timeline.push(`sqs:${(JSON.parse(input.MessageBody ?? "{}") as { type?: string }).type ?? "SCAN_DEADLINE"}`);
  };
  const enqueuer = createEnqueuer({ data, send, queueUrl: (queue) => `https://sqs.us-east-1.amazonaws.com/776805327629/reclamo-poc-${queue}`, now: () => TEST_NOW, log, sleep: async () => undefined });
  const objects = new MemoryObjects();
  const bucket = new MemoryBucket();
  const realNow = (): Date => new Date(TEST_NOW.getTime());
  const effectPorts = { complaints, gate: traced, core: () => core, consent: options.consent ?? { optOut: async () => false }, documents: () => ({ put: async () => undefined }), realNow };
  const depsFor = (coldStart: boolean): WhatsAppInboundDeps => ({
    data,
    keys: { phoneHash: TEST_PHONE_KEY, simEnvelope: TEST_SIM_KEYS },
    topicArn: TEST_TOPIC_ARN,
    sns: testSnsVerifier().verifier,
    stageModes: { email: "live", whatsapp: { liveWorlds: [] } },
    customers: {
      findByPhoneHash: async (world, hash) => {
        try {
          return await core.call("getCustomerByPhone", { worldId: world, simNow: SIM_NOW }, { params: { phoneHash: hash } });
        } catch (error) {
          if (error instanceof CoreError) return undefined;
          throw error;
        }
      },
    },
    replies: gateFixedReplies({ gate: traced, unknownSender, log }),
    effects: intakeEffects({ ...effectPorts, data, log }),
    intake: createIntake({
      data,
      classifier: { realNow, ...(options.model === undefined ? {} : { model: options.model }) },
      acknowledge: { complaints, gate: traced, core: () => core, realNow: () => options.ackAcceptedAt ?? realNow(), coldStart },
      effects: effectPorts,
      media: { objects, now: realNow },
      enqueuer,
      log,
    }),
    bucket,
    realClock: fixedClock(TEST_NOW),
    log,
  });
  return { mc, deps: depsFor(options.coldStart ?? false), depsFor, gate, sent, coreCalls, objects, bucket, lines, phoneHash, timeline, unknownReplies };
}

/** The bodies of the customer events sent to SQS, parsed. */
export function sentEvents(rig: Pick<IntakeRig, "sent">): Array<Record<string, unknown> & { type: string; payload: Record<string, unknown> }> {
  return rig.sent.filter((input) => !(input.QueueUrl ?? "").endsWith("ScanDeadlines")).map((input) => JSON.parse(input.MessageBody ?? "{}") as Record<string, unknown> & { type: string; payload: Record<string, unknown> });
}

/** The Argentine holidays of the tests in `Reference/HOLIDAY#AR` (Monday 12/10 is not a business day). */
export async function seedHolidays(rig: Pick<IntakeRig, "mc">): Promise<void> {
  for (const date of TEST_HOLIDAYS) await rig.mc.store.write({ kind: "put", table: "Reference", item: { ...keys.reference("HOLIDAY", "AR", date), date } });
}

/** A synthetic receipt the seed rendered: its SHA-256 in `Reference/SEED_RECEIPT_HASH#SHA256`. */
export async function seedReceiptHash(rig: Pick<IntakeRig, "mc">, sha256: string, seedKey: string): Promise<void> {
  await rig.mc.store.write({ kind: "put", table: "Reference", item: { ...keys.reference("SEED_RECEIPT_HASH", "SHA256", sha256), sha256, seedKey } });
}

export function linesNamed(rig: Pick<IntakeRig, "lines">, message: string): Record<string, unknown>[] {
  return rig.lines.filter((line) => line.message === message);
}
