// The lender core and the networks of an in-process world: the same apps the `CoreMock` and
// `NetworkMock` Lambdas run (their pure logic over the memory stores), behind the BFF's real clients.
// Every call names the role of the function that makes it in the stage (`CoreCaller` /
// `CallerRole`), so the mocks' fences per world class and per operation run as they do in `poc`: the
// worker reaches the core as `EventWorker`, the tools as `Tool<Target>`, the console as `Bff`.
import { createHmac } from "node:crypto";
import { createCoreApp } from "@reclamo/core-mock/app";
import { type CoreCaller, callerDirectory } from "@reclamo/core-mock/http/caller";
import { type MemoryCoreStore, createMemoryCoreStore } from "@reclamo/core-mock/store/memory";
import { type NetworkApp, createNetworkApp } from "@reclamo/network-mock/http/app";
import type { CallerRole } from "@reclamo/network-mock/http/caller";
import { type MemoryNetworkStore, createMemoryNetworkStore, createMemorySettlementObjects } from "@reclamo/network-mock/store/memory";
import { TEST_CALLERS, inProcessNetworkFetch } from "@reclamo/network-mock/testing";
import { normalizeEmail } from "@reclamo/shared";
import { type CoreClient, type CoreTransport, createCoreClient } from "@reclamo/bff/core/client";
import type { RequestSigner } from "@reclamo/bff/core/signer";
import { createLogger } from "@reclamo/bff/lib/log";
import { type NetworkClient, createNetworkClient } from "@reclamo/bff/networks/client";
import { EMAIL_HASH_SUBKEY } from "./keys";

const ACCOUNT = "776805327629";
const CORE_ENDPOINT = "https://localcoremockfunctionurl0000000000.lambda-url.us-east-1.on.aws/";
const NETWORK_ENDPOINT = "https://localnetworkmockfunctionurl000000.lambda-url.us-east-1.on.aws/";
const CORE_CALLERS: readonly CoreCaller[] = [
  "InboundWhatsApp",
  "EventWorker",
  "SignupEventWorker",
  "QaEventWorker",
  "ToolIdentity",
  "ToolAccount",
  "ToolInvestigation",
  "ToolActions",
  "ToolComplaints",
  "ToolMessaging",
  "ToolHandoff",
  "Bff",
  "QaDriver",
];

/** A function of the stage that calls the core (infra/iam-capabilities.ts `MOCK_CORE`). */
export type CoreCallerRole = CoreCaller;

/** A function of the stage that calls the networks; `Bff` holds no `MOCK_NETWORK` (infra/iam-capabilities.ts). */
export type NetworkCallerRole = CallerRole | "Bff";

const roleName = (caller: CoreCallerRole): string => `reclamo-local-${caller}`;
const silent = createLogger({ sink: () => undefined });
// The Function URL's IAM authorizer is the fence; in process the role is named by the transport.
const unsigned: RequestSigner = async ({ headers }) => ({ ...headers });
const noWait = async (): Promise<void> => undefined;

/** `PhoneHashKey` → `email-hash` over the normalized address: what the core stores for a changed email. */
export function hashEmail(email: string): string {
  return createHmac("sha256", EMAIL_HASH_SUBKEY).update(normalizeEmail(email)).digest("hex");
}

export interface InProcessMocks {
  readonly coreStore: MemoryCoreStore;
  readonly networkStore: MemoryNetworkStore;
  /** Published settlement files of the network mock, by key (`W/<world>/<network>/<date>/batch-<n>.csv`). */
  readonly settlementFiles: Map<string, string>;
  readonly networkApp: NetworkApp;
  /** Core routes called, as `<caller> <METHOD> <path>`, in order. */
  readonly coreCalls: string[];
  /** The core client of a function of the stage; a role the mock does not list is refused by it. */
  core(caller: CoreCallerRole): CoreClient;
  /** The networks client of a function of the stage; a role the mock does not list is refused by it. */
  networks(role: NetworkCallerRole): NetworkClient;
}

function coreTransport(app: ReturnType<typeof createCoreApp>, caller: CoreCallerRole, calls: string[]): CoreTransport {
  let request = 0;
  return async ({ method, url, headers, body }) => {
    request += 1;
    calls.push(`${caller} ${method} ${url.pathname}`);
    const response = await app({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
      ...(body === undefined ? {} : { body }),
      callerArn: `arn:aws:sts::${ACCOUNT}:assumed-role/${roleName(caller)}/local`,
      requestId: `local-core-${caller}-${request}`,
    });
    return { status: response.statusCode, text: response.body };
  };
}

export function createInProcessMocks(realNow: () => Date): InProcessMocks {
  const coreStore = createMemoryCoreStore();
  const roles = Object.fromEntries(CORE_CALLERS.map((caller) => [caller, `arn:aws:iam::${ACCOUNT}:role/${roleName(caller)}`]));
  const coreApp = createCoreApp({ store: coreStore, callers: callerDirectory({ roles }), hashEmail });
  const networkStore = createMemoryNetworkStore({ realNow });
  const settlement = createMemorySettlementObjects();
  const networkApp = createNetworkApp({ store: networkStore, objects: settlement, callers: TEST_CALLERS, realNow, log: () => undefined });
  const coreCalls: string[] = [];
  const coreClients = new Map<CoreCallerRole, CoreClient>();
  const networkClients = new Map<NetworkCallerRole, NetworkClient>();
  return {
    coreStore,
    networkStore,
    settlementFiles: settlement.objects,
    networkApp,
    coreCalls,
    core(caller) {
      let client = coreClients.get(caller);
      if (client === undefined) {
        client = createCoreClient({ endpoint: CORE_ENDPOINT, transport: coreTransport(coreApp, caller, coreCalls), logger: silent, sleep: noWait });
        coreClients.set(caller, client);
      }
      return client;
    },
    networks(role) {
      let client = networkClients.get(role);
      if (client === undefined) {
        client = createNetworkClient({ endpoint: NETWORK_ENDPOINT, sign: unsigned, fetch: inProcessNetworkFetch(networkApp, role as CallerRole), sleep: noWait, logger: silent });
        networkClients.set(role, client);
      }
      return client;
    },
  };
}
