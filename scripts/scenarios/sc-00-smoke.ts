// SC-00 · smoke of every deploy (docs/test-plan.md §4.5 and §5; SMK/1-10). deploy.yml runs it after
// `sst deploy` and `seed:load` with the qa-runner role (`npm run scenarios -- --suite smoke`), in place of
// the interim smoke. A clone of C04 (pays at the Red de cobro Sur, batch already published) on Wed
// 07/10 10:10, three warm-up messages from a clone of C08, the real Scheduler, the SES mailbox simulator,
// the malware plan of `Media`, the budget of a `guest` world and the sign-up surface behind the WAF.
// The DKIM of a first deploy may still be PENDING: a mail that SES took but whose event never came back
// is a WARN of step 6; any other failure fails the run.
import { WAITS, WaitTimeout } from "./lib/eventually";
import { fileByScript, mailsOf, personaIn, say } from "./lib/flows";
import { guestWorldBudget, signupSurface } from "./lib/smoke";
import { consoleQuery, fetchPage, healthOf, pageProblems, trpcData } from "./lib/site";
import { complaintOwner, timersOf } from "./lib/snapshot";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { createWorld, schedulerProbe, worldOf } from "./lib/world";

const PUBLIC_PAGES = ["/", "/legal/privacy.html", "/legal/terms.html"] as const;

function complaintOfSmoke(ctx: ScenarioContext): { readonly complaintId: string; readonly complaintNumber: string } {
  const complaint = ctx.state["complaint"] as { complaintId: string; complaintNumber: string } | undefined;
  ensure(complaint !== undefined, "step 4 filed no complaint");
  return complaint;
}

export default defineScenario({
  id: "SC-00",
  slug: "smk",
  title: "Smoke of the deployed stage",
  suites: ["smoke", "full"],
  steps: [
    {
      n: 0,
      title: "a QA world from the models: a clone of C04 and a clone of C08",
      flows: [],
      async run(ctx) {
        await createWorld(ctx, { personas: [{ key: "a", model: "C04" }, { key: "w", model: "C08" }] });
      },
    },
    {
      n: 1,
      title: "landing and legal pages answer 200 with the security headers (retried for 30 s)",
      flows: ["FL-102"],
      async run(ctx) {
        for (const path of PUBLIC_PAGES) {
          const page = await fetchPage(path);
          const problems = pageProblems(path, page);
          ctx.check(problems.length === 0, problems.join("; "));
          ctx.check((page.headers["content-type"] ?? "").includes("text/html"), `GET ${path} is not HTML`);
        }
      },
    },
    {
      n: 2,
      title: "auth.session(OPERATOR): a real login, and a real call to the BFF accepted by the deployed verifier",
      flows: ["FL-094"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const tokens = (await ctx.qa("auth.session", { worldId, sessionKey: "smk-operator", role: "OPERATOR" })) as { idToken: string; accessToken: string; exp: number; authTime: number; loginMs: number; refreshToken?: unknown };
        ctx.measure("loginMs", tokens.loginMs);
        ctx.check(tokens.refreshToken === undefined, "auth.session must never return a refresh token");
        const lifetime = tokens.exp - Math.floor(ctx.now() / 1_000);
        ctx.check(lifetime > 0 && lifetime <= 15 * 60 + 60, `the tokens live ${lifetime} s, expected at most 15 minutes`);
        const page = await consoleQuery("clock.get", tokens.idToken);
        const data = trpcData(page) as { worldId?: string } | undefined;
        ctx.check(page.status === 200 && data?.worldId === worldId, `GET /api/clock.get with the session answered ${page.status} for ${data?.worldId ?? "no world"}`);
      },
    },
    {
      n: 3,
      title: "/api/health (shallow) and probe.mocks: each mock with each invoking role",
      flows: [],
      async run(ctx) {
        ctx.check(healthOf(await fetchPage("/api/health")) === "ok", "GET /api/health is not ok");
        const world = worldOf(ctx);
        const customerId = world.customers["a"] ?? "";
        // One key for every poll: the probe id of the HEALTH_PROBE derives from it, so the first poll
        // enqueues it and the next ones read its answer.
        const mocks = ctx.repeatable("probe.mocks", { worldId: world.worldId, customerId });
        const probe = await ctx.eventually(
          "probe.mocks through the QA queue",
          async () => {
            const answer = (await mocks()) as { direct: { core: string; networks: string }; worker: { state: string } };
            return answer.worker.state === "DONE" ? answer : undefined;
          },
          120,
          5,
        );
        ctx.check(probe.direct.core === "ok" && probe.direct.networks === "ok", `the mocks answered core=${probe.direct.core} networks=${probe.direct.networks}`);
      },
    },
    {
      n: 4,
      title: "three warm-up messages, then a complaint: COMPLAINT_ACK with its number and three milestones within 10 s",
      flows: ["FL-010"],
      async run(ctx) {
        const world = worldOf(ctx);
        const warm = personaIn(ctx, world, "w");
        for (const text of ["Hola", "Buen día", "¿Me pueden ayudar?"]) await say(ctx, warm, { type: "text", text });
        const filed = await fileByScript(ctx, personaIn(ctx, world, "a"));
        ctx.state["complaint"] = { complaintId: filed.complaint.complaintId, complaintNumber: filed.complaint.complaintNumber };
        const milestones = timersOf(filed.snapshot, "SLA", complaintOwner(filed.complaint.complaintId));
        ctx.check(milestones.length === 3, `${filed.complaint.complaintNumber} has ${milestones.length} SCHEDULED milestones, expected 3`);
      },
    },
    {
      n: 5,
      title: "the real Scheduler fires OPERATOR_REMINDER 120 s after clock.unfreeze, then the clock freezes again",
      flows: ["FL-082"],
      async run(ctx) {
        await schedulerProbe(ctx, worldOf(ctx).worldId, complaintOfSmoke(ctx).complaintId, "OPERATOR_REMINDER");
      },
    },
    {
      n: 6,
      title: "the customer accepts the email: ACK_EMAIL to success+… gets DELIVERED from the SES mailbox simulator",
      flows: ["FL-090"],
      async run(ctx) {
        const world = worldOf(ctx);
        const persona = personaIn(ctx, world, "a");
        await say(ctx, persona, { type: "button", action: "ACCEPT_EMAIL" });
        const snapshot = await ctx.eventually(
          "ACK_EMAIL written",
          async () => {
            const fresh = await ctx.snapshot(world.worldId, persona.customerId);
            return mailsOf(fresh, "ACK_EMAIL", persona.customerId).length > 0 ? fresh : undefined;
          },
          60,
          3,
        );
        const mail = mailsOf(snapshot, "ACK_EMAIL", persona.customerId)[0];
        ensure(mail !== undefined, "no ACK_EMAIL");
        ctx.note("mailId", mail.mailId);
        let last = "PENDING";
        try {
          await ctx.eventually(
            `mail ${mail.mailId} DELIVERED`,
            async () => {
              last = ((await ctx.qa("mail.outcome", { worldId: world.worldId, mailId: mail.mailId })) as { status: string }).status;
              return ["DELIVERED", "BOUNCED", "COMPLAINED", "NOT_FOUND"].includes(last) ? last : undefined;
            },
            WAITS.sesEventSec,
            5,
          );
        } catch (error) {
          // SES took the mail and no event came back: the DKIM of a first deploy may still be PENDING.
          if (!(error instanceof WaitTimeout) || last !== "SENT") throw error;
          ctx.warn(`no SES event for ${mail.mailId} within ${WAITS.sesEventSec} s after SENT: DKIM may be PENDING on a first deploy`);
          return;
        }
        ctx.check(last === "DELIVERED", `ACK_EMAIL ended ${last}, expected DELIVERED`);
      },
    },
    {
      n: 7,
      title: "policy audit of the world: 0 violations",
      flows: ["FL-075"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        await ctx.settled(worldId);
        const audit = (await ctx.qa("policyAudit.run", { worldId })) as { violations: readonly unknown[] };
        ctx.check(audit.violations.length === 0, `${audit.violations.length} policy violation(s)`);
      },
    },
    {
      n: 8,
      title: "the malware protection plan of Media reaches ACTIVE (600 s, every 30 s)",
      flows: ["FL-029"],
      async run(ctx) {
        const world = worldOf(ctx);
        let nudged = false;
        let reasons: readonly string[] = [];
        try {
          await ctx.eventually(
            "malware plan ACTIVE",
            async () => {
              const plan = (await ctx.qa("probe.malwarePlan", {})) as { status: string; statusReasons: readonly string[] };
              reasons = plan.statusReasons;
              if (plan.status === "ACTIVE") return plan;
              if (plan.status === "WARNING" && !nudged) {
                // A new plan may wait for its first object: one seed receipt copied under qa/ clears it.
                nudged = true;
                await say(ctx, personaIn(ctx, world, "a"), { type: "receipt", variant: "legible", personaModel: "C04", seq: 1 });
              }
              return undefined;
            },
            WAITS.malwarePlanSec,
            WAITS.malwarePlanEverySec,
          );
        } catch (error) {
          if (error instanceof WaitTimeout) throw new WaitTimeout(`malware plan ACTIVE (statusReasons: ${reasons.join(", ") || "none"})`, error.timeoutSec, error.last);
          throw error;
        }
      },
    },
    {
      n: 9,
      title: "budget of a guest world: created READY, reset RESETTING → READY, epoch + 1, template and staff intact",
      flows: ["FL-100"],
      run: guestWorldBudget,
    },
    {
      n: 10,
      title: "sign-up surface: /signup and /login/recover show their forms under the CSP, signup.start through the edge, Cognito refusals",
      flows: ["FL-112", "FL-119", "FL-122"],
      run: signupSurface,
    },
  ],
});
