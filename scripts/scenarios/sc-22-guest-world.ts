// SC-22 · the guest's world and sessions (docs/test-plan.md §4.5; runs before SC-24 and SC-21, in their
// lane). Two worlds of the `guest` template (`sc22a`, `sc22b`), the live-channel QA world and a world made
// by `guest.invite` (`sc22j`). Playwright drives https://reclamo.demo.craftech.io with the tokens of
// `auth.session` in `sessionStorage` (no password, no login form): another world's id is refused, another
// user's session sees the notice, a reset goes the real HTTP way (CloudFront → Bff) and comes back READY
// within its budget, the guest cannot edit its own Cognito user, two worlds with the same persona never
// share memory or schedules, a simulated envelope never reaches a live world, and the real guest path
// (the invite's code and an SRP login through the deployed trigger) opens a pristine console.
//
// The browser helpers are exported: SC-21 and SC-24 drive the console the same way.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { CONSOLE_EN } from "@reclamo/bff/copy/en-gloss";
import { CONSOLE_ES, STAFF_TEXT } from "@reclamo/bff/copy/es-AR";
import type { StaffRole } from "@reclamo/shared";
import { copy } from "../../packages/web/src/copy/console";
import { consoleAttempt, consoleCall } from "./lib/console";
import { launchBrowser } from "./lib/edge";
import { WAITS } from "./lib/eventually";
import { SITE, consoleQuery, trpcData } from "./lib/site";
import { guestTemplateComplaints } from "./lib/smoke";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

export interface Tokens {
  readonly idToken: string;
  readonly accessToken: string;
  /** Epoch seconds. */
  readonly exp: number;
  readonly authTime: number;
  readonly loginMs: number;
}

export interface ConsoleTab {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly worldId: string;
  readonly sessionKey: string;
  readonly role: StaffRole;
  tokens: Tokens;
  /** `Authorization` of the `/api/*` requests since the last injection, in order. */
  readonly sent: string[];
}

/** packages/web/src/lib/auth/tokens.ts `TOKENS_KEY` (that module pulls DOM types the scripts do not compile). */
export const TOKENS_KEY = "reclamo.console.tokens";
/** The clock view's reset buttons (views/clock/copy.ts builds them from the same copy; it imports a component). */
const RESET_ASK = `${CONSOLE_ES.BUTTON_RESET_WORLD} · ${CONSOLE_EN.BUTTON_RESET_WORLD}`;
const RESET_CONFIRM = /^Sí, reiniciar/;

type Storage = { readonly sessionStorage: { setItem(key: string, value: string): void } };
const REISSUE_BEFORE_MS = 3 * 60_000;

const stored = (tokens: Tokens) => JSON.stringify({ idToken: tokens.idToken, accessToken: tokens.accessToken, expiresAt: tokens.exp * 1_000 });

export async function signIn(ctx: ScenarioContext, worldId: string, sessionKey: string, role: StaffRole, flow: "ADMIN" | "SRP" = "ADMIN"): Promise<Tokens> {
  return (await ctx.qa("auth.session", { worldId, sessionKey, role, flow })) as Tokens;
}

/** A tab of the console with the session planted before the app boots (first load only), at `path`. */
export async function openConsole(ctx: ScenarioContext, browser: Browser, worldId: string, sessionKey: string, role: StaffRole, path: string, tokens?: Tokens): Promise<ConsoleTab> {
  const session = tokens ?? (await signIn(ctx, worldId, sessionKey, role));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es-AR" });
  await context.addInitScript(
    ({ key, value }) => {
      const storage = (globalThis as unknown as Storage).sessionStorage as Storage["sessionStorage"] & { getItem(key: string): string | null };
      if (storage.getItem("reclamo.qa.planted") !== null) return;
      storage.setItem("reclamo.qa.planted", "1");
      storage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: stored(session) },
  );
  const page = await context.newPage();
  const tab: ConsoleTab = { page, context, worldId, sessionKey, role, tokens: session, sent: [] };
  page.on("request", (request) => {
    if (request.url().startsWith(`${SITE}/api/`)) tab.sent.push(request.headers()["authorization"] ?? "");
  });
  await page.goto(`${SITE}${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return tab;
}

/** Re-issues the session (same key) and injects it WITHOUT reloading when it is under 3 minutes from `exp`, or always with `force`. */
export async function reissue(ctx: ScenarioContext, tab: ConsoleTab, force = false): Promise<boolean> {
  if (!force && tab.tokens.exp * 1_000 - ctx.now() >= REISSUE_BEFORE_MS) return false;
  tab.tokens = await signIn(ctx, tab.worldId, tab.sessionKey, tab.role);
  await tab.page.evaluate(({ key, value }) => (globalThis as unknown as Storage).sessionStorage.setItem(key, value), { key: TOKENS_KEY, value: stored(tab.tokens) });
  tab.sent.length = 0;
  ctx.note(`reissued-${ctx.step}`, new Date(tab.tokens.exp * 1_000).toISOString());
  return true;
}

/** The first request to the BFF after an injection carries the new token. */
export async function expectFreshToken(ctx: ScenarioContext, tab: ConsoleTab): Promise<void> {
  const first = await ctx.eventually("a request to the BFF after the injection", async () => tab.sent[0], 60, 1);
  ctx.check(first === `Bearer ${tab.tokens.idToken}`, "the request after the injection carried the old token");
}

/** Neither the recent-login prompt nor the other-session notice is on the page. */
export async function noInterruptions(ctx: ScenarioContext, tab: ConsoleTab): Promise<void> {
  // The recent-login prompt is the console's only dialog over a view: none may be open.
  ctx.check((await tab.page.getByRole("dialog").count()) === 0, "a dialog (the recent-login prompt) opened");
  ctx.check((await tab.page.getByText(STAFF_TEXT.OTHER_SESSION).count()) === 0, "the other-session notice is on the page");
}

/** A tRPC call from inside the page (same origin, CSP and WAF cookie), with the stored token. */
export async function inPage(tab: ConsoleTab, procedure: string, input: unknown, method: "GET" | "POST"): Promise<{ readonly status: number; readonly body: string; readonly ms: number }> {
  return tab.page.evaluate(
    async ({ path, body, verb, key }) => {
      const raw = (globalThis as unknown as { sessionStorage: { getItem(key: string): string | null } }).sessionStorage.getItem(key);
      const token = raw === null ? "" : (JSON.parse(raw) as { idToken: string }).idToken;
      const query = verb === "GET" && body !== undefined ? `?input=${encodeURIComponent(JSON.stringify(body))}` : "";
      const started = performance.now();
      const answer = await fetch(`${path}${query}`, { method: verb, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, ...(verb === "POST" ? { body: JSON.stringify(body ?? null) } : {}) });
      return { status: answer.status, body: await answer.text(), ms: performance.now() - started };
    },
    { path: `/api/${procedure}`, body: input, verb: method, key: TOKENS_KEY },
  );
}

/** `clock.reset` as `role` (recent sign-in), retried while the last reset is under 10 real minutes old; then READY. */
export async function resetAndWait(ctx: ScenarioContext, worldId: string, role: StaffRole): Promise<void> {
  await ctx.eventually(
    `${worldId} accepts a reset`,
    async () => {
      const answer = await consoleAttempt(ctx, "clock", "reset", undefined, { worldId, role, signedInSecAgo: 0 });
      if (answer.ok) return answer.result.status === "RESETTING";
      if (answer.error.reason === "RATE_LIMITED") return false;
      throw new Error(`clock.reset answered ${answer.error.code} ${answer.error.reason ?? ""}`);
    },
    12 * 60,
    60,
  );
  await ctx.eventually(`${worldId} READY`, async () => (await consoleCall(ctx, "clock", "resetStatus", undefined, { worldId, role })).status === "READY", WAITS.worldSec, WAITS.worldEverySec);
}

export async function browserOf(ctx: ScenarioContext): Promise<Browser> {
  return ((ctx.state["browser"] as Browser | undefined) ??= await launchBrowser());
}

const tabOf = (ctx: ScenarioContext, name: string): ConsoleTab => {
  const tab = ctx.state[`tab:${name}`] as ConsoleTab | undefined;
  ensure(tab !== undefined, `no console tab "${name}"`);
  return tab;
};

const GUEST = "GUEST" as const;
const START_SIM = "2026-10-07T10:10:00-03:00";

async function destroy(ctx: ScenarioContext, worldId: string): Promise<void> {
  await ctx.qa("policyAudit.run", { worldId }).catch(() => undefined);
  const step = ctx.repeatable("world.destroy", { worldId });
  await ctx.eventually(`${worldId} destroyed`, async () => ((await step()) as { state: string }).state === "DESTROYED", WAITS.worldSec, 2);
}

export default defineScenario({
  id: "SC-22",
  slug: "sc22",
  title: "Guest world and sessions: isolation, other session, HTTP reset, self-service refused, live world fenced, real guest path",
  suites: ["full"],
  lane: "guest",
  laneOrder: 0,
  steps: [
    {
      n: 1,
      title: "session A in sc22a → a world of the guest template, clock on Wed 07/10 10:10, its seeded history",
      flows: ["FL-100"],
      async run(ctx) {
        const a = await createWorld(ctx, { suffix: "a", template: "guest" });
        await createWorld(ctx, { suffix: "b", template: "guest" });
        const tab = await openConsole(ctx, await browserOf(ctx), a.worldId, "sc22-a", GUEST, "/app/clock");
        ctx.state["tab:a"] = tab;
        await tab.page.getByRole("heading", { name: copy.views.clock.title }).waitFor({ timeout: 60_000 });
        const clock = await consoleCall(ctx, "clock", "get", undefined, { worldId: a.worldId, role: GUEST });
        ctx.check(clock.mode === "PAUSED" && Date.parse(clock.simNow) === Date.parse(START_SIM), `the world starts at ${clock.simNow} ${clock.mode}`);
        const metrics = (await ctx.qa("metrics.get", { worldId: a.worldId })) as { seededHistory?: { total: number } };
        ctx.check(metrics.seededHistory?.total === guestTemplateComplaints(), "the seeded history is not the guest template's");
      },
    },
    {
      n: 2,
      title: "A moves its clock; a procedure with an id of demo → 403",
      flows: ["FL-099"],
      async run(ctx) {
        const tab = tabOf(ctx, "a");
        const moved = await inPage(tab, "clock.advance", { minutes: 60 }, "POST");
        ctx.check(moved.status === 200, `A's clock.advance answered ${moved.status}`);
        const own = await inPage(tab, "inbox.list", undefined, "GET");
        ctx.check(own.status === 200, "A cannot read its own inbox");
        const cross = await inPage(tab, "complaints.get", { worldId: "demo", complaintId: "cmp-l000001" }, "GET");
        ctx.check(cross.status === 403 && cross.body.includes("CROSS_WORLD"), `an id of demo answered ${cross.status}`);
      },
    },
    {
      n: 3,
      title: "A re-issued with sc22-a never sees the notice; another user (B) in the same world sees \"otra sesión usó este mundo\" without a reset button",
      flows: ["FL-099"],
      async run(ctx) {
        const a = tabOf(ctx, "a");
        await reissue(ctx, a, true);
        // An SPA navigation (no reload): the view's first call must read the injected token.
        await a.page.getByRole("link", { name: copy.views.inbox.title }).first().click();
        await expectFreshToken(ctx, a);
        await noInterruptions(ctx, a);
        const b = await openConsole(ctx, await browserOf(ctx), a.worldId, "sc22-b", "OPERATOR", "/app/inbox");
        ctx.state["tab:b"] = b;
        await b.page.getByText(STAFF_TEXT.OTHER_SESSION).first().waitFor({ timeout: 60_000 });
        ctx.check((await b.page.locator("#clock-reset").count()) === 0, "the notice offers a reset");
        ctx.warn("auth.session keys one user per role and world: B is the world's OPERATOR, not a second guest account");
      },
    },
    {
      n: 4,
      title: "A resets through CloudFront → Bff: 202 RESETTING in < 3 s, \"Reiniciando\", B refused WORLD_NOT_READY meanwhile, READY within budget, epoch + 1, A back without a new login",
      flows: ["FL-100"],
      async run(ctx) {
        const tab = tabOf(ctx, "a");
        const before = await ctx.snapshot(tab.worldId);
        await reissue(ctx, tab, true);
        await tab.page.goto(`${SITE}/app/clock`, { waitUntil: "domcontentloaded" });
        const reset = tab.page.locator("#clock-reset");
        await reset.getByRole("button", { name: RESET_ASK }).click();
        const answer = tab.page.waitForResponse((response) => response.url().includes("/api/clock.reset"), { timeout: 20_000 });
        const clicked = ctx.now();
        await reset.getByRole("button", { name: RESET_CONFIRM }).click();
        const response = await answer;
        ctx.measure("resetHttpMs", ctx.now() - clicked);
        ctx.check(response.status() === 202 && (await response.text()).includes("RESETTING"), `/api/clock.reset answered ${response.status()}`);
        ctx.check(ctx.now() - clicked < 3_000, `the reset took ${ctx.now() - clicked} ms through CloudFront (cap 3 s)`);
        await tab.page.getByRole("heading", { name: copy.shell.resettingTitle }).waitFor({ timeout: 30_000 });
        const during = await ctx.attempt("auth.session", { worldId: tab.worldId, sessionKey: "sc22-b", role: "OPERATOR" });
        ctx.check(!during.ok && `${during.error.reason ?? ""} ${during.error.message}`.includes("WORLD_NOT_READY"), "a sign-in during RESETTING was not refused WORLD_NOT_READY");
        const seen: string[] = [];
        const started = ctx.now();
        await ctx.eventually("RESETTING → READY", async () => {
          const status = (await consoleCall(ctx, "clock", "resetStatus", undefined, { worldId: tab.worldId, role: GUEST })).status;
          if (seen.at(-1) !== status) seen.push(status);
          return status === "READY";
        }, WAITS.worldSec, WAITS.worldEverySec);
        ctx.measure("worldResetMs", ctx.now() - started);
        ctx.check(seen.indexOf("READY") === seen.length - 1, `the reset went ${seen.join(" → ")}`);
        ctx.check((await ctx.snapshot(tab.worldId)).epoch === before.epoch + 1, "the epoch did not move by one");
        await tab.page.getByRole("heading", { name: copy.views.clock.title }).waitFor({ timeout: 60_000 });
        ctx.check((await signIn(ctx, tab.worldId, "sc22-b", "OPERATOR")).idToken !== "", "B's staff row did not survive the reset");
      },
    },
    {
      n: 5,
      title: "auth.session({probeCognito}): UpdateUserAttributes, ChangePassword and DeleteUser with the guest's access token → NotAuthorizedException; the next BFF call still in sc22a",
      flows: ["FL-094"],
      async run(ctx) {
        const { worldId } = worldOf(ctx, "a");
        const probed = (await ctx.qa("auth.session", { worldId, sessionKey: "sc22-a", role: GUEST, probeCognito: true })) as Tokens & { probe: Readonly<Record<string, string>> };
        for (const [call, error] of Object.entries(probed.probe)) ctx.check(error === "NotAuthorizedException", `${call} with the guest's token answered ${error}`);
        const page = await consoleQuery("clock.get", probed.idToken);
        ctx.check((trpcData(page) as { worldId?: string } | undefined)?.worldId === worldId, "the next call is not in the guest's world");
      },
    },
    {
      n: 6,
      title: "sc22a and sc22b with the same persona C01, both RUNNING, a message and a sentinel in each; resetting sc22a leaves sc22b's memory and schedules intact",
      flows: ["FL-099"],
      async run(ctx) {
        const [a, b] = [worldOf(ctx, "a").worldId, worldOf(ctx, "b").worldId];
        for (const worldId of [a, b]) {
          await consoleCall(ctx, "clock", "setRunning", { rate: 1 }, { worldId, role: GUEST });
          await ctx.qa("wa.inbound", { worldId, persona: "C01", content: { type: "text", text: "Escribime a la mañana, por favor" } });
        }
        const memoryOfB = async () => (await ctx.qa("memory.inspect", { worldId: b, customerId: "cus-0001", sentinel: "mañana" })) as { sentinelSeen: boolean | null; records: readonly { memoryRecordId: string }[] };
        const seenB = await ctx.eventually("sc22b's sentinel record", async () => {
          const memory = await memoryOfB();
          return memory.sentinelSeen === true ? memory : undefined;
        }, WAITS.memoryExtractionSec, 60);
        const timersB = (await ctx.snapshot(b)).timers.length;
        await resetAndWait(ctx, a, GUEST);
        const after = await memoryOfB();
        ctx.check(after.sentinelSeen === true && after.records.length >= seenB.records.length, "resetting sc22a touched sc22b's memory");
        ctx.check((await ctx.snapshot(b)).timers.length >= timersB, "resetting sc22a removed sc22b's schedules");
        for (const worldId of [a, b]) await consoleCall(ctx, "clock", "pause", undefined, { worldId, role: GUEST });
      },
    },
    {
      n: 7,
      title: "qa-live-<runId> with WhatsApp live (no live transport): a simulated envelope → SIM_IN_LIVE_WORLD; sc22b's simulator keeps working",
      flows: ["FL-104"],
      async run(ctx) {
        const create = ctx.repeatable("world.create", { runId: ctx.runId, scenario: "sc22-live", template: "models", personas: [{ key: "a", model: "C01" }], settings: { channelModes: { whatsapp: "live" } }, live: true });
        const live = `qa-live-${ctx.runId}`;
        ctx.state["liveWorld"] = live;
        await ctx.eventually(`${live} READY`, async () => ((await create()) as { state: string }).state === "READY", WAITS.worldSec, 2);
        const answer = (await ctx.qa("wa.inbound", { worldId: live, persona: "a", content: { type: "text", text: "Hola" } })) as { accepted: boolean; reason: string | null; outcomes: readonly string[] };
        ctx.check(!answer.accepted && JSON.stringify(answer).includes("SIM_IN_LIVE_WORLD"), `a simulated envelope to a live world answered ${answer.reason ?? answer.outcomes.join(", ")}`);
        ctx.blocked("LAMBDA_FENCE", "SIM_IN_LIVE_WORLD");
        const b = worldOf(ctx, "b").worldId;
        await consoleCall(ctx, "simulator", "sendText", { persona: "C02", text: "Hola, ¿siguen ahí?" }, { worldId: b, role: GUEST });
        const thread = await consoleCall(ctx, "simulator", "threads", { persona: "C02" }, { worldId: b, role: GUEST });
        ctx.check(thread.messages.length > 0, "sc22b's simulator stopped working");
      },
    },
    {
      n: 8,
      title: "the real guest path: a sign-in before the world is built → WORLD_NOT_READY; guest.invite → five SRP logins through the deployed trigger (p95 < 3 s) → a pristine console in sc22j",
      flows: ["FL-094", "FL-121"],
      async run(ctx) {
        const worldId = `qa-${ctx.runId}-sc22j`;
        ctx.state["invitedWorld"] = worldId;
        // First the account pre-registered in a world not built yet: its sign-in is refused WORLD_NOT_READY.
        const pre = (await ctx.qa("guest.invite", { worldId, registerOnly: true })) as { status: string };
        ctx.check(pre.status === "REGISTERED", `guest.invite({registerOnly}) left the world ${pre.status}, expected REGISTERED`);
        const early = await ctx.attempt("auth.session", { worldId, sessionKey: "guest", role: GUEST, flow: "SRP" });
        ctx.check(!early.ok && early.error.reason === "WORLD_NOT_READY", `a sign-in before the world was built answered ${early.ok ? "tokens" : `${early.error.code} ${early.error.reason ?? ""}`}, expected WORLD_NOT_READY`);
        const invite = ctx.repeatable("guest.invite", { worldId });
        await ctx.eventually(`${worldId} READY`, async () => ((await invite()) as { status: string }).status === "READY", WAITS.worldSec, WAITS.worldEverySec);
        const logins: number[] = [];
        let tokens: Tokens | undefined;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          tokens = await signIn(ctx, worldId, "guest", GUEST, "SRP");
          logins.push(tokens.loginMs);
        }
        const p95 = [...logins].sort((x, y) => x - y)[Math.ceil(logins.length * 0.95) - 1] ?? Infinity;
        ctx.measure("loginMsP95", p95);
        ctx.check(p95 < 3_000, `SRP login p95 ${p95} ms (cap 3 s)`);
        const tab = await openConsole(ctx, await browserOf(ctx), worldId, "guest", GUEST, "/app/tour", tokens);
        ctx.state["tab:j"] = tab;
        await tab.page.getByRole("heading", { name: copy.views.tour.title }).waitFor({ timeout: 60_000 });
        const tour = await consoleCall(ctx, "tour", "steps", undefined, { worldId, role: GUEST });
        ctx.check(tour.pristine.ok && !tour.pristine.mainStoryFiled && Date.parse(tour.simNow) === Date.parse(START_SIM), "the invited world is not pristine on Wed 07/10 10:10");
      },
    },
  ],
  async cleanup(ctx) {
    const browser = ctx.state["browser"] as Browser | undefined;
    await browser?.close();
    for (const key of ["liveWorld", "invitedWorld"]) {
      const worldId = ctx.state[key];
      if (typeof worldId === "string") await destroy(ctx, worldId);
    }
  },
});
