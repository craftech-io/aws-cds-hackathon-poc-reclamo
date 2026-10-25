// The network mock in process, for unit tests, the local flows (`LF`) and the BFF client's tests: the
// same app the Lambda runs, over the in-memory store and bucket, with synthetic caller roles. Nothing
// here is deployed.
import { CORRELATION_HEADER, SIM_NOW_HEADER } from "@reclamo/core-contract";
import { CALLER_ROLES, type CallerRole, type CallerRoleArns } from "./http/caller";
import { type NetworkApp, type NetworkRequest, type NetworkResponse, createNetworkApp } from "./http/app";
import type { NetworkLogSink } from "./log";
import type { Fault } from "./faults";
import { type NetworkWorld, type StoredTransfer, items } from "./store/items";
import { type MemoryNetworkStore, createMemoryNetworkStore, createMemorySettlementObjects } from "./store/memory";

export const TEST_ACCOUNT = "776805327629";

/** The IAM role ARN a caller role would have in the stage (synthetic names). */
export function testRoleArn(role: CallerRole): string {
  return `arn:aws:iam::${TEST_ACCOUNT}:role/aws-cds-hackathon-poc-reclamo/reclamo-poc-${role}Role`;
}

/** The `userArn` a Function URL reports for a Lambda running with that role. */
export function assumedRoleArn(role: CallerRole): string {
  return `arn:aws:sts::${TEST_ACCOUNT}:assumed-role/reclamo-poc-${role}Role/reclamo-poc-${role}`;
}

export const TEST_CALLERS: CallerRoleArns = { roles: Object.fromEntries(CALLER_ROLES.map((role) => [role, testRoleArn(role)])) };

/** The holidays of the documented weeks (docs/seed-spec.md §11). */
export const TEST_HOLIDAYS = ["2026-10-12", "2026-11-09"] as const;

/** Real instant of the stamps and TTLs in tests. */
export const TEST_REAL_NOW = new Date("2026-10-07T13:10:00.000Z");

export interface InProcessNetworkMock {
  readonly app: NetworkApp;
  readonly store: MemoryNetworkStore;
  readonly objects: Map<string, string>;
  readonly logs: Array<Parameters<NetworkLogSink>[0]>;
  /** Writes the world's `CONFIG` (and `FAULTS`) as the world factory does. */
  seedWorld(worldId: string, options?: { settlementDelays?: NetworkWorld["settlementDelays"]; faults?: Fault[]; holidays?: readonly string[] }): void;
  seedTransfer(transfer: Omit<StoredTransfer, "version" | "transitions"> & { transitions?: StoredTransfer["transitions"] }): void;
  /** One request as `role` at the world's simulated instant `simNow`. */
  call(role: CallerRole | undefined, request: { method: string; path: string; simNow?: string; query?: string; body?: unknown; correlationId?: string }): Promise<NetworkResponse & { json: unknown }>;
}

export function createInProcessNetworkMock(): InProcessNetworkMock {
  const store = createMemoryNetworkStore({ realNow: () => TEST_REAL_NOW });
  const bucket = createMemorySettlementObjects();
  const logs: Array<Parameters<NetworkLogSink>[0]> = [];
  const app = createNetworkApp({ store, objects: bucket, callers: TEST_CALLERS, log: (line) => void logs.push(line), realNow: () => TEST_REAL_NOW });
  return {
    app,
    store,
    objects: bucket.objects,
    logs,
    seedWorld(worldId, options = {}) {
      store.putRaw(items.config({ worldId, holidays: [...(options.holidays ?? TEST_HOLIDAYS)], settlementDelays: options.settlementDelays ?? {}, version: 1 }, TEST_REAL_NOW));
      if (options.faults !== undefined) store.putRaw(items.faults({ worldId, faults: options.faults, version: 1 }, TEST_REAL_NOW));
    },
    seedTransfer(transfer) {
      store.putRaw(items.transfer({ ...transfer, transitions: transfer.transitions ?? [], version: 1 }, TEST_REAL_NOW));
    },
    async call(role, request) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (request.simNow !== undefined) headers[SIM_NOW_HEADER] = request.simNow;
      if (request.correlationId !== undefined) headers[CORRELATION_HEADER] = request.correlationId;
      const response = await app.handle({
        method: request.method,
        path: request.path,
        headers,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(role === undefined ? {} : { userArn: assumedRoleArn(role) }),
      });
      return { ...response, json: JSON.parse(response.body) as unknown };
    },
  };
}

/** A `fetch` that serves the in-process app as the given role (the BFF client's tests, the local flows). */
export function inProcessNetworkFetch(app: NetworkApp, role: CallerRole, recorded: NetworkRequest[] = []) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> => {
    const parsed = new URL(url);
    const request: NetworkRequest = {
      method: init.method,
      path: parsed.pathname,
      query: parsed.search.replace(/^\?/, ""),
      headers: Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value])),
      ...(init.body === undefined ? {} : { body: init.body }),
      userArn: assumedRoleArn(role),
    };
    recorded.push(request);
    const response = await app.handle(request);
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}
