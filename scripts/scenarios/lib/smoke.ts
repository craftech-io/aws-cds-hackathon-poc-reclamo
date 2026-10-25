// The two longer steps of SC-00 (docs/test-plan.md §4.5, §5):
//
//   SMK/9   budget of a world of the `guest` template: `world.create` until READY (`WorldCreateDuration`,
//           hard cap 600 s), a `GUEST` session in it, `console.clock.reset` as GUEST with a recent sign-in
//           answers RESETTING at once, `console.clock.resetStatus` until READY (`WorldResetDuration`, hard
//           cap 600 s, never READY in between), epoch + 1, the template's seeded history back, and the
//           GUEST's tokens issued before the reset still accepted by the deployed verifier (its `STAFF#`
//           row survived). `world.destroy` runs in the cleanup.
//   SMK/10  sign-up surface behind the WAF and the edge (lib/edge.ts): `/signup` and `/login/recover` show
//           their forms in a browser that enforces the CSP (rules 5 and 6 of the edge ACL count,
//           EDGE_CHALLENGE_ENFORCED; a challenge they could not run would leave the page blank),
//           `signup.availability = open`
//           (ADR-0021 §1: `seed:load` opens `SWITCH#SIGNUP` and `KILL#SIGNUP` is absent); the Cognito web
//           ACL refuses the `ConsoleClient` and the `ServerClient` (`probe.cognitoClients`). That no account
//           without `@` has a verified email is checked by deploy.yml (`console:unverify-staff -- --check`
//           with the deploy role): the QaDriver never lists the pool, whose self-signup usernames are emails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { consoleCall } from "./console";
import { EDGE_CHALLENGE_ENFORCED } from "../../../infra/guest-limits";
import { SIGNUP_DOCUMENTS, WAF_ACTION_HEADER, consoleClientId, cspViolations, directForgotPassword, launchBrowser, openForm, publicAnswerOf, publicPostInPage, publicPostOutside, signupOpsBlocked } from "./edge";
import { WAITS } from "./eventually";
import { type Page, consoleQuery, fetchPage, trpcData } from "./site";
import { type ScenarioContext, ensure } from "./steps";
import { createWorld } from "./world";

/** A reset must be accepted at once (`docs/test-plan.md` §7: `clock.reset` < 3 s; < 1 s is the target). */
const RESET_ACCEPT_TARGET_MS = 1_000;
const RESET_ACCEPT_CAP_MS = 3_000;

const MANIFEST = fileURLToPath(new URL("../../seed/data/manifest.json", import.meta.url));

/** Complaints of the `guest` template in the seed manifest (the seeded history a reset restores). */
export function guestTemplateComplaints(path = MANIFEST): number {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { counts: { guest: { Complaint: number } } };
  return manifest.counts.guest.Complaint;
}

export async function guestWorldBudget(ctx: ScenarioContext): Promise<void> {
  const world = await createWorld(ctx, { suffix: "9", template: "guest" });
  ctx.check(world.createMs <= WAITS.worldSec * 1_000, `the guest world took ${world.createMs} ms (hard cap 600 s)`);
  const guest = { worldId: world.worldId, role: "GUEST" as const };
  const tokens = (await ctx.qa("auth.session", { worldId: world.worldId, sessionKey: "smk-guest", role: "GUEST" })) as { idToken: string };

  const asked = ctx.now();
  const reset = await consoleCall(ctx, "clock", "reset", undefined, { ...guest, signedInSecAgo: 0 });
  const acceptMs = ctx.now() - asked;
  ctx.measure("resetAcceptMs", acceptMs);
  ctx.check(reset.status === "RESETTING", `clock.reset answered ${reset.status}`);
  ctx.check(acceptMs <= RESET_ACCEPT_CAP_MS, `clock.reset took ${acceptMs} ms (cap 3 s)`);
  if (acceptMs > RESET_ACCEPT_TARGET_MS) ctx.warn(`clock.reset took ${acceptMs} ms round trip through the driver (target < 1 s)`);

  const seen = new Set<string>();
  const resetStarted = ctx.now();
  await ctx.eventually(
    `${world.worldId} RESETTING → READY`,
    async () => {
      const status = await consoleCall(ctx, "clock", "resetStatus", undefined, guest);
      seen.add(status.status);
      return status.status === "READY" ? status : undefined;
    },
    WAITS.worldSec,
    WAITS.worldEverySec,
  );
  const resetMs = ctx.now() - resetStarted;
  ctx.measure("worldResetMs", resetMs);
  ctx.check(seen.has("RESETTING") || resetMs < WAITS.worldEverySec * 1_000, "the world was never seen RESETTING");

  const after = await ctx.snapshot(world.worldId);
  ctx.check(after.epoch === world.epoch + 1, `epoch ${after.epoch} after the reset, expected ${world.epoch + 1}`);
  const metrics = (await ctx.qa("metrics.get", { worldId: world.worldId })) as { seededHistory?: { total: number; measuredN: number } };
  const expected = guestTemplateComplaints();
  ctx.check(metrics.seededHistory?.total === expected && metrics.seededHistory.measuredN === 0, `seeded history ${metrics.seededHistory?.total ?? "missing"} after the reset, expected the template's ${expected}`);
  const page = await consoleQuery("clock.get", tokens.idToken);
  const data = trpcData(page) as { worldId?: string } | undefined;
  ctx.check(page.status === 200 && data?.worldId === world.worldId, `the guest's session was not accepted after the reset (${page.status}): its STAFF# row did not survive`);
}

/**
 * The mandatory case of FL-119/FL-122: `ForgotPassword` (and `SignUp`, `ConfirmForgotPassword`) straight to
 * Cognito with the `ServerClient`, whose id the runner never sees, through the QA driver for the SUPERVISOR
 * of a QA world (the scenario's world `reuse` if it exists, or an empty one with `suffix`): the web ACL
 * refuses every call.
 */
export async function serverClientRefused(ctx: ScenarioContext, reuse: string, suffix: string): Promise<void> {
  const worldId = (ctx.state[`world:${reuse}`] as { worldId?: string } | undefined)?.worldId ?? (await createWorld(ctx, { suffix })).worldId;
  const probe = (await ctx.qa("probe.cognitoClients", { worldId })) as { refused: boolean; answers: Readonly<Record<string, Readonly<Record<string, string>>>> };
  const server = probe.answers["SERVER"] ?? {};
  ctx.check(server["forgotPassword"] === "ForbiddenException", `ForgotPassword with the ServerClient answered ${server["forgotPassword"] ?? "nothing"}, expected ForbiddenException`);
  ctx.check(probe.refused, `the Cognito web ACL let a call through: ${JSON.stringify(probe.answers)}`);
}

/** RFC 2606: a domain no mailbox can ever have; `signup.start` refuses it before creating anything. */
export function reservedSignup(runId: string) {
  return { email: `smoke-${runId}@example.com`, password: `Smoke-${runId}-Aa9!x`, acceptTerms: true, acceptContact: false, locale: "es" as const };
}

/**
 * Why `signup.availability` is not `open`, or undefined when it is. A 403 that is not JSON came from the
 * edge web ACL, not from the Bff: told apart so a block of the runner's own IP (a GitHub-hosted runner is
 * a hosting-provider address) is never read as a closed signup.
 */
export function availabilityProblem(page: Page): string | undefined {
  const edge = publicAnswerOf(page.status, page.headers["content-type"] ?? "", page.headers[WAF_ACTION_HEADER], page.body);
  if (edge.edgeRefused) return `the edge web ACL refused GET signup.availability from the runner (${page.status}${page.headers[WAF_ACTION_HEADER] ? ` ${page.headers[WAF_ACTION_HEADER]}` : ""}), not the Bff: read the sampled requests of rules 1 and 2`;
  const availability = trpcData(page) as { status?: string } | undefined;
  return availability?.status === "open" ? undefined : `signup.availability is ${availability?.status ?? "unanswered"}, expected open (ADR-0021 §1)`;
}

export async function signupSurface(ctx: ScenarioContext): Promise<void> {
  const problem = availabilityProblem(await fetchPage("/api/public/signup.availability", { headers: { accept: "application/json" } }));
  ctx.check(problem === undefined, problem ?? "");

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "es-AR" });
    const page = await context.newPage();
    // The signup document last, so the in-page POST below runs from it.
    for (const path of [...SIGNUP_DOCUMENTS].reverse()) {
      let form: Awaited<ReturnType<typeof openForm>> | undefined;
      const violations = await cspViolations(page, async () => {
        form = await openForm(page, path);
      });
      ctx.check(form?.shown === true, `GET ${path} (text/html) answered ${form?.status ?? "nothing"}${form?.wafAction ? ` ${form.wafAction}` : ""} and its form never showed under the CSP`);
      ctx.check(violations.length === 0, `CSP violations on ${path}: ${violations.join(" | ")}`);
    }

    const inside = await publicPostInPage(page, "signup.start", reservedSignup(ctx.runId));
    ctx.check(inside.result === "INVALID_EMAIL", `signup.start through the edge answered ${inside.status} ${inside.result ?? "(no status)"}, expected INVALID_EMAIL`);
    const outside = await publicPostOutside("signup.start", reservedSignup(ctx.runId));
    // Rule 6 counts (no token to require); with EDGE_CHALLENGE_ENFORCED it would stop the runner's POST.
    const outsideOk = EDGE_CHALLENGE_ENFORCED ? outside.edgeRefused : !outside.edgeRefused && outside.result === "INVALID_EMAIL";
    ctx.check(outsideOk, `signup.start from outside a browser answered ${outside.status} ${outside.result ?? ""}, expected ${EDGE_CHALLENGE_ENFORCED ? "the edge's refusal" : "the Bff's INVALID_EMAIL"}`);

    const edge = (await ctx.qa("probe.edge", {})) as { status: number; reason: string | null; refused: boolean };
    ctx.check(edge.refused, `the Bff's Function URL without the edge header answered ${edge.status} ${edge.reason ?? ""}, expected 403 EDGE_REQUIRED`);

    const clientId = await consoleClientId(page, `qa-${ctx.runId}-smk-nobody`);
    ensure(clientId !== undefined, "the console never called Cognito: its client id is unknown");
    const since = ctx.now();
    const forgot = await directForgotPassword(clientId, `qa-${ctx.runId}-smk-nobody`);
    ctx.check(forgot === "ForbiddenException", `ForgotPassword with the console's client answered ${forgot}, expected ForbiddenException from the Cognito web ACL`);
    await serverClientRefused(ctx, "9", "10");
    try {
      const blocked = await ctx.eventually("rule 1 of the Cognito web ACL counted the block", async () => (await signupOpsBlocked(since)) > 0, 300, 30);
      ctx.check(blocked, "rule 1 did not count the block");
    } catch (error) {
      ctx.warn(`the metric of rule 1 of the Cognito web ACL could not be read: ${error instanceof Error ? error.name : "error"}`);
    }
    await context.close();
  } finally {
    await browser.close();
  }
}
