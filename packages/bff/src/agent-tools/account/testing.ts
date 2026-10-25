// Test kit of the identity, account and investigation targets: the tool world of the wrapper tests
// (common/testing.ts: world `qa-tools`, customer `cus-0001`, turns opened as the worker opens them),
// with the REAL core and network mocks in process behind their real clients, the ownership those
// answer, the complaints deps of complaints/ over the same connector, and a gate that records what it
// is asked and answers `ALLOWED`. Synthetic data only.
import { createCoreApp } from "@reclamo/core-mock/app";
import { callerDirectory } from "@reclamo/core-mock/http/caller";
import { type CustomerSpec, coreWorld } from "@reclamo/core-mock/ledger/testing";
import type { MemoryCoreStore } from "@reclamo/core-mock/store/memory";
import { type InProcessNetworkMock, createInProcessNetworkMock, inProcessNetworkFetch } from "@reclamo/network-mock/testing";
import type { ComplaintsDeps } from "../../complaints/deps";
import { SIM_NOW, TEST_NOW, worldSettings } from "../../connector/testing";
import { type CoreClient, type CoreTransport, createCoreClient } from "../../core/client";
import { sigV4Signer } from "../../core/signer";
import { createLogger } from "../../lib/log";
import { type NetworkClient, createNetworkClient } from "../../networks/client";
import type { GateOutcome, OutboundGate, OutboundRequest } from "../../outbound/types";
import type { ToolResponse } from "../common/context";
import type { ToolDeps } from "../common/handler";
import { CUSTOMER, type ToolWorld, WORLD, toolWorld } from "../common/testing";
import type { CorePort } from "./core";
import { coreOwnership } from "./ownership";

export { CUSTOMER, SIM_NOW, TEST_NOW, WORLD };

const ENDPOINT = "https://zyxwvutsrqponmlkjihgfedcba543210.lambda-url.us-east-1.on.aws/";
const NETWORK_ENDPOINT = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";
const ROLE = "arn:aws:iam::776805327629:role/reclamo-poc-ToolsTestRole";
const SESSION = "arn:aws:sts::776805327629:assumed-role/reclamo-poc-ToolsTestRole/fn";
const silent = createLogger({ sink: () => undefined });

/** The real core app in process, as one of the tool targets. */
function inProcessCore(store: MemoryCoreStore, seen: string[]): CoreTransport {
  const app = createCoreApp({ store, callers: callerDirectory({ roles: { ToolInvestigation: ROLE } }) });
  return async (request) => {
    seen.push(`${request.method} ${request.url.pathname}`);
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const response = await app({ method: request.method, path: request.url.pathname, query: Object.fromEntries(request.url.searchParams), headers, ...(request.body === undefined ? {} : { body: request.body }), callerArn: SESSION, requestId: "r" });
    return { status: response.statusCode, text: response.body };
  };
}

export interface RecordingGate {
  readonly requests: OutboundRequest[];
  readonly gate: OutboundGate;
  /** What the next requests answer (ALLOWED by default). */
  answer: (request: OutboundRequest) => GateOutcome;
}

export function recordingGate(): RecordingGate {
  const requests: OutboundRequest[] = [];
  const recorder: RecordingGate = {
    requests,
    answer: (request) => ({ ok: true, decision: "ALLOWED", messageId: request.messageId ?? `msg-${requests.length}`, ruleIds: [] }),
    gate: async (request) => {
      requests.push(request);
      return recorder.answer(request);
    },
  };
  return recorder;
}

export interface TargetsKit extends ToolWorld {
  /** The wrapper deps with the core's real ownership. */
  readonly toolDeps: ToolDeps;
  readonly coreStore: MemoryCoreStore;
  readonly coreClient: CoreClient;
  readonly core: CorePort;
  /** Core routes called (`GET /v1/…`), in order. */
  readonly coreCalls: string[];
  readonly network: InProcessNetworkMock;
  readonly networkClient: NetworkClient;
  readonly gate: RecordingGate;
  readonly complaintsDeps: ComplaintsDeps;
}

/** A tool world over the real mocks with these customers of the core (`cus-0001` is the session's). */
export async function targetsKit(customers: readonly CustomerSpec[]): Promise<TargetsKit> {
  const world = await toolWorld();
  await world.connector.transact([world.connector.counters.initEpochOp(WORLD, 1)]);
  await world.connector.worlds.putSettings(worldSettings(WORLD));
  const coreStore = coreWorld(customers, WORLD);
  const coreCalls: string[] = [];
  const coreClient = createCoreClient({ endpoint: ENDPOINT, transport: inProcessCore(coreStore, coreCalls), logger: silent, sleep: async () => undefined });
  const core: CorePort = () => coreClient;
  const network = createInProcessNetworkMock();
  network.seedWorld(WORLD);
  const networkClient = createNetworkClient({
    endpoint: NETWORK_ENDPOINT,
    sign: sigV4Signer({ credentials: { accessKeyId: "AKIDTESTONLY", secretAccessKey: "test-only-secret" }, signingDate: () => TEST_NOW }),
    fetch: inProcessNetworkFetch(network.app, "ToolInvestigation"),
    sleep: async () => undefined,
    logger: silent,
  });
  let counter = 0;
  const complaintsDeps: ComplaintsDeps = {
    connector: world.connector,
    chainKey: "test-chain-key-not-a-secret-0123456789abcdef",
    anchors: { request: async () => undefined },
    log: silent,
    realNow: () => world.deps.wallClock(),
    newId: (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`,
    retry: { sleep: async () => undefined, random: () => 0 },
  };
  const toolDeps: ToolDeps = { ...world.deps, ownership: coreOwnership(core, async () => SIM_NOW) };
  return { ...world, toolDeps, coreStore, coreClient, core, coreCalls, network, networkClient, gate: recordingGate(), complaintsDeps };
}

/** Monthly instalments of $ 118.640,00 due on the 5th from August 2026: the 3rd falls due on 05/10, the 4th on 05/11. */
export function monthlyInstalments(count = 6, amount = 11_864_000): { number: number; dueDate: string; amount: number }[] {
  return Array.from({ length: count }, (_, index) => {
    const due = new Date(Date.UTC(2026, 7 + index, 5));
    return { number: index + 1, dueDate: due.toISOString().slice(0, 10), amount };
  });
}

/** The answer of a call that must succeed. */
export function okOf(response: ToolResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`expected ok, got ${JSON.stringify(response)}`);
  return response;
}

/** The error code of a call that must fail. */
export function codeOf(response: ToolResponse): string {
  if (response.ok) throw new Error(`expected a failure, got ${JSON.stringify(response)}`);
  return response.error.code;
}
