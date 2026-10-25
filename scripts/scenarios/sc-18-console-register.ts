// SC-18 · the console and the register (docs/test-plan.md §4.5). A QA world with a clone of C02 that files
// one complaint, and `qamin`. The role matrix (routers/roles.ts) holds procedure by procedure, by the
// in-process principal and by a real sign-in; COMPLIANCE never reaches a mutation; the register verifies
// against its anchors and exports a file anyone can verify; IAM blocks updates and deletes of every
// append-only table for every role of the app, an overwrite is detected and a forged anchor conflicts;
// a world never reads another; a reset keeps the staff and the old epoch's chains; and the four indirect
// paths of the QA driver into a guest world are refused (`gprobe`).
import { IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { ACCESS } from "@reclamo/bff/routers/roles";
import type { StaffRole } from "@reclamo/shared";
import { agentRoleName } from "../../infra/agentcore-spec";
import { LAMBDA_CAPABILITIES, type LambdaName } from "../../infra/iam-capabilities";
import { fixedRoleArn } from "../../infra/workers-spec";
import { checkManifest, verifyExport } from "../register/verify";
import { consoleAttempt, consoleCall } from "./lib/console";
import { REGION } from "./lib/driver-client";
import { WAITS } from "./lib/eventually";
import { fileByScript, keepComplaint, complaintIdOf, personaIn } from "./lib/flows";
import { consoleQuery, trpcData } from "./lib/site";
import { type ScenarioContext, defineScenario, ensure, notWired } from "./lib/steps";
import { createWorld, worldOf } from "./lib/world";

const APP = "aws-cds-hackathon-poc-reclamo";
const STAGE = "poc";
const ROLES: readonly StaffRole[] = ["OPERATOR", "SUPERVISOR", "COMPLIANCE", "GUEST"];
/** Queries that take no input: called with every role and compared with the matrix row. */
const BARE_QUERIES = ["inbox.list", "approvals.list", "tape.list", "register.list", "register.verify", "emails.list", "simulator.personas", "clock.get", "clock.resetStatus", "policy.rules"] as const;
const APPEND_ONLY_ACTIONS = ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"];
/** Thu 22/10 seen from Wed 07/10 (Mon 12/10 a holiday): 10 business days left. */
const DAYS_LEFT_AT_FILING = 10;

type Rule = { readonly type: "query" | "mutation"; readonly roles: readonly StaffRole[] };
const access = ACCESS as unknown as Readonly<Record<string, Rule>>;

interface TamperOutcome {
  readonly updateDenied: boolean;
  readonly deleteDenied: boolean;
  readonly overwriteDetected: boolean;
  readonly anchorConflict: boolean;
  readonly foreignAnchorDenied: boolean;
  readonly crossWorldDenied: boolean;
  /** ARNs of Register, ComplianceTape and AuditLog, when the driver exposes them (SC-18/8). */
  readonly tables?: readonly string[];
}

async function roleRow(ctx: ScenarioContext, worldId: string, procedure: string, role: StaffRole) {
  return ctx.attempt("console", { worldId, procedure, role });
}

/** `iam:SimulatePrincipalPolicy` of a role on the append-only writes: the decisions, or `undefined` when the role does not exist by that name. */
async function simulate(iam: IAMClient, roleArn: string, tables: readonly string[]): Promise<string[] | undefined> {
  try {
    const answer = await iam.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: roleArn, ActionNames: APPEND_ONLY_ACTIONS, ResourceArns: [...tables] }));
    return (answer.EvaluationResults ?? []).map((result) => result.EvalDecision ?? "unknown");
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchEntityException") return undefined;
    throw error;
  }
}

/** Every role of the app under `/<app>/`: the Lambdas (fixed names) and the three AgentCore roles. */
function appRoleArns(account: string): string[] {
  const lambdas = (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).map((fn) => fixedRoleArn({ account, app: APP, stage: STAGE }, fn));
  const agents = (["harness", "gateway", "memory"] as const).map((purpose) => `arn:aws:iam::${account}:role/${APP}/${agentRoleName(APP, STAGE, purpose)}`);
  return [...lambdas, ...agents];
}

export default defineScenario({
  id: "SC-18",
  slug: "sc18",
  title: "Console and register: roles, read-only compliance, verifiable export, tamper evidence, isolation, reset",
  suites: ["full"],
  steps: [
    {
      n: 0,
      title: "world.create: a clone of C02 that files one complaint",
      flows: [],
      async run(ctx) {
        const world = await createWorld(ctx, { personas: [{ key: "a", model: "C02" }] });
        keepComplaint(ctx, "a", await fileByScript(ctx, personaIn(ctx, world, "a"), 0, "UNRECOGNIZED_CHARGE"));
        await ctx.settled(world.worldId);
      },
    },
    {
      n: 1,
      title: "roles by the in-process principal and by auth.session: every query of the matrix answers or refuses as its row says",
      flows: ["FL-094"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const wrong: string[] = [];
        for (const procedure of BARE_QUERIES) {
          for (const role of ROLES) {
            const answer = await roleRow(ctx, worldId, procedure, role);
            const allowed = access[procedure]?.roles.includes(role) === true;
            const refusedByRole = !answer.ok && answer.error.code === "FORBIDDEN";
            if (allowed === refusedByRole) wrong.push(`${procedure} as ${role}: ${answer.ok ? "OK" : answer.error.code}`);
          }
        }
        ctx.check(wrong.length === 0, `the matrix does not hold: ${wrong.slice(0, 5).join("; ")}`);
        const tokens = (await ctx.qa("auth.session", { worldId, sessionKey: "sc18-op", role: "OPERATOR" })) as { idToken: string; exp: number };
        const page = await consoleQuery("clock.get", tokens.idToken);
        const data = trpcData(page) as { worldId?: string } | undefined;
        ctx.check(page.status === 200 && data?.worldId === worldId, `a real OPERATOR session was answered ${page.status} for ${data?.worldId ?? "no world"}`);
        ctx.check(tokens.exp * 1_000 - ctx.now() <= 15 * 60_000 + 5_000, "the session's tokens live longer than 15 minutes");
      },
    },
    {
      n: 2,
      title: "COMPLIANCE: every mutation of the matrix → 403",
      flows: ["FL-095"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const reached: string[] = [];
        for (const [procedure, rule] of Object.entries(access)) {
          if (rule.type !== "mutation") continue;
          const answer = await roleRow(ctx, worldId, procedure, "COMPLIANCE");
          if (answer.ok || answer.error.code !== "FORBIDDEN") reached.push(`${procedure}: ${answer.ok ? "OK" : answer.error.code}`);
        }
        ctx.check(reached.length === 0, `COMPLIANCE reached ${reached.length} mutation(s): ${reached.slice(0, 5).join("; ")}`);
      },
    },
    {
      n: 3,
      title: "register.verify → ok with anchors; register.export → a file with guarded cells and result ok that scripts/register/verify.ts verifies",
      flows: ["FL-014", "FL-096"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const compliance = { worldId, role: "COMPLIANCE" as const };
        const verified = await consoleCall(ctx, "register", "verify", undefined, compliance);
        ctx.check(verified.result === "ok" && verified.unanchored.length === 0, `register.verify: ${verified.result}, ${verified.unanchored.length} unanchored`);
        const exported = await consoleCall(ctx, "register", "export", undefined, compliance);
        ctx.check(exported.result === "ok", `the export declares ${exported.result}`);
        const [csv, manifest] = await Promise.all([fetch(exported.files.csv.url, { signal: AbortSignal.timeout(30_000) }).then((answer) => answer.text()), fetch(exported.files.sha256.url, { signal: AbortSignal.timeout(30_000) }).then((answer) => answer.text())]);
        const report = verifyExport(csv);
        ctx.check(report.recomputed === "ok" && report.consistent, `the exported file verifies ${report.recomputed} (consistent: ${report.consistent})`);
        const name = exported.files.csv.key.slice(exported.files.csv.key.lastIndexOf("/") + 1);
        ctx.check(checkManifest(manifest, name, csv) === true, "the .sha256 manifest does not match the CSV");
        ctx.check(!/(^|,)[=+@]/m.test(csv), "the CSV has a cell that a spreadsheet would run as a formula");
      },
    },
    {
      n: 4,
      title: "register.tamperProbe: update and delete denied; an overwrite detected at its seq; a re-chained entry with a forged anchor → ANCHOR_CONFLICT; an anchor outside qa-* denied",
      flows: ["FL-014"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const listed = await consoleCall(ctx, "register", "list", { limit: 500 }, { worldId, role: "COMPLIANCE" });
        const seqs = listed.entries.map((entry) => entry.seq).sort((a, b) => a - b);
        const [first, last] = [seqs[0], seqs.at(-1)];
        ensure(first !== undefined && last !== undefined && first !== last, `the register has ${seqs.length} entr(ies); two are needed`);
        const outcome = (await ctx.qa("register.tamperProbe", { worldId, overwriteSeq: first, rechainSeq: last })) as TamperOutcome;
        ctx.state["tamper"] = outcome;
        for (const [name, held] of Object.entries({ updateDenied: outcome.updateDenied, deleteDenied: outcome.deleteDenied, overwriteDetected: outcome.overwriteDetected, anchorConflict: outcome.anchorConflict, foreignAnchorDenied: outcome.foreignAnchorDenied })) ctx.check(held, `tamper probe: ${name} does not hold`);
        ctx.warn("the ChainBroken metric of the conflict is read post-deploy, not by the runner");
      },
    },
    {
      n: 5,
      title: "inbox.list → business days left by services/business-days",
      flows: ["FL-097"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const inbox = await consoleCall(ctx, "inbox", "list", { includeClosed: true }, { worldId });
        const row = inbox.items.find((item) => item.complaintId === complaintIdOf(ctx, "a"));
        ensure(row !== undefined, "the complaint is not in the inbox");
        ctx.check(row.businessDaysLeft === DAYS_LEFT_AT_FILING, `${row.businessDaysLeft} business days left on Wed 07/10, expected ${DAYS_LEFT_AT_FILING}`);
      },
    },
    {
      n: 6,
      title: "an id of another world → 403 CROSS_WORLD",
      flows: ["FL-099"],
      async run(ctx) {
        const { worldId } = worldOf(ctx);
        const answer = await consoleAttempt(ctx, "complaints", "get", { worldId: "demo", complaintId: complaintIdOf(ctx, "a") }, { worldId });
        ctx.check(!answer.ok && answer.error.code === "FORBIDDEN" && answer.error.reason === "CROSS_WORLD", `another world's id answered ${answer.ok ? "OK" : `${answer.error.code} ${answer.error.reason ?? ""}`}`);
      },
    },
    {
      n: 7,
      title: "console.clock.reset of qamin → RESETTING at once → READY within 600 s; epoch + 1, template restored",
      flows: ["FL-100"],
      async run(ctx) {
        const before = await ctx.snapshot("qamin");
        const asked = ctx.now();
        const reset = await consoleCall(ctx, "clock", "reset", undefined, { worldId: "qamin", signedInSecAgo: 0 });
        ctx.measure("resetAcceptMs", ctx.now() - asked);
        ctx.check(reset.status === "RESETTING", `clock.reset answered ${reset.status}`);
        await ctx.eventually("qamin READY", async () => (await consoleCall(ctx, "clock", "resetStatus", undefined, { worldId: "qamin" })).status === "READY", WAITS.worldSec, WAITS.worldEverySec);
        const after = await ctx.snapshot("qamin");
        ctx.check(after.epoch === before.epoch + 1, `qamin's epoch ${after.epoch}, expected ${before.epoch + 1}`);
        const metrics = (await ctx.qa("metrics.get", { worldId: "qamin" })) as { seededHistory?: { total: number; measuredN: number } };
        ctx.check(metrics.seededHistory?.measuredN === 0, "qamin's measured KPIs are not back to N = 0");
        ctx.warn("the old epoch's register and audit log are append-only by IAM (step 8); the runner reads only the current epoch");
      },
    },
    {
      n: 8,
      title: "iam:SimulatePrincipalPolicy of every role of the app on UpdateItem, DeleteItem and BatchWriteItem of the append-only tables → denied",
      flows: ["FL-014"],
      async run(ctx) {
        const tables = (ctx.state["tamper"] as TamperOutcome | undefined)?.tables ?? [];
        if (tables.length < 3) notWired("register.tamperProbe", "the ARNs of Register, ComplianceTape and AuditLog (SST-generated names) are not in the probe's answer");
        const account = /^arn:aws:dynamodb:[a-z0-9-]+:(\d{12}):/.exec(tables[0] ?? "")?.[1];
        ensure(account !== undefined, "the table ARNs carry no account");
        const iam = new IAMClient({ region: REGION, maxAttempts: 3 });
        const allowed: string[] = [];
        let simulated = 0;
        for (const roleArn of appRoleArns(account)) {
          const decisions = await simulate(iam, roleArn, tables);
          if (decisions === undefined) continue;
          simulated += 1;
          if (decisions.some((decision) => decision === "allowed")) allowed.push(roleArn.slice(roleArn.lastIndexOf("/") + 1));
        }
        ctx.measure("rolesSimulated", simulated);
        ctx.check(simulated > 0, "no role of the app could be simulated");
        ctx.check(allowed.length === 0, `roles allowed to rewrite an append-only table: ${allowed.join(", ")}`);
      },
    },
    {
      n: 9,
      title: "register.tamperProbe on W#demo#… (conditional put) → AccessDenied",
      flows: [],
      async run(ctx) {
        const outcome = ctx.state["tamper"] as TamperOutcome | undefined;
        ensure(outcome !== undefined, "step 4 ran no tamper probe");
        ctx.check(outcome.crossWorldDenied, "the QA driver's role could write into demo's register");
      },
    },
    {
      n: 10,
      title: "fence.probe(WORLD_PATHS) against gprobe: every indirect path refused, gprobe's hash unchanged",
      flows: ["FL-081", "FL-099"],
      async run(ctx) {
        const probe = (await ctx.qa("fence.probe", { kind: "WORLD_PATHS", worldId: "gprobe" })) as { refused: boolean; hashBefore: string; hashAfter: string; paths: ReadonlyArray<{ path: string; refused: boolean; answer: string }> };
        for (const path of probe.paths) {
          ctx.check(path.refused, `${path.path} was not refused (${path.answer})`);
          ctx.blocked("LAMBDA_FENCE", `${path.path}: ${path.answer}`);
        }
        ctx.check(probe.refused && probe.hashBefore === probe.hashAfter, "gprobe changed or a path went through");
      },
    },
  ],
});
