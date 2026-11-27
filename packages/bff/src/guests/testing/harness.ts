// One self-signup stack in memory for the unit tests and the local flows: the memory engine of the
// connector, the real repositories, caps and services, the fake Cognito wired to the REAL triggers
// (pre-sign-up, custom message, post-confirmation, all over the same store), a DNS stub, a recording
// invoker and a real clock the test moves. Test key only; nothing here reaches AWS.
import type { RepoContext } from "../../connector/codec";
import { createMemoryConnector } from "../../connector/memory/connector";
import { createLogger } from "../../lib/log";
import { handler as customMessage } from "../../auth-triggers/custom-message";
import { createPostConfirmationHandler } from "../../auth-triggers/post-confirmation";
import { createPreSignUpHandler } from "../../auth-triggers/pre-sign-up";
import { signupCaps } from "../caps";
import type { MailDomainResolver } from "../email-domain";
import { guestWorldService } from "../world-status";
import { GUEST_WORLD_PATTERN, leadHashes, signupRuntimeKeys } from "../../leads/keys";
import { passwordService } from "../password";
import type { LeadNoticeRequest, ProvisionInvoker, WorldCreateRequest } from "../provision";
import { leadsRepo } from "../../leads/repo";
import type { SignupServiceDeps } from "../service-deps";
import { signupService } from "../signup";
import { createFakeCognito } from "./fake-cognito-idp";
import { connectorAuditSink } from "../../auth/directory";
import type { SecondFactorCaller } from "../../second-factor/service";
import { memorySmsSender, testSecondFactor } from "../../second-factor/doubles";

export const TEST_PHONE_HASH_KEY = "test-phone-hash-key-0123456789abcdefghijklmnop";
export const TEST_CLIENT_ID = "fake-guest-signup-client";
/** Domains the DNS stub says cannot receive mail. */
export const NO_MAIL_DOMAINS = new Set(["nomail.ar"]);

export function silentLogger() {
  return createLogger({ sink: () => undefined });
}

export interface HarnessOptions {
  readonly start?: Date;
  readonly open?: boolean;
  readonly mailReady?: boolean;
}

export function createSignupHarness(options: HarnessOptions = {}) {
  let clock = new Date(options.start ?? "2026-10-07T13:10:00.000Z");
  const now = () => new Date(clock.getTime());
  const { connector, store } = createMemoryConnector({ now });
  const ctx: RepoContext = { store, now };
  const log = silentLogger();
  const leads = leadsRepo(ctx);
  const caps = signupCaps(ctx);
  const hashes = leadHashes(TEST_PHONE_HASH_KEY);
  const invoked: { worlds: WorldCreateRequest[]; notices: LeadNoticeRequest[] } = { worlds: [], notices: [] };
  const invoker: ProvisionInvoker = {
    createWorld: async (request) => void invoked.worlds.push(request),
    notifyLead: async (request) => void invoked.notices.push(request),
  };
  const resolver: MailDomainResolver = { inspect: async (domain) => (NO_MAIL_DOMAINS.has(domain) ? { status: "NO_MAIL" } : { status: "RECEIVES", exchangers: [] }) };
  const cognito = createFakeCognito({
    clientId: TEST_CLIENT_ID,
    now,
    triggers: {
      preSignUp: createPreSignUpHandler(() => ({ signupRequest: (id, qa) => leads.getSignup(id, qa), currentSignupId: (hash, qa) => leads.currentSignupId(hash, qa), now, log })),
      postConfirmation: createPostConfirmationHandler(() => ({ ctx, connector, leads, invoker, log })),
      customMessage,
    },
  });
  const deps: SignupServiceDeps = {
    ctx,
    connector,
    leads,
    caps,
    cognito,
    clientId: TEST_CLIENT_ID,
    hashes,
    resolver,
    invoker,
    mailReady: () => options.mailReady ?? true,
    log,
  };

  const sms = memorySmsSender();
  const secondFactor = testSecondFactor({ ctx, worlds: connector.worlds, audit: connectorAuditSink(connector.audit, now), sms, invoker })(log);
  /** The caller of `phone.*` for an account, as the Bff builds it from the principal. */
  const phoneCaller = (sub: string, worldId: string = hashes.guestWorldId(sub), signInKey = "origin-jti-test"): SecondFactorCaller => ({
    sub,
    worldId,
    staffId: `stf-${worldId}`,
    signInKey,
    authTime: Math.floor(now().getTime() / 1_000),
    automation: false,
    selfSignup: GUEST_WORLD_PATTERN.test(worldId),
    epoch: 1,
  });

  const setOpen = async (open: boolean) => {
    await store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.switch(), open } });
  };

  return {
    store,
    connector,
    ctx,
    leads,
    caps,
    hashes,
    cognito,
    invoked,
    deps,
    signup: signupService(deps),
    password: passwordService(deps),
    guestWorld: guestWorldService({ ctx, connector, leads, caps, invoker, log }),
    sms,
    secondFactor,
    phoneCaller,
    /** The enrolment of an account's mobile, as `phone.sendCode` and `phone.verify` do it (the pending number of its form). */
    async enrolPhone(sub: string, worldId?: string, phone?: string) {
      const caller = phoneCaller(sub, worldId);
      const sent = await secondFactor.sendCode(caller, phone === undefined ? {} : { phone }, "203.0.113.7");
      if (sent.status !== "CODE_SENT") throw new Error(`the code was not sent: ${sent.status}`);
      return secondFactor.verify(caller, { code: sms.lastCode() ?? "" });
    },
    setOpen,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    now,
    async ready() {
      if (options.open !== false) await setOpen(true);
      return this;
    },
  };
}

export type SignupHarness = ReturnType<typeof createSignupHarness>;

/** A valid form, with what a test changes. */
export function startInput(overrides: Record<string, unknown> = {}) {
  return {
    email: "ana.prospecto@empresa-ficticia.ar",
    password: "Una-Clave-Larga-2026",
    phone: "+54 9 11 5555-0100",
    acceptTerms: true,
    acceptContact: false,
    locale: "es" as const,
    ...overrides,
  } as Parameters<ReturnType<typeof signupService>["start"]>[0];
}
