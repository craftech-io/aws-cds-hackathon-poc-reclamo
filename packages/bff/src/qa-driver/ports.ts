// What the `QaDriver` drives, as ports (docs/tool-catalog.md "Acciones del QaDriver"). The actions are
// written once over these; stage-ports.ts binds them to what SST links into the Lambda (never
// `process.env`), and testing.ts binds them to the memory connector and fakes for the unit tests.
// Every port that reaches another Lambda goes through that Lambda's own entry, so its own checks run.
import type { ChannelModes } from "../lib/resource";
import type { G1Prefilter } from "../turns/prefilter";
import type { OutputGuardrail } from "../outbound/g2";
import type { OutboundGate } from "../outbound/types";
import type { FenceDecision, FenceIntent } from "../channels/email/recipient-fence";
import type { WhatsAppSnsEvent } from "../channels/whatsapp/payloads";
import type { ClockDeps } from "../clock/advance";
import type { AnchorEvent } from "../complaints/anchors";
import type { Connector } from "../connector/port";
import type { TableStore } from "../connector/store";
import type { NetworkClient } from "../networks/client";
import type { PolicyAuditRun } from "../policy-audit/run";
import type { ReaderOutcome, ReaderUnavailable } from "../receipts/reader";
import type { ContextDeps } from "../routers/deps";
import type { SignupService } from "../guests/signup";
import type { LeadNoticeTransport } from "../outbound/transports/lead-notice";
import type { Logger } from "../lib/log";
import type { JanitorInvoker, WorldsDeps } from "../worlds/deps";
import type { Enqueuer } from "../worker/enqueue";
import type { ModelsSource } from "./world-models";

/** The tokens of a real login: never a refresh token, never the password. */
export interface SessionTokens {
  readonly idToken: string;
  readonly accessToken: string;
  /** Epoch seconds. */
  readonly exp: number;
  readonly authTime: number;
  readonly loginMs: number;
}

export type QaAccountStatus = "CONFIRMED" | "UNCONFIRMED" | "OTHER" | "MISSING";

/** The console's user pool, as the driver uses it (COGNITO_QA; every name is checked by the caller). */
export interface QaCognito {
  /** Creates `username` with `custom:worldId` (no message) and adds it to its group; `EXISTS` when it is there. */
  createUser(input: { readonly username: string; readonly worldId: string; readonly group: string }): Promise<{ readonly sub: string } | "EXISTS">;
  /**
   * A new permanent password, generated and used inside the Lambda only. On an `UNCONFIRMED` account
   * Cognito takes it as a confirmation without the post-confirmation trigger: callers check `accountStatus`.
   */
  setPassword(username: string, password: string): Promise<void>;
  /** `AdminGetUser`: the account's status, or `MISSING`. */
  accountStatus(username: string): Promise<QaAccountStatus>;
  /** `AdminInitiateAuth` (`ServerClient`) or `InitiateAuth USER_SRP_AUTH` (`ConsoleClient`), through the pre-token trigger. */
  login(flow: "ADMIN" | "SRP", username: string, password: string): Promise<SessionTokens>;
  /** With the user's access token: the calls a user may try on its own account; each answer's error name. */
  probeSelfService(accessToken: string): Promise<Readonly<Record<"updateAttributes" | "changePassword" | "deleteUser", string>>>;
  /**
   * `SignUp`, `ForgotPassword` and `ConfirmForgotPassword` of `username` sent straight to Cognito with the
   * `ServerClient` and the `ConsoleClient` (public calls, no IAM): each answer's error name. The pool's
   * REGIONAL web ACL must refuse all of them (`ForbiddenException`, FL-119, FL-122).
   */
  probeClients(username: string, password: string): Promise<Readonly<Record<"SERVER" | "CONSOLE", Readonly<Record<"signUp" | "forgotPassword" | "confirmForgotPassword", string>>>>>;
  /** `AdminConfirmSignUp` with `clientMetadata.signupId` (fires the real post-confirmation trigger). */
  adminConfirmSignUp(username: string, clientMetadata: Readonly<Record<string, string>>): Promise<void>;
  deleteUser(username: string): Promise<void>;
}

/** The memory of the agent as `memory.inspect` reads it (ListSessions, ListEvents, ListMemoryRecords). */
export interface MemoryInspector {
  sessionIds(actorId: string): Promise<string[]>;
  eventCount(actorId: string, sessionId: string): Promise<number>;
  records(namespacePrefix: string): Promise<readonly { readonly memoryRecordId: string; readonly createdAt: string; readonly content: string }[]>;
}

/** Raw writes of `register.tamperProbe` with the driver's OWN role: IAM answers, not the connector. */
export interface TamperPorts {
  /** Each answers the AWS error name, or `OK`. */
  updateRegister(key: { readonly pk: string; readonly sk: string }): Promise<string>;
  deleteRegister(key: { readonly pk: string; readonly sk: string }): Promise<string>;
  putRegister(item: Readonly<Record<string, unknown>>, condition?: "attribute_exists(pk)"): Promise<string>;
  /** `PutLogEvents` on a stream of the anchors' log group (created when missing). */
  putAnchor(stream: string, message: string, timestampMs: number): Promise<string>;
  /** ARNs of the append-only tables (`Register`, `ComplianceTape`, `AuditLog`): what SC-18/8 simulates. */
  appendOnlyTableArns(): string[];
}

export interface DeadLetter {
  readonly eventId: string;
  readonly type: string;
  readonly worldId: string;
  readonly receiveCount: number;
}

export interface QaPorts {
  readonly data: Connector;
  /** Raw items the repositories do not model (the networks' config and faults). */
  readonly store: TableStore;
  /** The world factory's adapters (create, destroy, expiry): the same code as `WorldJanitor`. */
  readonly worlds: () => WorldsDeps;
  readonly models: ModelsSource;
  /** The console's context deps: `appRouter.createCaller` runs the real procedures over them. */
  readonly console: () => ContextDeps;
  /** The timers' deps of a clock move (queue, networks, the Scheduler fenced to `tm-qa-`). */
  readonly clock: (log: Logger) => ClockDeps;
  readonly janitor: JanitorInvoker;
  /** The QA queue's producer (`worker/enqueue.ts`): the only `SendMessage` of the driver. */
  readonly enqueuer: (log: Logger) => Enqueuer;
  readonly inbound: {
    /** `QaSimEnvelopeKey` (kid `qa`). */
    readonly key: () => string;
    /** Request-response invocation of `InboundWhatsApp` with the record; its answer as it came. */
    deliver(event: WhatsAppSnsEvent): Promise<unknown>;
  };
  readonly objects: {
    /** A server-built image under the QA world's upload prefix of `Media`. */
    putMedia(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
    /** A published file of a QA world whose lines name a cloned persona (`Settlements`, under `qa/`). */
    putSettlement(key: string, body: string): Promise<void>;
  };
  readonly scheduleDispatch: {
    /** The ARN the Scheduler would pass for a schedule name of the app's group. */
    scheduleArn(name: string): string;
    invoke(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  };
  /** The real gate with transports that record instead of sending (`gate.probe`). */
  readonly probeGate: (log: Logger) => { readonly gate: OutboundGate; readonly sent: () => readonly { readonly channel: string }[] };
  readonly g2: () => OutputGuardrail;
  readonly g1: () => G1Prefilter;
  readonly emailFence: (intent: FenceIntent) => FenceDecision;
  readonly stageModes: () => ChannelModes;
  readonly networks: () => NetworkClient;
  /** `PhoneHashKey/phone-hash` over an E.164 (a sender's `RATE#` bucket). */
  readonly phoneHash: (phoneE164: string) => Promise<string>;
  readonly mocks: {
    /** `GET /v1/health` of each mock by its Function URL, with the driver's own role. */
    health(): Promise<{ readonly core: string; readonly networks: string }>;
    /** A signed `POST` to a mock's Function URL: its status and its error `reason`. */
    urlPost(target: "CoreMock" | "NetworkMock", path: string, body: Readonly<Record<string, unknown>>): Promise<{ readonly status: number; readonly reason: string | null }>;
    /** A direct `lambda:InvokeFunction` with a fabricated `requestContext`: the AWS error name, or `OK`. */
    directInvoke(target: "CoreMock" | "NetworkMock", worldId: string): Promise<string>;
  };
  readonly janitorDirect: (event: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly policyAudit: (worldId: string) => Promise<PolicyAuditRun | unknown>;
  readonly receipts: { read(input: { readonly worldId: string; readonly seedKey: string; readonly simNow: Date; readonly forceFallback: boolean }): Promise<ReaderOutcome | ReaderUnavailable> };
  readonly cognito: () => QaCognito;
  readonly signup: (log: Logger) => SignupService;
  readonly edge: () => Promise<{ readonly status: number; readonly reason: string | null }>;
  /** The lead notice's real SES transport, fenced to the SES mailbox simulator (`notice.probe`). */
  readonly noticeProbe: () => LeadNoticeTransport;
  readonly tamper: () => TamperPorts;
  readonly anchors: { read(worldId: string, epoch: number): Promise<AnchorEvent[]> };
  readonly chainKey: () => string;
  readonly dlq: { find(eventId: string): Promise<DeadLetter | undefined>; delete(eventId: string): Promise<boolean> };
  readonly alarmHistory: () => Promise<readonly { readonly at: string; readonly summary: string }[]>;
  readonly malwarePlan: () => Promise<{ readonly status: string; readonly statusReasons: readonly string[] }>;
  readonly memory: () => MemoryInspector;
  /** A strong random password (the pool's policy: 12+, upper, lower, digit). */
  readonly newPassword: () => string;
  /** Real clock. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

/** What one action runs with. */
export interface ActionContext {
  readonly key: string;
  readonly worldId?: string;
  readonly ports: QaPorts;
  readonly log: Logger;
  /** Real instant the invocation started: probes stop at `startedAt + PROBE_BUDGET_MS`. */
  readonly startedAt: number;
}

export type ActionHandler<I> = (input: I, ctx: ActionContext) => Promise<unknown>;
