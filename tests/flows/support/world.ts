// The in-process world of the local flows (docs/test-plan.md §3, "Flujos locales"): the seed in memory
// with the real clock fixed (seed-world.ts, reference.ts), the stage's modules wired over it (stage/),
// the core and the networks in process (mocks.ts), the AWS services faked at their ports (fakes/), the
// stage's Cedar statements in front of the Gateway targets (gateway.ts) and a scripted Harness
// (scripted-harness.ts). It exposes the same entry points as the stage:
//
//   inboundWhatsApp(SNS event)  emailEvent(SES event)  mediaScanned(key)  timerFire(timerKey)
//   console(session)            the `appRouter` with a session the real verifier accepts
//
// and runs the queues after each of them, so a test reads a settled world. Real time is fixed and only
// moves with `advanceReal`; simulated time is each world's clock, which only `advance` (the clock
// module, as the QaDriver calls it) or the console's clock procedures move (ADR-0011).
import type { InboundSummary } from "@reclamo/bff/channels/whatsapp/inbound";
import { type SimulatedContent, buildSimulatedEvent, newSimulatedWamid } from "@reclamo/bff/channels/whatsapp/sim-envelope";
import type { WaButtonAction } from "@reclamo/shared";
import { TEST_CERT_PEM } from "@reclamo/bff/channels/whatsapp/testing";
import { type ClockMove, type ClockMoved, advanceClock } from "@reclamo/bff/clock/advance";
import { createMemoryConnector } from "@reclamo/bff/connector/memory/connector";
import type { MemoryStore } from "@reclamo/bff/connector/memory/engine";
import type { Connector } from "@reclamo/bff/connector/port";
import { TEST_NOW } from "@reclamo/bff/connector/testing";
import type { AdmitOutcome } from "@reclamo/bff/email-events/admit";
import type { MediaIntakeSummary } from "@reclamo/bff/handlers/media-intake";
import type { HarnessClient } from "@reclamo/bff/agent/harness-client";
import type { MemoryRetriever } from "@reclamo/bff/agent/memory";
import { personaNumber } from "@reclamo/bff/outbound/directory";
import type { ScheduledResult } from "@reclamo/bff/timers/dispatch";
import { type ConsoleCaller, type ConsoleSession, type LocalConsole, createLocalConsole } from "./console";
import { type BoundConsole, bindConsoleServices } from "./console-services";
import { type EvalClassifier, type EvalReceiptReader, type ScriptedGuardrails, evalClassifier, evalReceiptReader, scriptedGuardrails } from "./fakes/models";
import { FakeQueues } from "./fakes/queue";
import { FakeS3 } from "./fakes/s3";
import { type LocalGateway, createLocalGateway } from "./gateway";
import type { Jwks } from "aws-jwt-verify/jwk";
import type { SimulatorPorts } from "@reclamo/bff/routers/simulator";
import { type SigningKey, type TokenIssuer, createTokenIssuer } from "./issuer";
import { LOCAL_KEYS } from "./keys";
import { type InProcessMocks, createInProcessMocks } from "./mocks";
import { type SesEventType, localSimMediaId, sesEventOf, simulatedImage, tapContent, uploadImage } from "./phone";
import { seedReference } from "./reference";
import { type PlanSource, type PlannedCall, type ScriptedHarness, type TurnPlan, createScriptedHarness } from "./scripted-harness";
import { type SeedStaff, type SeedWorldInput, type SeededWorld, seedWorld } from "./seed-world";
import { type SentEmail, type StageContext, createStageContext } from "./stage/context";
import { type LocalEntries, type ScanVerdict, createLocalEntries } from "./stage/entries";
import { createLocalTargets } from "./stage/targets";

/** Real time between two things a person does on the phone: every tap or text is a later instant. */
const PHONE_PAUSE_MS = 1_000;

export interface FlowWorldOptions {
  /** Real time of the world: fixed at this instant (`TEST_NOW` by default, 07/10/2026 10:10 in Buenos
   * Aires), or `"machine"` for the machine's clock (the local UI server, where a browser's session runs). */
  readonly realNow?: string | "machine";
  /** The worlds to seed; `demo` from the `demo` template by default. The first one is the default world. */
  readonly worlds?: readonly SeedWorldInput[];
  /** Plans of the scripted Harness, one per turn, or a function of the turn. */
  readonly plans?: PlanSource | readonly (TurnPlan | readonly PlannedCall[])[];
  /** `CED-KILL-SWITCH` active in the Gateway's policies. */
  readonly killSwitchActive?: boolean;
  readonly memory?: MemoryRetriever;
  /** The key the console sessions are signed with (the UI server's runner hands one over). */
  readonly signingKey?: SigningKey;
  /** Keys a console session may also be signed with (the Playwright run's own JWKS, on the UI server). */
  readonly trustedJwks?: Jwks;
  /** Where the browser fetches a bucket's object (the UI server's S3 emulator). */
  readonly objectUrl?: (bucket: string, key: string) => string;
  /** The simulator's presigned POST (the UI server signs for its S3 emulator). */
  readonly presignUpload?: SimulatorPorts["presignUpload"];
  /** A model-backed Harness over the world's Gateway (tests/agent); the scripted one answers otherwise. */
  readonly agent?: (gateway: LocalGateway) => HarnessClient;
}

export interface FlowWorld {
  readonly connector: Connector;
  readonly store: MemoryStore;
  readonly mocks: InProcessMocks;
  readonly s3: FakeS3;
  readonly queues: FakeQueues;
  readonly classifier: EvalClassifier;
  readonly reader: EvalReceiptReader;
  readonly guardrails: ScriptedGuardrails;
  readonly stage: StageContext;
  readonly gateway: LocalGateway;
  readonly harness: ScriptedHarness;
  readonly entries: LocalEntries;
  readonly issuer: TokenIssuer;
  readonly localConsole: LocalConsole;
  /** What the console reached outside the world: `WorldJanitor` invocations and password changes. */
  readonly consoleServices: () => BoundConsole;
  /** Every JSON log line the stage's modules wrote. */
  readonly logs: readonly string[];
  /** The seeded worlds, by id. */
  readonly worlds: ReadonlyMap<string, SeededWorld>;
  /** The first seeded world. */
  readonly worldId: string;
  realNow(): Date;
  advanceReal(ms: number): void;
  simNow(worldId?: string): Promise<Date>;
  /** A staff row of a seeded world by role (the first one with it). */
  staff(role: SeedStaff["role"], worldId?: string): SeedStaff;
  /** The console as a user of a world, signed in `signedInAgo` seconds ago. */
  console(role: SeedStaff["role"], options?: { readonly worldId?: string; readonly signedInAgo?: number }): Promise<ConsoleCaller>;
  consoleAs(session: ConsoleSession): Promise<ConsoleCaller>;
  inboundWhatsApp(event: unknown): Promise<InboundSummary>;
  emailEvent(event: unknown): Promise<AdmitOutcome>;
  mediaScanned(objectKey: string, verdict?: ScanVerdict): Promise<MediaIntakeSummary>;
  timerFire(timerKey: string, worldId?: string): Promise<ScheduledResult>;
  /** The persona's phone in the console's simulator: what `simulator.send` hands `InboundWhatsApp`. */
  phone(customerId: string, content: SimulatedContent, options?: { readonly worldId?: string; readonly contextWamid?: string }): Promise<InboundSummary>;
  /** Taps the button `action` of the last WhatsApp of the customer that offers it. */
  tap(customerId: string, action: WaButtonAction, options?: { readonly worldId?: string }): Promise<InboundSummary>;
  /** Sends an image from the simulator: a seed receipt (`receipts/<variant>/<id>.png`) or an upload (`up/<world>/…`). */
  sendImage(customerId: string, s3Key: string, options?: { readonly worldId?: string; readonly contentType?: "image/png" | "image/jpeg"; readonly caption?: string }): Promise<InboundSummary>;
  /** Puts an upload of the simulator in `Media`, announced first; the verdict arrives with `mediaScanned`. */
  upload(key: string, bytes: Uint8Array, options?: { readonly worldId?: string; readonly contentType?: "image/png" | "image/jpeg" }): Promise<void>;
  /** The SES event of an email the world sent, delivered to `EmailEvents`. */
  sesEvent(sent: SentEmail, type: SesEventType): Promise<AdmitOutcome>;
  /** Moves a paused world clock as the QaDriver does (`clock.advance*`), firing what falls due. */
  advance(move: ClockMove, worldId?: string): Promise<ClockMoved>;
  /** Delivers every queued event (follow-ups included); answers how many deliveries it made. */
  settle(): Promise<number>;
}

export async function createFlowWorld(options: FlowWorldOptions = {}): Promise<FlowWorld> {
  const machine = options.realNow === "machine";
  // Fixed: the instant itself; on the machine's clock: what `advanceReal` added to it.
  let realMs = machine ? 0 : Date.parse(options.realNow ?? TEST_NOW.toISOString());
  const now = () => new Date(machine ? Date.now() + realMs : realMs);
  const lines: string[] = [];
  const { connector, store } = createMemoryConnector({ now });
  const mocks = createInProcessMocks(now);
  const s3 = new FakeS3();
  s3.mount("Settlements", { get: (key) => mocks.settlementFiles.get(key) });
  const queues = new FakeQueues(now);
  const classifier = evalClassifier();
  const reader = evalReceiptReader();
  const guardrails = scriptedGuardrails();
  const stage = createStageContext({ connector, mocks, s3, queues, classifier, reader, guardrails, now, lines });
  const gateway = createLocalGateway({ targets: createLocalTargets(stage), ...(options.killSwitchActive === undefined ? {} : { killSwitchActive: options.killSwitchActive }) });
  const harness = createScriptedHarness(gateway, options.plans);
  const entries = createLocalEntries(stage, { harness: options.agent === undefined ? harness : options.agent(gateway), snsCertificatePem: TEST_CERT_PEM, ...(options.memory === undefined ? {} : { memory: options.memory }) });
  const issuer = createTokenIssuer({ now, ...(options.signingKey === undefined ? {} : { key: options.signingKey }), ...(options.trustedJwks === undefined ? {} : { trustedJwks: options.trustedJwks }) });
  let bound: BoundConsole | undefined;
  const localConsole = createLocalConsole({
    connector,
    issuer,
    now,
    loggerFor: stage.loggerFor,
    bind: (deps) => {
      // A message sent from the console's phone simulator is a later real instant too (as `phone` below).
      const deliver = (event: unknown) => {
        if (!machine) realMs += PHONE_PAUSE_MS;
        return settled(entries.inboundWhatsApp(event));
      };
      bound = bindConsoleServices(deps, { stage, deliver, objectUrl: options.objectUrl ?? ((bucket, key) => `local-s3://${bucket}/${key}`), ...(options.presignUpload === undefined ? {} : { presignUpload: options.presignUpload }) });
      return bound.deps;
    },
  });

  await seedReference(connector);
  const worlds = new Map<string, SeededWorld>();
  for (const input of options.worlds ?? [{ worldId: "demo", template: "demo" }]) worlds.set(input.worldId, await seedWorld({ connector, anchors: stage.anchorRequester, mocks, s3, now }, input));
  const worldId = [...worlds.keys()][0] ?? "demo";
  let simMedia = 0;

  const settle = () => entries.drain();
  const settled = async <T>(run: Promise<T>): Promise<T> => {
    const result = await run;
    await settle();
    return result;
  };
  const seeded = (id: string): SeededWorld => {
    const world = worlds.get(id);
    if (world === undefined) throw new Error(`world ${id} was not seeded`);
    return world;
  };
  const staff = (role: SeedStaff["role"], id: string = worldId): SeedStaff => {
    const row = seeded(id).staff.find((candidate) => candidate.role === role);
    if (row === undefined) throw new Error(`world ${id} has no ${role}`);
    return row;
  };

  const phone = async (customerId: string, content: SimulatedContent, phoneOptions: { readonly worldId?: string; readonly contextWamid?: string } = {}): Promise<InboundSummary> => {
    const from = personaNumber(customerId);
    if (from === undefined) throw new Error(`${customerId} is not a persona with a simulated phone`);
    if (!machine) realMs += PHONE_PAUSE_MS;
    const event = buildSimulatedEvent(LOCAL_KEYS.simEnvelope.console, {
      kid: "console",
      worldId: phoneOptions.worldId ?? worldId,
      from,
      wamid: newSimulatedWamid(now().getTime()),
      content,
      at: now(),
      ...(phoneOptions.contextWamid === undefined ? {} : { contextWamid: phoneOptions.contextWamid }),
    });
    return settled(entries.inboundWhatsApp(event));
  };

  return {
    connector,
    store,
    mocks,
    s3,
    queues,
    classifier,
    reader,
    guardrails,
    stage,
    gateway,
    harness,
    entries,
    issuer,
    localConsole,
    consoleServices: () => {
      if (bound === undefined) throw new Error("the console services are not bound");
      return bound;
    },
    logs: lines,
    worlds,
    worldId,
    realNow: now,
    advanceReal(ms) {
      realMs += ms;
    },
    simNow: (id = worldId) => stage.simNow(id),
    staff,
    console: (role, consoleOptions = {}) => {
      const id = consoleOptions.worldId ?? worldId;
      return localConsole.caller({ worldId: id, staff: staff(role, id), ...(consoleOptions.signedInAgo === undefined ? {} : { signedInAgo: consoleOptions.signedInAgo }) });
    },
    consoleAs: (session) => localConsole.caller(session),
    inboundWhatsApp: (event) => settled(entries.inboundWhatsApp(event)),
    emailEvent: (event) => settled(entries.emailEvent(event)),
    mediaScanned: (objectKey, verdict = "NO_THREATS_FOUND") => settled(entries.mediaScanned(objectKey, verdict)),
    timerFire: (timerKey, id = worldId) => settled(entries.timerFire(id, timerKey)),
    phone,
    async tap(customerId, action, tapOptions = {}) {
      const id = tapOptions.worldId ?? worldId;
      const tapped = await tapContent(connector, id, customerId, action);
      return phone(customerId, tapped.content, { worldId: id, ...(tapped.contextWamid === undefined ? {} : { contextWamid: tapped.contextWamid }) });
    },
    async sendImage(customerId, s3Key, imageOptions = {}) {
      const id = imageOptions.worldId ?? worldId;
      const contentType = imageOptions.contentType ?? (s3Key.endsWith(".png") ? "image/png" : "image/jpeg");
      simMedia += 1;
      const content = await simulatedImage(connector, { worldId: id, simMediaId: localSimMediaId(simMedia), s3Key, contentType, at: now(), ...(imageOptions.caption === undefined ? {} : { caption: imageOptions.caption }) });
      return phone(customerId, content, { worldId: id });
    },
    upload: (key, bytes, uploadOptions = {}) => uploadImage(connector, s3, { worldId: uploadOptions.worldId ?? worldId, key, bytes, contentType: uploadOptions.contentType ?? "image/png", at: now() }),
    sesEvent: (sent, type) => settled(entries.emailEvent(sesEventOf(sent, type, now()))),
    async advance(move, id = worldId) {
      const moved = await advanceClock({ worldId: id, move, caller: { actor: "QA" } }, stage.timerDeps(stage.loggerFor("local-clock"), "ScheduleDispatch"));
      await settle();
      return moved;
    },
    settle,
  };
}
