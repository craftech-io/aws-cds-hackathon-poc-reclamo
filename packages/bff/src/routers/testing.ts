// Test-only console of the compliance, simulator, clock and account routers (docs/reuse-map.md
// "routers/testing.ts"): the real `appRouter` over ONE memory connector, which also backs the staff
// directory and the audit sink of `worldProcedure`, with every port of those routers bound to a fake:
// an anchor log with CloudWatch's `ingestionTime`, an `Exports` bucket, the `Emails` objects, the phone
// simulator delivering to the REAL `InboundWhatsApp` pipeline in process (signed envelope verified,
// phone hash, `SIMMEDIA#`), the timers' queue, networks and Scheduler, the `WorldJanitor` invocations and
// a password admin. Tokens are signed by the test issuer; the console's real clock is the rig's clock.
// Nothing here ships in a Lambda.
import { type ChannelMode, type StaffRole, addressHash } from "@reclamo/shared";
import { connectorAuditSink, connectorWorldDirectory } from "../auth/directory";
import { claimsOf, createTestIssuer } from "../auth/testing";
import { processWhatsAppEvent } from "../channels/whatsapp/inbound";
import { MemoryBucket, TEST_PHONE_KEY, TEST_SIM_KEYS, TEST_TOPIC_ARN, recordingPorts, testSnsVerifier } from "../channels/whatsapp/testing";
import { MemoryAnchorLog, TEST_CHAIN_KEY } from "../complaints/testing";
import { type ChainBody, appendChained } from "../complaints/register";
import type { ChainKind } from "../domain/ledger";
import { writeAnchors } from "../handlers/anchor-writer";
import type { WhatsAppSnsEvent } from "../channels/whatsapp/payloads";
import { SIM_NOW, worldMeta, worldSettings } from "../connector/testing";
import { createMemoryConnector } from "../connector/memory/connector";
import type { WorldStatus } from "../domain/world";
import { createLogger } from "../lib/log";
import { RecordingScheduler, fakeNetworks } from "../timers/testing";
import type { TimerQueueEvent } from "../timers/events";
import type { AccountPorts, PasswordAdmin } from "./account";
import type { ContextDeps } from "./deps";
import type { EmailsPorts } from "./emails";
import { createCaller } from "./index";
import type { ExportStore } from "./register";
import { personaCustomerId, personaPhone } from "./simulator";
import { createContextFactory } from "./trpc";

export interface RigPrincipal {
  readonly worldId: string;
  readonly staffId: string;
  readonly role: StaffRole;
  readonly username: string;
  readonly sub: string;
}

const principal = (worldId: string, staffId: string, role: StaffRole, username: string): RigPrincipal => ({ worldId, staffId, role, username, sub: `sub-${username}` });

export const OPERATOR = principal("demo", "stf-operator-01", "OPERATOR", "operator-01");
export const SUPERVISOR = principal("demo", "stf-supervisor-01", "SUPERVISOR", "supervisor-01");
export const COMPLIANCE = principal("demo", "stf-compliance-01", "COMPLIANCE", "compliance-01");
export const GUEST = principal("g03", "stf-guest-03", "GUEST", "guest-03");
export const GUEST_SUPERVISOR = principal("g03", "stf-supervisor-g03", "SUPERVISOR", "supervisor-g03");
const PRINCIPALS = [OPERATOR, SUPERVISOR, COMPLIANCE, GUEST, GUEST_SUPERVISOR];

/** The personas a seeded world has a conversation with (enough for every test of the simulator and the tour). */
export const RIG_PERSONAS = ["C01", "C02", "C07", "C09"] as const;

/** An in-memory `Exports` bucket. */
export class MemoryExports implements ExportStore {
  readonly objects = new Map<string, { body: string; contentType: string }>();
  async put(key: string, body: string, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async url(key: string, contentType: string): Promise<string> {
    return `https://exports.test/${key}?type=${encodeURIComponent(contentType)}&expires=300`;
  }
}

export interface FakePasswords extends PasswordAdmin {
  readonly current: Map<string, string>;
}

function fakePasswords(): FakePasswords {
  const current = new Map<string, string>();
  return {
    current,
    verify: async (username, password) => current.get(username) === password,
    set: async (username, password) => {
      if (password.length < 12) throw Object.assign(new Error("policy"), { name: "InvalidPasswordException" });
      current.set(username, password);
    },
  };
}

export interface SeedOptions {
  readonly status?: WorldStatus;
  readonly mode?: ChannelMode;
  readonly epoch?: number;
  readonly simNow?: string;
}

export function consoleRig() {
  const clock = { now: new Date() };
  const now = () => new Date(clock.now.getTime());
  const { connector, store } = createMemoryConnector({ now });
  const issuer = createTestIssuer();
  const lines: string[] = [];
  const log = createLogger({ sink: (line) => void lines.push(line), level: "debug", now });
  const anchors = new MemoryAnchorLog();
  const exports = new MemoryExports();
  const emailObjects = new Map<string, Uint8Array>();
  const documentUrls: string[] = [];
  const bucket = new MemoryBucket();
  const delivered: WhatsAppSnsEvent[] = [];
  const queue: TimerQueueEvent[] = [];
  const scheduler = new RecordingScheduler();
  const networks = fakeNetworks();
  const janitor: { kind: string; worldId: string; requestId: string }[] = [];
  const passwords = fakePasswords();
  const modes = new Map<string, ChannelMode>();
  const phones = new Map<string, string>();
  const inbound = recordingPorts({});
  let ids = 0;

  const inboundDeps = {
    data: connector,
    keys: { phoneHash: TEST_PHONE_KEY, simEnvelope: TEST_SIM_KEYS },
    topicArn: TEST_TOPIC_ARN,
    sns: testSnsVerifier().verifier,
    stageModes: { email: "live" as const, whatsapp: { liveWorlds: ["demo"] } },
    customers: { findByPhoneHash: async (worldId: string, phoneHash: string) => (phones.has(`${worldId}#${phoneHash}`) ? { customerId: phones.get(`${worldId}#${phoneHash}`) ?? "" } : undefined) },
    replies: inbound.replies,
    effects: inbound.effects,
    intake: inbound.intake,
    bucket,
    realClock: { now: async () => now() },
    log,
  };

  const deps: ContextDeps = {
    verifier: issuer.verifier(),
    directory: connectorWorldDirectory(connector.worlds),
    audit: connectorAuditSink(connector.audit, now),
    wallClock: now,
    loggerFor: (correlationId) => createLogger({ correlationId, sink: (line) => void lines.push(line), now }),
    registerPorts: { connector, chainKey: () => TEST_CHAIN_KEY, anchors, exports },
    emailsPorts: {
      connector,
      emailObject: async (key) => emailObjects.get(key),
      documentUrl: async (key, filename) => {
        documentUrls.push(key);
        return `https://documents.test/${key}?filename=${filename}`;
      },
    } satisfies EmailsPorts,
    simulatorPorts: {
      connector,
      whatsAppMode: async (worldId) => modes.get(worldId) ?? "simulated",
      envelopeKey: () => TEST_SIM_KEYS.console,
      deliver: async (event) => {
        delivered.push(event);
        return processWhatsAppEvent(event, inboundDeps);
      },
      presignUpload: async (key, contentType) => ({ url: "https://media.test/", fields: { key, "Content-Type": contentType } }),
      newMediaId: () => `SIM${String(++ids).padStart(32, "0")}`,
    },
    clockPorts: {
      connector,
      timers: (requestLog) => ({ connector, sink: { enqueue: async (event) => void queue.push(event) }, networks, scheduler, log: requestLog, realNow: now, newId: (prefix) => `${prefix}-${String(++ids).padStart(4, "0")}` }),
      janitor: { invoke: async (event) => void janitor.push({ ...event }) },
    },
    policyPorts: { connector, stageModes: () => ({ email: "live", whatsapp: { liveWorlds: ["demo"] } }) },
    accountPorts: { connector, passwords } satisfies AccountPorts,
    tourPorts: { connector },
    metricsPorts: { connector },
  };
  const contextFor = createContextFactory(() => deps);

  /** A world `READY` (or `status`) with settings, epoch, a paused clock, its staff and the rig's personas. */
  async function seedWorld(worldId: string, seed: SeedOptions = {}): Promise<void> {
    const epoch = seed.epoch ?? 1;
    await connector.worlds.register(worldMeta(worldId, { status: seed.status ?? "READY", epoch }));
    await connector.worlds.putSettings({ ...worldSettings(worldId), channelModes: { whatsapp: seed.mode ?? "simulated" } });
    await connector.transact([connector.counters.initEpochOp(worldId, epoch)]);
    await connector.runtime.putClock({ worldId, mode: "PAUSED", pausedSimNow: seed.simNow ?? SIM_NOW, worldEpoch: epoch });
    if (seed.mode) modes.set(worldId, seed.mode);
    for (const staff of PRINCIPALS.filter((candidate) => candidate.worldId === worldId)) {
      await connector.worlds.putStaff({ worldId, staffId: staff.staffId, role: staff.role, displayName: staff.username, cognitoSubKey: `SUB#${staff.sub}`, active: true });
    }
    for (const persona of RIG_PERSONAS) {
      const customerId = personaCustomerId(persona);
      await connector.conversations.create({ worldId, customerId, control: "AGENT", controlHistory: [], sessionEpoch: 1, disclosedEpochs: [], openComplaintIds: [] });
      phones.set(`${worldId}#${await addressHash("WHATSAPP", personaPhone(persona), TEST_PHONE_KEY)}`, customerId);
    }
  }

  /** An id token of `who`, signed in `signedInSecondsAgo` seconds before the rig's clock. */
  function tokenOf(who: RigPrincipal, signedInSecondsAgo = 0, extra: Record<string, unknown> = {}): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const authTime = Math.floor(now().getTime() / 1000) - signedInSecondsAgo;
    return issuer.idToken({ sub: who.sub, ...claimsOf(who, who.username), auth_time: authTime, iat: issuedAt, exp: issuedAt + 900, ...extra });
  }

  /** The real root router as `who` (see `tokenOf`; `extra` claims such as another `origin_jti`). */
  async function as(who: RigPrincipal, signedInSecondsAgo = 0, extra: Record<string, unknown> = {}) {
    const ctx = await contextFor({ event: { headers: { authorization: `Bearer ${tokenOf(who, signedInSecondsAgo, extra)}` } } });
    return { caller: createCaller(ctx), response: ctx.response };
  }

  /** Appends one entry to a chain of `worldId` (epoch 1 unless given), anchored by the real AnchorWriter logic unless `anchor` is false. */
  async function append<C extends ChainKind>(chain: C, worldId: string, entry: ChainBody<C>, options: { anchor?: boolean; epoch?: number } = {}) {
    const anchorRequests: unknown[] = [];
    const complaintsDeps = {
      connector,
      chainKey: TEST_CHAIN_KEY,
      anchors: { request: async (request: unknown) => void anchorRequests.push(request) },
      log,
      realNow: now,
      retry: { sleep: async () => undefined, random: () => 0 },
    };
    const result = await appendChained(complaintsDeps, { chain, worldId, epoch: options.epoch ?? 1, build: () => ({ entry }) });
    if (options.anchor !== false) for (const request of anchorRequests) await writeAnchors(request, { connector, sink: anchors.sink(), log, now });
    return result.entry;
  }

  return {
    connector,
    store,
    contextFor,
    tokenOf,
    append,
    deps,
    anchors,
    exports,
    emailObjects,
    documentUrls,
    bucket,
    delivered,
    intake: inbound.recorded,
    queue,
    scheduler,
    networks,
    janitor,
    passwords,
    lines,
    now,
    /** Moves the rig's real clock forward. */
    passReal: (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    seedWorld,
    as,
  };
}

export type ConsoleRig = ReturnType<typeof consoleRig>;

/** The `reason` of a tRPC refusal (or its code), `null` when the call answered. */
export async function refusalOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const cause: unknown = error && typeof error === "object" ? Reflect.get(error, "cause") : undefined;
    const reason: unknown = cause && typeof cause === "object" ? Reflect.get(cause, "reason") : undefined;
    if (typeof reason === "string") return reason;
    const code: unknown = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    if (typeof code === "string") return code;
    throw error;
  }
}
