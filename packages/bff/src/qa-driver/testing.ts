// Test kit of the QaDriver: its ports over the memory connector and recording fakes, so the unit tests
// drive the real driver, guard and actions (and, where it matters, the real code of the Lambdas the
// driver reaches) without AWS. A port a test does not bind answers `UNAVAILABLE NOT_WIRED`.
import { ToolError } from "@reclamo/shared";
import { connectorAuditSink, connectorWorldDirectory } from "../auth/directory";
import type { Connector } from "../connector/port";
import type { TableStore } from "../connector/store";
import { TEST_NOW } from "../connector/testing";
import { TEST_SIM_KEYS } from "../channels/whatsapp/testing";
import type { WhatsAppSnsEvent } from "../channels/whatsapp/payloads";
import type { LeadNotice } from "../leads/notice";
import { createLogger } from "../lib/log";
import type { ContextDeps } from "../routers/deps";
import type { TimerDeps } from "../timers/deps";
import { cognitoRefusal } from "./cognito-refusal";
import { QA_REASON } from "./contract";
import { type QaDriver, createQaDriver } from "./driver";
import { ACTION_HANDLERS } from "./handlers";
import type { QaCognito, QaPorts, SessionTokens } from "./ports";
import type { ModelsDocument, ModelsSource } from "./world-models";

/** A run of the scenario runner and the world of its scenario `sc01`. */
export const RUN = "4242-1";
export const QA_WORLD = `qa-${RUN}-sc01`;
export const key = (step: number, scenario = "sc01", label?: string): string => `${RUN}/${scenario}/${step}${label === undefined ? "" : `/${label}`}`;

function notWired(port: string): never {
  throw new ToolError("UNAVAILABLE", `${port} is not bound in this test`, QA_REASON.NOT_WIRED);
}

/** A JWT whose payload carries `claims` (unsigned: the fake pool's tokens are never verified here). */
export function fakeJwt(claims: Readonly<Record<string, unknown>>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

/** An account of the fake pool; without a status it is CONFIRMED. */
export interface FakeUser {
  sub: string;
  worldId: string;
  group: string;
  password?: string;
  status?: "CONFIRMED" | "UNCONFIRMED";
}

export interface FakeCognito extends QaCognito {
  readonly users: Map<string, FakeUser>;
  readonly logins: { flow: string; username: string }[];
  readonly confirmed: { username: string; clientMetadata: Readonly<Record<string, string>> }[];
}

export function fakeCognito(now: () => Date): FakeCognito {
  const users = new Map<string, FakeUser>();
  const logins: FakeCognito["logins"] = [];
  const confirmed: FakeCognito["confirmed"] = [];
  let subs = 0;
  return {
    users,
    logins,
    confirmed,
    async createUser({ username, worldId, group }) {
      if (users.has(username)) return "EXISTS";
      const sub = `00000000-0000-4000-8000-${String((subs += 1)).padStart(12, "0")}`;
      users.set(username, { sub, worldId, group });
      return { sub };
    },
    async setPassword(username, password) {
      const user = users.get(username);
      if (user === undefined) throw Object.assign(new Error("no such user"), { name: "UserNotFoundException" });
      // As Cognito: a permanent password confirms an UNCONFIRMED account, without the trigger.
      user.password = password;
      user.status = "CONFIRMED";
    },
    async accountStatus(username) {
      const user = users.get(username);
      return user === undefined ? "MISSING" : (user.status ?? "CONFIRMED");
    },
    async login(flow, username, password): Promise<SessionTokens> {
      const user = users.get(username);
      if (user?.password !== password) throw Object.assign(new Error("wrong password"), { name: "NotAuthorizedException" });
      logins.push({ flow, username });
      const authTime = Math.floor(now().getTime() / 1_000);
      const claims = { sub: user.sub, auth_time: authTime, exp: authTime + 900, worldStatus: "READY" };
      return { idToken: fakeJwt(claims), accessToken: fakeJwt({ ...claims, token_use: "access" }), exp: authTime + 900, authTime, loginMs: 5 };
    },
    async probeSelfService() {
      return { updateAttributes: "NotAuthorizedException", changePassword: "NotAuthorizedException", deleteUser: "NotAuthorizedException" };
    },
    async probeClients() {
      const refused = { signUp: "ForbiddenException", forgotPassword: "ForbiddenException", confirmForgotPassword: "ForbiddenException" };
      return { SERVER: refused, CONSOLE: refused };
    },
    async adminConfirmSignUp(username, clientMetadata) {
      const user = users.get(username);
      if (user !== undefined && (user.status ?? "CONFIRMED") === "CONFIRMED") throw cognitoRefusal(Object.assign(new Error("User cannot be confirmed. Current status is CONFIRMED"), { name: "NotAuthorizedException" }));
      if (user !== undefined) user.status = "CONFIRMED";
      confirmed.push({ username, clientMetadata });
    },
    async deleteUser(username) {
      users.delete(username);
    },
  };
}

export interface Recorded {
  readonly delivered: WhatsAppSnsEvent[];
  readonly media: { key: string; bytes: number; contentType: string }[];
  readonly settlements: Map<string, string>;
  readonly dispatched: Readonly<Record<string, unknown>>[];
  readonly janitor: Readonly<Record<string, unknown>>[];
  readonly enqueued: unknown[];
  readonly notices: LeadNotice[];
}

export interface KitOptions {
  readonly mc: { readonly connector: Connector; readonly store: TableStore };
  readonly worlds?: QaPorts["worlds"];
  readonly timers?: (log: ReturnType<typeof createLogger>) => TimerDeps;
  readonly models?: ModelsDocument;
  readonly csv?: Readonly<Record<string, string>>;
  readonly now?: () => Date;
  readonly overrides?: Partial<QaPorts>;
}

/** A console context over the same memory connector: the real routers, with their memory ports. */
export function consoleDeps(mc: KitOptions["mc"], now: () => Date, timers?: KitOptions["timers"]): ContextDeps {
  const log = createLogger({ level: "error", now });
  return {
    verifier: { verify: async () => notWired("verifier") },
    directory: connectorWorldDirectory(mc.connector.worlds),
    audit: connectorAuditSink(mc.connector.audit, now),
    wallClock: now,
    loggerFor: () => log,
    ...(timers === undefined ? {} : { clockPorts: { connector: mc.connector, timers: (requestLog) => timers(requestLog), janitor: { invoke: async () => undefined } } }),
  };
}

export function qaKit(options: KitOptions) {
  const now = options.now ?? (() => new Date(TEST_NOW.getTime()));
  const recorded: Recorded = { delivered: [], media: [], settlements: new Map(), dispatched: [], janitor: [], enqueued: [], notices: [] };
  const cognito = fakeCognito(now);
  const lines: string[] = [];
  const log = createLogger({ sink: (line) => void lines.push(line), level: "debug", now });
  const models: ModelsSource = {
    read: async () => options.models ?? notWired("models"),
    settlementCsv: async (seedPath) => options.csv?.[seedPath] ?? "network;businessDate;operationCode\n",
    batchInputs: async () => notWired("batchInputs"),
  };
  const ports: QaPorts = {
    data: options.mc.connector,
    store: options.mc.store,
    worlds: options.worlds ?? (() => notWired("worlds")),
    models,
    console: () => consoleDeps(options.mc, now, options.timers),
    clock: (requestLog) => options.timers?.(requestLog) ?? notWired("clock"),
    janitor: { invoke: async (event) => void recorded.janitor.push(event) },
    enqueuer: () => ({
      enqueueCustomerEvent: async (input) => {
        recorded.enqueued.push(input);
        return input as never;
      },
      enqueueScanDeadline: async () => undefined,
    }),
    inbound: {
      key: () => TEST_SIM_KEYS.qa,
      deliver: async (event) => {
        recorded.delivered.push(event);
        return { records: [{ accepted: true, messages: [{ outcome: "ACKNOWLEDGED" }] }] };
      },
    },
    objects: {
      putMedia: async (mediaKey, bytes, contentType) => void recorded.media.push({ key: mediaKey, bytes: bytes.length, contentType }),
      putSettlement: async (fileKey, body) => void recorded.settlements.set(fileKey, body),
    },
    scheduleDispatch: {
      scheduleArn: (name) => `arn:aws:scheduler:us-east-1:776805327629:schedule/aws-cds-hackathon-poc-reclamo-poc-schedules/${name}`,
      invoke: async (input) => {
        recorded.dispatched.push(input);
        return notWired("scheduleDispatch");
      },
    },
    probeGate: () => notWired("probeGate"),
    g2: () => ({ check: async () => ({ ok: false, failure: "BLOCKED" }) as never }),
    g1: () => ({ check: async () => ({ action: "BLOCKED", policy: "PROMPT_ATTACK", topics: [] }) }),
    emailFence: () => notWired("emailFence"),
    stageModes: () => ({ email: "live", whatsapp: { liveWorlds: ["demo"] } }),
    networks: () => notWired("networks"),
    phoneHash: async (phone) => `hash-${phone.slice(-4)}`,
    mocks: { health: async () => ({ core: "OK", networks: "OK" }), urlPost: async () => ({ status: 403, reason: "CALLER_WORLD_DENIED" }), directInvoke: async () => "AccessDeniedException" },
    janitorDirect: async (event) => {
      recorded.janitor.push(event);
      return notWired("janitorDirect");
    },
    policyAudit: async () => notWired("policyAudit"),
    receipts: { read: async () => notWired("receipts") },
    cognito: () => cognito,
    signup: () => notWired("signup"),
    edge: async () => ({ status: 403, reason: "EDGE_REQUIRED" }),
    noticeProbe: () => ({ send: async (notice) => void recorded.notices.push(notice) }),
    tamper: () => notWired("tamper"),
    anchors: { read: async () => [] },
    chainKey: () => "test-register-chain-key-of-32-characters-or-more",
    dlq: { find: async () => undefined, delete: async () => false },
    alarmHistory: async () => [],
    malwarePlan: async () => ({ status: "ACTIVE", statusReasons: [] }),
    memory: () => notWired("memory"),
    newPassword: () => `Qa9-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    now,
    sleep: async () => undefined,
    ...options.overrides,
  };
  const driver: QaDriver = createQaDriver({ ports, handlers: ACTION_HANDLERS, loggerFor: () => log });
  return { ports, driver, recorded, cognito, lines, log };
}

export type QaKit = ReturnType<typeof qaKit>;
