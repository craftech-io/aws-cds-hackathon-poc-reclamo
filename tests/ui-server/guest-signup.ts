// The self-signup on the local UI server (docs/test-plan.md §2, level UI; docs/architecture-guests.md
// §3-§5): main.ts loads this module when it exists and hands its `guestSignupServices` to app.ts, which
// mounts them under `/api/public/*` behind the same edge guard as the stage (the edge header from the
// edge key and `x-reclamo-viewer-ip` from the socket, after dropping any `x-reclamo-*` the browser sent).
//
// Over the UI server's in-process world it wires the real services (`signup.*`, `password.*`, and
// `guest.status`/`guest.requestWorld` for the console) with the real repositories and caps, and the
// fake Cognito pool of packages/bff/src/guests/testing/fake-cognito-idp.ts bound to the REAL triggers
// (pre-sign-up, custom message, post-confirmation) over the same store. Nothing leaves the process:
// the codes stay in the fake pool's outbox (`signupStackOf(world).cognito`), the DNS check is a stub
// that accepts every domain, and the world factory and the lead notice are recorded, not run, so a
// confirmed account waits `REGISTERED` exactly like the stage before the factory answers. The sign-up
// switch is opened as `seed:load` opens it in the stage (ADR-0021 §1). Test keys only.
import type { Logger } from "@reclamo/bff/lib/log";
import type { RepoContext } from "@reclamo/bff/connector/codec";
import { handler as customMessage } from "@reclamo/bff/auth-triggers/custom-message";
import { createPostConfirmationHandler } from "@reclamo/bff/auth-triggers/post-confirmation";
import { createPreSignUpHandler } from "@reclamo/bff/auth-triggers/pre-sign-up";
import { signupCaps } from "@reclamo/bff/guests/caps";
import type { MailDomainResolver } from "@reclamo/bff/guests/email-domain";
import { passwordService } from "@reclamo/bff/guests/password";
import type { LeadNoticeRequest, ProvisionInvoker, WorldCreateRequest } from "@reclamo/bff/guests/provision";
import type { SignupServiceDeps } from "@reclamo/bff/guests/service-deps";
import { signupService } from "@reclamo/bff/guests/signup";
import { type FakeCognito, createFakeCognito } from "@reclamo/bff/guests/testing/fake-cognito-idp";
import { guestWorldService } from "@reclamo/bff/guests/world-status";
import { leadHashes, signupRuntimeKeys } from "@reclamo/bff/leads/keys";
import { leadsRepo } from "@reclamo/bff/leads/repo";
import type { ContextDeps } from "@reclamo/bff/routers/deps";
import type { PublicServices } from "@reclamo/bff/routers/signup";
import { LOCAL_KEYS } from "../flows/support/keys";
import type { FlowWorld } from "../flows/support/world";
import type { PublicServicesFactory } from "./app";

/** The `GuestSignupClient` id of the fake pool (the pre-sign-up trigger checks it on every sign-up). */
export const LOCAL_GUEST_CLIENT_ID = "local-guest-signup-client";

export interface SignupStack {
  readonly cognito: FakeCognito;
  /** What the stage would hand `WorldJanitor` and `LeadNotifier` asynchronously. */
  readonly invoked: { readonly worlds: WorldCreateRequest[]; readonly notices: LeadNoticeRequest[] };
  services(log: Logger): PublicServices;
}

const stacks = new WeakMap<FlowWorld, SignupStack>();

/** Every domain receives mail: the UI server is offline, and the BFF's shape rules still apply. */
const offlineResolver: MailDomainResolver = { receivesMail: async () => true };

function buildStack(world: FlowWorld): SignupStack {
  const ctx: RepoContext = { store: world.store, now: () => world.realNow() };
  const leads = leadsRepo(ctx);
  const caps = signupCaps(ctx);
  const invoked: SignupStack["invoked"] = { worlds: [], notices: [] };
  const invoker: ProvisionInvoker = {
    createWorld: async (request) => void invoked.worlds.push(request),
    notifyLead: async (request) => void invoked.notices.push(request),
  };
  const triggerLog = world.stage.loggerFor("local-auth-triggers");
  const cognito = createFakeCognito({
    clientId: LOCAL_GUEST_CLIENT_ID,
    now: ctx.now,
    triggers: {
      preSignUp: createPreSignUpHandler(() => ({ signupRequest: (id, qa) => leads.getSignup(id, qa), currentSignupId: (hash, qa) => leads.currentSignupId(hash, qa), now: ctx.now, log: triggerLog })),
      postConfirmation: createPostConfirmationHandler(() => ({ ctx, connector: world.connector, leads, invoker, log: triggerLog })),
      customMessage,
    },
  });
  const depsFor = (log: Logger): SignupServiceDeps => ({
    ctx,
    connector: world.connector,
    leads,
    caps,
    cognito,
    clientId: LOCAL_GUEST_CLIENT_ID,
    hashes: leadHashes(LOCAL_KEYS.phoneHash),
    resolver: offlineResolver,
    invoker,
    mailReady: () => true,
    log,
  });
  return {
    cognito,
    invoked,
    services: (log) => {
      const deps = depsFor(log);
      return { signup: signupService(deps), password: passwordService(deps) };
    },
  };
}

/** The world's self-signup stack (one per world): its fake pool, what it invoked, its services. */
export function signupStackOf(world: FlowWorld): SignupStack {
  let stack = stacks.get(world);
  if (stack === undefined) {
    stack = buildStack(world);
    stacks.set(world, stack);
  }
  return stack;
}

/**
 * `guest.status` and `guest.requestWorld` for the console's procedures: the router reads them from
 * its `ContextDeps`, which the UI server builds once for the world (tests/flows/support/console.ts).
 */
function bindGuestWorld(world: FlowWorld): void {
  const ctx: RepoContext = { store: world.store, now: () => world.realNow() };
  const leads = leadsRepo(ctx);
  const caps = signupCaps(ctx);
  const invoker: ProvisionInvoker = { createWorld: async (request) => void signupStackOf(world).invoked.worlds.push(request), notifyLead: async () => undefined };
  const guestWorld: ContextDeps["guestWorld"] = (log) => guestWorldService({ ctx, connector: world.connector, leads, caps, invoker, log });
  Object.assign(world.localConsole.deps, { guestWorld });
}

/** The sign-up switch, open as `seed:load` leaves it in the stage (a missing row reads closed). */
async function openSignup(world: FlowWorld): Promise<void> {
  await world.store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.switch(), open: true } });
}

export const guestSignupServices: PublicServicesFactory = (world) => {
  bindGuestWorld(world);
  openSignup(world).catch((error: unknown) => world.stage.loggerFor("local-signup").error("signup.switch_failed", { errorName: error instanceof Error ? error.name : "UnknownError" }));
  const stack = signupStackOf(world);
  return (log) => stack.services(log);
};
