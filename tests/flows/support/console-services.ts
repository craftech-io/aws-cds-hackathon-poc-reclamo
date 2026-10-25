// The services the console routers reach, bound to an in-process world instead of the linked resources
// (each router's `…Ports` / `bindOperations`, "tests and the local UI server bind their own"): the same
// connector, the real producer, the core as the `Bff` role, the world's buckets, the stage's chain key
// and anchor log, the simulator handing its signed envelope to the world's `InboundWhatsApp`. What the
// stage would reach through another function (the `WorldJanitor` of a reset, Cognito's admin calls of a
// password change) is a recording port. The clock's timers reach the networks as the `Bff` role, which
// the network mock does not list, exactly as in the stage (infra/iam-capabilities.ts).
import { s3ImageStore } from "@reclamo/bff/receipts/linked";
import type { ContextDeps } from "@reclamo/bff/routers/deps";
import { bindOperations } from "@reclamo/bff/routers/inbox";
import type { PasswordAdmin } from "@reclamo/bff/routers/account";
import type { SimulatorPorts } from "@reclamo/bff/routers/simulator";
import type { JanitorInvoker } from "@reclamo/bff/worlds/deps";
import type { WhatsAppSnsEvent } from "@reclamo/bff/channels/whatsapp/payloads";
import { LOCAL_KEYS } from "./keys";
import { LOCAL_CHANNEL_MODES, type StageContext, asS3Client } from "./stage/context";

/** The password every local staff account has: a fixture of the local console, never a pool's. */
export const LOCAL_STAFF_PASSWORD = "Fixture-Password-1!";

export interface ConsoleServicesOptions {
  readonly stage: StageContext;
  /** Hands the simulator's signed envelope to the world's `InboundWhatsApp` (and settles the world). */
  readonly deliver: (event: WhatsAppSnsEvent) => Promise<unknown>;
  /** Where the browser fetches an object (the UI server's `/s3/<bucket>/<key>`); a marker URL in the flows. */
  readonly objectUrl: (bucket: string, key: string) => string;
  /** The simulator's presigned POST (the UI server signs for its S3 emulator). */
  readonly presignUpload?: SimulatorPorts["presignUpload"];
}

export interface RecordedJanitor extends JanitorInvoker {
  readonly invoked: { readonly kind: string; readonly worldId: string; readonly requestId: string }[];
}

export interface RecordedPasswords extends PasswordAdmin {
  /** Passwords set, by username (the value is the fixture or what a test set). */
  readonly passwords: Map<string, string>;
}

export interface BoundConsole {
  readonly deps: ContextDeps;
  readonly janitor: RecordedJanitor;
  readonly passwords: RecordedPasswords;
}

function recordedPasswords(): RecordedPasswords {
  const passwords = new Map<string, string>();
  return {
    passwords,
    verify: async (username, password) => (passwords.get(username) ?? LOCAL_STAFF_PASSWORD) === password,
    set: async (username, password) => void passwords.set(username, password),
  };
}

let mediaIds = 0;

/** `deps` with every console router's services bound to the world. */
export function bindConsoleServices(deps: ContextDeps, options: ConsoleServicesOptions): BoundConsole {
  const { stage } = options;
  const { connector, s3 } = stage;
  const janitor: RecordedJanitor = { invoked: [], invoke: async (event) => void janitor.invoked.push(event) };
  const passwords = recordedPasswords();
  const presignUpload: SimulatorPorts["presignUpload"] =
    options.presignUpload ?? (async (key) => ({ url: options.objectUrl("Media", ""), fields: { key } }));
  const bound: ContextDeps = {
    ...deps,
    accountPorts: { connector, passwords },
    clockPorts: { connector, timers: (log) => stage.timerDeps(log, "Bff"), janitor },
    emailsPorts: { connector, emailObject: async (key) => s3.get("Emails", key)?.bytes, documentUrl: async (key) => options.objectUrl("Documents", key) },
    policyPorts: { connector, stageModes: () => LOCAL_CHANNEL_MODES },
    metricsPorts: { connector },
    registerPorts: {
      connector,
      chainKey: () => LOCAL_KEYS.registerChain,
      anchors: stage.anchorLog,
      exports: { put: async (key, body, contentType) => s3.put("Exports", key, new TextEncoder().encode(body), contentType), url: async (key) => options.objectUrl("Exports", key) },
    },
    simulatorPorts: {
      connector,
      whatsAppMode: async () => "simulated",
      envelopeKey: () => LOCAL_KEYS.simEnvelope.console,
      deliver: options.deliver,
      presignUpload,
      newMediaId: () => `SIM${(++mediaIds).toString(16).padStart(32, "a")}`,
    },
    tourPorts: { connector },
  };
  bindOperations(bound, {
    data: connector,
    chains: () => stage.complaints(stage.loggerFor("local-console")),
    enqueuer: (log) => stage.enqueuer(log),
    core: () => stage.mocks.core("Bff"),
    images: () => s3ImageStore({ Media: "Media", Seed: "Seed" }, asS3Client(s3)),
    presignMedia: async (key) => options.objectUrl("Media", key),
    newId: stage.newId,
  });
  return { deps: bound, janitor, passwords };
}
