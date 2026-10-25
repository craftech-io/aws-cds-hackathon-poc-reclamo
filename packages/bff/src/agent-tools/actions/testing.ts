// Test kit of the effect targets (`actions`, `complaints`, `messaging`, `handoff`): the tool world of
// common/testing.ts (world `qa-tools`, customer `cus-0001`) with its epoch and settings, the REAL core and
// network mocks running in process behind their real clients (so claims, caps and `CONFLICT` are the
// mocks' own), complaints/ over the same connector with a test chain key, and a recording outbound gate
// whose decision each test can choose. Synthetic data only.
import { createCoreApp } from "@reclamo/core-mock/app";
import { callerDirectory } from "@reclamo/core-mock/http/caller";
import { type CustomerSpec, coreWorld } from "@reclamo/core-mock/ledger/testing";
import { createInProcessNetworkMock, inProcessNetworkFetch } from "@reclamo/network-mock/testing";
import { fail } from "@reclamo/shared";
import type { AnchorRequest } from "../../complaints/anchors";
import type { ComplaintsDeps } from "../../complaints/deps";
import { TEST_CHAIN_KEY } from "../../complaints/testing";
import { TEST_NOW, worldSettings } from "../../connector/testing";
import { type CoreClient, type CoreTransport, createCoreClient } from "../../core/client";
import { sigV4Signer } from "../../core/signer";
import { createLogger } from "../../lib/log";
import { type NetworkClient, createNetworkClient } from "../../networks/client";
import type { GateOutcome, OutboundCall, OutboundGate, OutboundRequest } from "../../outbound/types";
import { WORLD, type ToolWorld, toolWorld } from "../common/testing";

const ENDPOINT = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";
const ACCOUNT = "776805327629";
const CORE_ROLE = `arn:aws:iam::${ACCOUNT}:role/reclamo-poc-ToolActionsRole`;
const CORE_SESSION = `arn:aws:sts::${ACCOUNT}:assumed-role/reclamo-poc-ToolActionsRole/fn`;
const silent = createLogger({ sink: () => undefined });
const noSleep = async () => undefined;

/** The real core app in process with these customers in the tool world. */
export function inProcessCore(customers: readonly CustomerSpec[]) {
  const store = coreWorld(customers, WORLD);
  const app = createCoreApp({ store, callers: callerDirectory({ roles: { ToolActions: CORE_ROLE } }) });
  const transport: CoreTransport = async (request) => {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const response = await app({ method: request.method, path: request.url.pathname, query: Object.fromEntries(request.url.searchParams), headers, ...(request.body === undefined ? {} : { body: request.body }), callerArn: CORE_SESSION, requestId: "r" });
    return { status: response.statusCode, text: response.body };
  };
  const client: CoreClient = createCoreClient({ endpoint: ENDPOINT, transport, logger: silent, sleep: noSleep });
  return { store, client };
}

/** The real network mock in process, the tool world seeded. */
export function inProcessNetworks() {
  const mock = createInProcessNetworkMock();
  mock.seedWorld(WORLD);
  const client: NetworkClient = createNetworkClient({
    endpoint: ENDPOINT,
    sign: sigV4Signer({ credentials: { accessKeyId: "AKIDTESTONLY", secretAccessKey: "test-only-secret" }, signingDate: () => TEST_NOW }),
    fetch: inProcessNetworkFetch(mock.app, "ToolActions"),
    sleep: noSleep,
    random: () => 0.5,
    logger: silent,
  });
  return { mock, client };
}

export interface RecordedSend {
  readonly request: OutboundRequest;
  readonly call: OutboundCall;
}

/** A gate that records every request and answers `ALLOWED` unless the test says otherwise. */
export function recordingGate() {
  const sent: RecordedSend[] = [];
  let decide: (request: OutboundRequest, index: number) => GateOutcome = (request, index) => ({
    ok: true,
    decision: "ALLOWED",
    messageId: request.messageId ?? `msg-gate-${index}`,
    ruleIds: [],
    ...(request.channel === "EMAIL" ? { mailId: `mail-gate-${index}` } : { providerMessageId: `wamid-gate-${index}` }),
  });
  const gate: OutboundGate = async (request, call) => {
    sent.push({ request, call });
    return decide(request, sent.length);
  };
  return {
    gate,
    sent,
    answerWith(next: (request: OutboundRequest, index: number) => GateOutcome) {
      decide = next;
    },
  };
}

/** A gate answer: the policy blocked it (with the rule) and offered the permitted paths. */
export function blocked(ruleId: string): GateOutcome {
  return { ok: false, decision: "BLOCKED", messageId: "msg-blocked", tapeId: "tape-blocked", ruleIds: [ruleId], reroutes: [{ route: "HUMAN_QUEUE" }], failure: fail("POLICY_DENIED", `blocked by ${ruleId}`, ruleId) };
}

export interface EffectWorld extends ToolWorld {
  readonly core: ReturnType<typeof inProcessCore>;
  readonly networks: ReturnType<typeof inProcessNetworks>;
  readonly gate: ReturnType<typeof recordingGate>;
  readonly anchors: AnchorRequest[];
  readonly complaintsDeps: () => ComplaintsDeps;
}

type Settings = ReturnType<typeof worldSettings>;

/** The default settings with other caps for some actions (`{ REVERSE_CHARGE: { agentCents, operatorCents } }`). */
export function withCaps(perAction: Partial<Settings["caps"]["perAction"]>): (settings: Settings) => Settings {
  return (settings) => ({ ...settings, caps: { ...settings.caps, perAction: { ...settings.caps.perAction, ...perAction } } });
}

/** The tool world with epoch 1, the settings, the mocks, complaints/ and a recording gate. */
export async function effectWorld(customers: readonly CustomerSpec[] = [{ customerId: "cus-0001" }], settings: (base: Settings) => Settings = (base) => base): Promise<EffectWorld> {
  const world = await toolWorld();
  await world.connector.transact([world.connector.counters.initEpochOp(WORLD, 1)]);
  await world.connector.worlds.putSettings(settings(worldSettings(WORLD)));
  const anchors: AnchorRequest[] = [];
  let ids = 0;
  const complaintsDeps = (): ComplaintsDeps => ({
    connector: world.connector,
    chainKey: TEST_CHAIN_KEY,
    anchors: { request: async (request) => void anchors.push(request) },
    log: silent,
    realNow: () => TEST_NOW,
    newId: (prefix) => `${prefix}-t${String(++ids).padStart(4, "0")}`,
    retry: { sleep: noSleep, random: () => 0 },
  });
  return { ...world, core: inProcessCore(customers), networks: inProcessNetworks(), gate: recordingGate(), anchors, complaintsDeps };
}
