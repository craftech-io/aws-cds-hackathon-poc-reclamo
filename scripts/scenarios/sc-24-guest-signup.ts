// SC-24 · self-signup and guests (docs/test-plan.md §4.5; before SC-21, in its lane). The runner signs up
// through the real service (`GuestSignupClient`, the deployed pre-sign-up and post-confirmation
// triggers) with addresses of the SES mailbox simulator only (`success+qa-<runId>-su<n>@…`): the lead is a
// `QALEAD#` that is never notified nor exported, and the worlds are `qa-<runId>-su<n>`, built by the real
// provisioning (ticket, queue, factory) — never a `gs-*`. Codes, resends, a taken email, a restarted
// sign-up, the guest capacity's queue, the sign-up caps, the sign-in, expiry and recreation, the neutral
// recovery, the edge and Cognito's web ACL, sign-out, the day's usage cap and the lead notice's transport
// (`notice.probe`, to the SES mailbox simulator only) are each proved on the stage. The QA lead is read
// through the QaDriver (`guest.lead`: campaign, consents and instants, never the address).
import { CognitoIdentityProviderClient, ConfirmForgotPasswordCommand, SignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { qaSignupEmail } from "@reclamo/bff/guests/signup";
import { copy } from "../../packages/web/src/copy/console";
import { REGION } from "./lib/driver-client";
import { EDGE_CHALLENGE_ENFORCED } from "../../infra/guest-limits";
import { consoleClientId, directForgotPassword, publicPostInPage, publicPostOutside } from "./lib/edge";
import { WAITS } from "./lib/eventually";
import { SITE, fetchPage } from "./lib/site";
import { guestTemplateComplaints, serverClientRefused } from "./lib/smoke";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { TOKENS_KEY, type Tokens, browserOf, openConsole } from "./sc-22-guest-world";

/** The access screens' fixed lines (docs/landing-spec.md §9, views/login/auth-copy-es.ts, whose module pulls DOM types). */
const PROVISIONING = {
  expiredTitle: "Tu entorno venció; lo preparamos de nuevo.",
  expiredButton: "Preparar mi entorno",
  usageLimit: "Llegaste al límite de uso de hoy de este entorno.",
  signOut: "Salir",
} as const;

type Key = "su1" | "su2" | "su3" | "su4";
type SignupAnswer = { readonly status: string; readonly signupId?: string };
type GuestTokens = Tokens & { readonly worldStatus: string | null };
type QaLead = { readonly exists: boolean; readonly utm?: { readonly source?: string } | null; readonly lastLoginAtReal?: string | null; readonly notified?: boolean };

/** The campaign of the visit a QA sign-up carries, as the public form would (utm_source=qa). */
const QA_UTM = { source: "qa", medium: "scenario", campaign: "sc24" } as const;

const worldOfKey = (ctx: ScenarioContext, key: Key) => `qa-${ctx.runId}-${key}`;

async function signup(ctx: ScenarioContext, key: Key): Promise<SignupAnswer> {
  return (await ctx.qa("guest.signup", { runId: ctx.runId, key, locale: "en", acceptContact: false, utm: QA_UTM })) as SignupAnswer;
}

async function confirm(ctx: ScenarioContext, key: Key, signupId: string, code?: string): Promise<{ readonly status: string; readonly worldStatus?: string }> {
  return (await ctx.qa("guest.confirm", { runId: ctx.runId, key, signupId, ...(code === undefined ? {} : { code }) })) as { status: string; worldStatus?: string };
}

const session = async (ctx: ScenarioContext, key: Key): Promise<GuestTokens> => (await ctx.qa("guest.session", { runId: ctx.runId, key })) as GuestTokens;
const leadOf = async (ctx: ScenarioContext, key: Key): Promise<QaLead> => (await ctx.qa("guest.lead", { runId: ctx.runId, key })) as QaLead;

/** The account's world status as its sign-in reads it, polled until `status` (the factory builds a guest world in minutes). */
async function worldStatus(ctx: ScenarioContext, key: Key, status: string, timeoutSec: number = WAITS.worldSec): Promise<GuestTokens> {
  return ctx.eventually(`${key}'s world ${status}`, async () => {
    const tokens = await session(ctx, key);
    return tokens.worldStatus === status ? tokens : undefined;
  }, timeoutSec, WAITS.worldEverySec);
}

/** `guest.expireNow` as a probe, one key, until EXPIRED. */
async function expire(ctx: ScenarioContext, key: Key): Promise<void> {
  const step = ctx.repeatable("guest.expireNow", { worldId: worldOfKey(ctx, key) });
  await ctx.eventually(`${key}'s world EXPIRED`, async () => ((await step()) as { state: string }).state === "EXPIRED", WAITS.worldSec, WAITS.worldEverySec);
}

function signupIdOf(ctx: ScenarioContext, name: string): string {
  const id = ctx.state[`signup:${name}`];
  ensure(typeof id === "string", `no sign-up "${name}" yet`);
  return id;
}

/** Cognito's own API with a client and a `qa-` name the runner owns: the error name, or `OK`. */
async function direct(command: SignUpCommand | ConfirmForgotPasswordCommand): Promise<string> {
  const client = new CognitoIdentityProviderClient({ region: REGION, maxAttempts: 2, requestHandler: new NodeHttpHandler({ requestTimeout: 15_000, connectionTimeout: 3_000 }) });
  try {
    await (command instanceof SignUpCommand ? client.send(command) : client.send(command));
    return "OK";
  } catch (error) {
    return error instanceof Error ? error.name : "Error";
  }
}

export default defineScenario({
  id: "SC-24",
  slug: "sc24",
  title: "Self-signup and guests: code, lead, queue, caps, sign-in, expiry, recovery, edge, sign-out, usage",
  suites: ["full"],
  lane: "guest",
  laneOrder: 1,
  steps: [
    {
      n: 1,
      title: "guest.signup (real service, simulator address, locale en, no contact consent, utm_source=qa) → CODE_SENT, the account UNCONFIRMED (a sign-in before the confirmation is refused NOT_CONFIRMED)",
      flows: ["FL-112", "FL-113"],
      async run(ctx) {
        const started = await signup(ctx, "su1");
        ctx.check(started.status === "CODE_SENT" && started.signupId !== undefined, `signup.start answered ${started.status}`);
        ctx.state["signup:su1"] = started.signupId;
        const early = await ctx.attempt("guest.session", { runId: ctx.runId, key: "su1" });
        ctx.check(!early.ok && early.error.reason === "NOT_CONFIRMED", `a sign-in of the unconfirmed account answered ${early.ok ? "tokens" : `${early.error.code} ${early.error.reason ?? ""}`}, expected NOT_CONFIRMED`);
        ctx.warn("no lead before the confirmation is a fact of Leads, which the runner never reads (U: guests/signup.test.ts)");
      },
    },
    {
      n: 2,
      title: "guest.confirm → the real post-confirmation: QALEAD# with the visit's campaign, the world REGISTERED with its ticket, READY by the factory within 600 s, the guest template",
      flows: ["FL-113", "FL-120", "FL-126"],
      async run(ctx) {
        const started = ctx.now();
        const confirmed = await confirm(ctx, "su1", signupIdOf(ctx, "su1"));
        ctx.check(confirmed.status === "CONFIRMED", `the confirmation answered ${confirmed.status}`);
        await worldStatus(ctx, "su1", "READY");
        ctx.measure("signupToReadyMs", ctx.now() - started);
        const metrics = (await ctx.qa("metrics.get", { worldId: worldOfKey(ctx, "su1") })) as { seededHistory?: { total: number } };
        ctx.check(metrics.seededHistory?.total === guestTemplateComplaints(), "the self-signup world is not the guest template");
        const lead = await leadOf(ctx, "su1");
        ctx.check(lead.exists && lead.utm?.source === QA_UTM.source, `the QA lead ${lead.exists ? `carries utm_source ${lead.utm?.source ?? "none"}` : "does not exist"}, expected ${QA_UTM.source}`);
        ctx.check(lead.notified === false, "a QA lead was notified");
        ctx.warn("LEAD_NOTICE_SKIPPED for a QA lead is an audit of LeadNotifier the runner does not read (U: handlers/lead-notifier.test.ts)");
      },
    },
    {
      n: 3,
      title: "a made-up code → CODE_MISMATCH; four resends in the hour → the fourth RATE_LIMITED",
      flows: ["FL-114", "FL-115"],
      async run(ctx) {
        const started = await signup(ctx, "su2");
        ensure(started.signupId !== undefined, `su2's sign-up answered ${started.status}`);
        ctx.state["signup:su2"] = started.signupId;
        ctx.check((await confirm(ctx, "su2", started.signupId, "123456")).status === "CODE_MISMATCH", "a made-up code was accepted");
        const resends: string[] = [];
        for (let attempt = 0; attempt < 4; attempt += 1) resends.push(((await ctx.qa("guest.resend", { runId: ctx.runId, key: "su2", signupId: started.signupId })) as { status: string }).status);
        ctx.check(resends.slice(0, 3).every((status) => status === "CODE_SENT") && resends[3] === "RATE_LIMITED", `resends answered ${resends.join(", ")}`);
      },
    },
    {
      n: 4,
      title: "the confirmed email again → EMAIL_TAKEN; an unconfirmed one again → a new signupId; the old signupId with a valid confirmation → SIGNUP_RESTART",
      flows: ["FL-116"],
      async run(ctx) {
        ctx.check((await signup(ctx, "su1")).status === "EMAIL_TAKEN", "a confirmed email could sign up again");
        ctx.warn("the same address in upper case cannot be asked of the driver (it builds the run's own address); U proves the canonical email");
        const first = await signup(ctx, "su3");
        const second = await signup(ctx, "su3");
        ensure(first.signupId !== undefined && second.signupId !== undefined, "su3's sign-ups sent no code");
        ctx.check(first.signupId !== second.signupId, "the second sign-up kept the first signupId");
        ctx.check((await confirm(ctx, "su3", first.signupId)).status === "SIGNUP_RESTART", "the replaced signupId confirmed an account");
        const world = await ctx.attempt("snapshot", { worldId: worldOfKey(ctx, "su3") });
        ctx.check(!world.ok, "a world was built for a restarted sign-up");
      },
    },
    {
      n: 5,
      title: "GUESTCAP#QA at 1: su2 confirmed waits REGISTERED in the queue; su1 expired → the provisioning pass builds su2",
      flows: ["FL-117"],
      async run(ctx) {
        await ctx.qa("caps.prime", { bucket: "GUESTCAP_QA", value: 1 });
        await confirm(ctx, "su2", signupIdOf(ctx, "su2"));
        const queued = await worldStatus(ctx, "su2", "REGISTERED", 60);
        ctx.note("queuedStatus", queued.worldStatus ?? "none");
        await expire(ctx, "su1");
        await worldStatus(ctx, "su2", "READY");
      },
    },
    {
      n: 6,
      title: "caps.prime(SIGNUP_QA) at the cap → RATE_LIMITED, no account created",
      flows: ["FL-118"],
      async run(ctx) {
        await ctx.qa("caps.prime", { bucket: "SIGNUP_QA", value: 100_000, window: "HOUR" });
        try {
          ctx.check((await signup(ctx, "su4")).status === "RATE_LIMITED", "the sign-up cap let a sign-up through");
          ctx.check(!(await ctx.attempt("guest.session", { runId: ctx.runId, key: "su4" })).ok, "an account exists for a refused sign-up");
        } finally {
          await ctx.qa("caps.prime", { bucket: "SIGNUP_QA", value: 0, window: "HOUR" });
        }
      },
    },
    {
      n: 7,
      title: "guest.session (SRP) of su2 → worldStatus READY; the console opens on /app/inbox; the lead's lastLoginAtReal stamped",
      flows: ["FL-121"],
      async run(ctx) {
        const tokens = await session(ctx, "su2");
        ctx.check(tokens.worldStatus === "READY", `the sign-in reads ${tokens.worldStatus ?? "no"} world status`);
        const tab = await openConsole(ctx, await browserOf(ctx), worldOfKey(ctx, "su2"), "su2", "GUEST", "/app/inbox", tokens);
        await tab.page.getByRole("heading", { name: copy.views.inbox.title }).waitFor({ timeout: 60_000 });
        await tab.context.close();
        // The console's guest.status stamped the QALEAD# of su2's world (guests/world-status.ts).
        const lead = await ctx.eventually("su2's lead lastLoginAtReal", async () => {
          const read = await leadOf(ctx, "su2");
          return read.lastLoginAtReal ? read : undefined;
        }, 60, 5);
        ctx.check(Date.parse(lead.lastLoginAtReal ?? "") > 0, "the lead's lastLoginAtReal was not recorded");
      },
    },
    {
      n: 8,
      title: "su2 expired → EXPIRED, account intact; the console says the environment expired; \"Preparar mi entorno\" → READY, epoch + 1, a clean template",
      flows: ["FL-124"],
      async run(ctx) {
        const worldId = worldOfKey(ctx, "su2");
        const epoch = (await ctx.snapshot(worldId)).epoch;
        await expire(ctx, "su2");
        const tokens = await session(ctx, "su2");
        ctx.check(tokens.worldStatus === "EXPIRED", `the account signs in to a ${tokens.worldStatus ?? "missing"} world`);
        const tab = await openConsole(ctx, await browserOf(ctx), worldId, "su2", "GUEST", "/app/inbox", tokens);
        await tab.page.getByText(PROVISIONING.expiredTitle).waitFor({ timeout: 60_000 });
        await tab.page.getByRole("button", { name: PROVISIONING.expiredButton }).click();
        await worldStatus(ctx, "su2", "READY");
        ctx.check((await ctx.snapshot(worldId)).epoch === epoch + 1, "the recreated world is not a new epoch");
        const metrics = (await ctx.qa("metrics.get", { worldId })) as { n: number; seededHistory?: { total: number } };
        ctx.check(metrics.n === 0 && metrics.seededHistory?.total === guestTemplateComplaints(), "the recreated world is not a clean guest template");
        await tab.context.close();
      },
    },
    {
      n: 9,
      title: "password.forgot through the edge for su2's email and for an unknown one → the same CODE_SENT_IF_EXISTS",
      flows: ["FL-122"],
      async run(ctx) {
        const page = await (await (await browserOf(ctx)).newContext({ viewport: { width: 390, height: 844 }, locale: "es-AR" })).newPage();
        await page.goto(`${SITE}/login/recover`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.locator('input[type="email"]').first().waitFor({ timeout: 60_000 });
        const ask = (email: string) => publicPostInPage(page, "password.forgot", { email, locale: "en" });
        const [known, unknown] = [await ask(qaSignupEmail({ runId: ctx.runId, key: "su2" })), await ask(qaSignupEmail({ runId: ctx.runId, key: "su9" }))];
        ctx.check(known.result === "CODE_SENT_IF_EXISTS" && unknown.result === known.result, `recovery answered ${known.result ?? known.status} and ${unknown.result ?? unknown.status}`);
        await page.context().close();
        ctx.warn("AUTHMAIL# rising only for su2, and the SUPERVISOR's recovery refused, are facts of Runtime the runner does not read (U: routers/signup.test.ts)");
      },
    },
    {
      n: 10,
      title: "from the runner: signup.start of a simulator address → refused (the Bff's INVALID_EMAIL; the edge's while rule 6 challenges); a batched public call → refused; the Bff's URL without the edge header → EDGE_REQUIRED",
      flows: ["FL-119"],
      async run(ctx) {
        const outside = await publicPostOutside("signup.start", { email: qaSignupEmail({ runId: ctx.runId, key: "su9" }), password: `Qa-${ctx.runId}-Aa9!xyzw`, acceptTerms: true, acceptContact: false, locale: "en" });
        const refused = EDGE_CHALLENGE_ENFORCED ? outside.edgeRefused : !outside.edgeRefused && outside.result === "INVALID_EMAIL";
        ctx.check(refused, `signup.start from outside a browser answered ${outside.status} ${outside.result ?? ""}`);
        const batched = await fetchPage("/api/guest.status,signup.start?batch=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        ctx.check(batched.status === 403 || batched.status === 404, `a batched public call answered ${batched.status}`);
        const edge = (await ctx.qa("probe.edge", {})) as { refused: boolean; status: number };
        ctx.check(edge.refused, `the Bff's Function URL answered ${edge.status} without the edge header`);
        ctx.blocked("LAMBDA_FENCE", "EDGE_REQUIRED");
      },
    },
    {
      n: 11,
      title: "SignUp, ForgotPassword and ConfirmForgotPassword straight to Cognito with the console's client and the ServerClient → ForbiddenException of the web ACL",
      flows: ["FL-119", "FL-122"],
      async run(ctx) {
        const page = await (await (await browserOf(ctx)).newContext()).newPage();
        const username = `qa-${ctx.runId}-sc24-nobody`;
        const clientId = await consoleClientId(page, username);
        await page.context().close();
        ensure(clientId !== undefined, "the console never called Cognito: its client id is unknown");
        const answers = {
          SignUp: await direct(new SignUpCommand({ ClientId: clientId, Username: username, Password: `Qa-${ctx.runId}-Aa9!xyzw`, UserAttributes: [{ Name: "email", Value: `${username}@example.com` }] })),
          ForgotPassword: await directForgotPassword(clientId, username),
          ConfirmForgotPassword: await direct(new ConfirmForgotPasswordCommand({ ClientId: clientId, Username: username, ConfirmationCode: "123456", Password: `Qa-${ctx.runId}-Bb8!xyzw` })),
        };
        for (const [operation, answer] of Object.entries(answers)) ctx.check(answer === "ForbiddenException", `${operation} with the console's client answered ${answer}`);
        // The ServerClient's id never reaches the runner: the driver sends the same calls for a SUPERVISOR.
        await serverClientRefused(ctx, "11", "11");
      },
    },
    {
      n: 12,
      title: "\"Salir\" → back to /, the session gone",
      flows: ["FL-123"],
      async run(ctx) {
        const tab = await openConsole(ctx, await browserOf(ctx), worldOfKey(ctx, "su2"), "su2", "GUEST", "/app/inbox", await session(ctx, "su2"));
        await tab.page.getByRole("heading", { name: copy.views.inbox.title }).waitFor({ timeout: 60_000 });
        await tab.page.getByRole("button", { name: new RegExp(`^(${PROVISIONING.signOut}|${copy.app.signOut})`) }).first().click();
        await tab.page.waitForURL(`${SITE}/`, { timeout: 30_000 });
        const left = await tab.page.evaluate((key) => (globalThis as unknown as { sessionStorage: { getItem(name: string): string | null } }).sessionStorage.getItem(key), TOKENS_KEY);
        ctx.check(left === null, "the session's tokens stayed in the tab after signing out");
        await tab.context.close();
        ctx.warn("the runner's sessions carry no refresh token, so its revocation is proved in U (routers/guest.test.ts) and UI (guest-session.spec.ts)");
      },
    },
    {
      n: 13,
      title: "caps.prime(TURNCAP) in su2's world → TURN_CAP without the Harness, and the console's notice of today's usage limit",
      flows: ["FL-125"],
      async run(ctx) {
        const worldId = worldOfKey(ctx, "su2");
        await ctx.qa("caps.prime", { worldId, bucket: "TURNCAP", value: 100_000, window: "DAY" });
        const before = await ctx.settled(worldId, "cus-0001");
        await ctx.qa("wa.inbound", { worldId, persona: "C01", content: { type: "text", text: "Hola, ¿me confirman el estado de mi pago?" } });
        const after = await ctx.settled(worldId, "cus-0001");
        ctx.check(after.turnsToday === before.turnsToday, `${after.turnsToday - before.turnsToday} turn(s) ran past the cap`);
        const tab = await openConsole(ctx, await browserOf(ctx), worldId, "su2", "GUEST", "/app/inbox", await session(ctx, "su2"));
        await tab.page.getByText(PROVISIONING.usageLimit).first().waitFor({ timeout: 60_000 });
        await tab.context.close();
      },
    },
    {
      n: 14,
      title: "notice.probe: the real lead notice of a synthetic QA lead through the real SES transport, to the mailbox simulator only → SENT, audited LEAD_NOTICE_PROBE",
      flows: ["FL-126"],
      async run(ctx) {
        const probe = (await ctx.qa("notice.probe", {})) as { outcome: string; recipient: string };
        ctx.check(probe.outcome === "SENT" && probe.recipient === "SES_MAILBOX_SIMULATOR", `notice.probe answered ${probe.outcome} to ${probe.recipient}`);
        ctx.warn("the first real LEAD_NOTICE_SENT (SIGNUP#AUD#<yyyy-mm>) is the operator's to confirm after the first visitor's sign-up");
      },
    },
  ],
  async cleanup(ctx) {
    await ctx.qa("caps.prime", { bucket: "SIGNUP_QA", value: 0, window: "HOUR" });
    const browser = ctx.state["browser"] as { close(): Promise<void> } | undefined;
    await browser?.close();
    for (const key of ["su1", "su2"] as const) {
      const destroy = ctx.repeatable("world.destroy", { worldId: worldOfKey(ctx, key) });
      await ctx.eventually(`${key}'s world destroyed`, async () => ((await destroy()) as { state: string }).state === "DESTROYED", WAITS.worldSec, 2).catch((error: unknown) => ctx.warn(`world.destroy ${key}: ${error instanceof Error ? error.message : "failed"}`));
    }
  },
});
