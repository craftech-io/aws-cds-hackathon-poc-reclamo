import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEAD_NOTICE_PROBE_RECIPIENT as INFRA_PROBE_RECIPIENT, leadNoticeProbeStatement, leadNoticeStatement } from "./messaging-email-spec";
import { LEAD_NOTICE_PROBE_RECIPIENT } from "../packages/bff/src/leads/notice";
import {
  APPEND_ONLY_TABLES,
  CAPABILITIES,
  LAMBDA_CAPABILITIES,
  LEADS_GRANTS,
  MOCK_CONDITIONS,
  QA_DRIVER_DLQ_ONLY_ACTIONS,
  WORLD_LEADING_KEYS,
  actionDrift,
  expectedActions,
  expectedBuckets,
  expectedTables,
  leadingKeysAllow,
  leadsAllow,
  resolveCapabilities,
  stringLike,
  type LambdaCapabilities,
  type LambdaName,
  type LeadsRole,
  type WorldFencedRole,
} from "./iam-capabilities";

const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");
const TOOL_TARGETS = ["ToolIdentity", "ToolAccount", "ToolInvestigation", "ToolActions", "ToolComplaints", "ToolMessaging", "ToolHandoff"];
const NOT_LAMBDAS = new Set(["GuardDutyMalwarePlan"]);
const TRIGGERS: Record<string, LambdaName> = { "Trigger pre-token V2": "PreTokenTrigger", "Trigger pre-sign-up": "PreSignUpTrigger" };

/** Lambdas named in the first cell of the per-role table of docs/architecture.md §14. */
function documentedLambdas(): string[] {
  const section = architecture.slice(architecture.indexOf("## 14."), architecture.indexOf("## 15."));
  const names = new Set<string>();
  for (const line of section.split("\n")) {
    const cell = /^\| ([^|]+) \|/.exec(line)?.[1]?.trim() ?? "";
    const trigger = TRIGGERS[cell];
    if (trigger) names.add(trigger);
    // The row of the self-signup's triggers names them in words and `LeadNotifier` in backticks.
    if (cell.startsWith("Trigger post-confirmation")) for (const name of ["PostConfirmationTrigger", "CustomMessageTrigger"] as const) names.add(name);
    if (cell.includes("`ToolIdentity` …")) for (const tool of TOOL_TARGETS) names.add(tool);
    else for (const [, name] of cell.matchAll(/`([A-Z][A-Za-z]+)`/g)) if (name && !/^[A-Z_]+$/.test(name) && !NOT_LAMBDAS.has(name)) names.add(name);
  }
  return [...names];
}

const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];
const entry = (fn: LambdaName): LambdaCapabilities => LAMBDA_CAPABILITIES[fn];

describe("capabilities table", () => {
  it("has one entry per Lambda of docs/architecture.md §14 and nothing else", () => {
    const documented = documentedLambdas();
    expect(documented.length).toBeGreaterThan(20);
    expect([...LAMBDAS].sort()).toEqual([...documented].sort());
  });

  it("builds PIPELINE from both senders, the output guardrail, the timers, the tape and the anchors", () => {
    expect(resolveCapabilities(["PIPELINE"])).toEqual(["ANCHOR", "PIPELINE", "SEND_EMAIL", "SEND_WHATSAPP", "TIMERS"]);
    expect(CAPABILITIES.PIPELINE.actions).toContain("bedrock:ApplyGuardrail");
    expect(CAPABILITIES.PIPELINE.tables?.ComplianceTape).toBe("append");
  });

  it("gives WORLDS the world tables, the anchors, the timers and the memory purge", () => {
    expect(resolveCapabilities(["WORLDS"])).toEqual(["ANCHOR", "MEMORY_ADMIN", "TIMERS", "WORLDS"]);
    expect(Object.keys(expectedTables("WorldJanitor")).sort()).toEqual(
      ["AuditLog", "ComplianceTape", "Complaints", "Conversations", "Core", "Metrics", "Networks", "Register", "Runtime", "Timers", "Worlds"].sort(),
    );
  });

  it("fences SEND_EMAIL to the answers sender and to the SES mailbox simulator and @craftech.io", () => {
    const fence = CAPABILITIES.SEND_EMAIL.fence;
    for (const part of ["respuestas@reclamo.demo.craftech.io", "*@simulator.amazonses.com", "*@craftech.io", "IfExists", "…-email-poc"]) expect(fence).toContain(part);
  });
});

describe("append-only tables (ADR-0014) [FL-014]", () => {
  it("never lets a role update, delete or batch-write Register, ComplianceTape or AuditLog", () => {
    for (const fn of LAMBDAS) {
      const tables = expectedTables(fn);
      for (const table of APPEND_ONLY_TABLES) expect([undefined, "read", "append"], `${fn} ${table}`).toContain(tables[table]);
    }
  });

  it("keeps the pre-token trigger read-only except for its AuditLog", () => {
    expect(expectedTables("PreTokenTrigger")).toEqual({ Worlds: "read", AuditLog: "append" });
    expect(expectedActions("PreTokenTrigger")).toEqual([]);
    expect(expectedBuckets("PreTokenTrigger")).toEqual({});
  });

  it("writes the anchors only from AnchorWriter, and from the QaDriver only in qa-* streams", () => {
    const writers = LAMBDAS.filter((fn) => entry(fn).anchors?.startsWith("write"));
    expect(writers.sort()).toEqual(["AnchorWriter", "QaDriver"]);
    expect(entry("QaDriver").anchors).toBe("write-qa-streams");
    expect(entry("QaDriver").fence).toContain("anchors only log-stream:qa-*");
    for (const fn of LAMBDAS) for (const action of expectedActions(fn)) expect(action, fn).not.toMatch(/^logs:(PutLogEvents|CreateLogStream)$/);
  });
});

describe("world fences per role", () => {
  const ROLES = Object.keys(WORLD_LEADING_KEYS) as WorldFencedRole[];

  it("fences every role that holds WORLDS by leading keys", () => {
    const holders = LAMBDAS.filter((fn) => resolveCapabilities(entry(fn).capabilities).includes("WORLDS"));
    for (const fn of holders) expect(ROLES, fn).toContain(fn);
  });

  it("matches like IAM StringLike", () => {
    expect(stringLike("W#g??#*", "W#g07#COMPLAINT#1")).toBe(true);
    expect(stringLike("W#g??#*", "W#gtest#COMPLAINT#1")).toBe(false);
    expect(stringLike("W#qa-*", "W#qa-run1-sc01#X")).toBe(true);
  });

  it("lets each role write its worlds and not another one, and denies a Scan without keys", () => {
    const cases: Array<[WorldFencedRole, string, string]> = [
      ["Bff", "W#g03#COMPLAINT#cmp-1", "W#sim-001#COMPLAINT#cmp-1"],
      ["WorldJanitor", "W#gprobe#WORLD", "W#sim-001#WORLD"],
      ["QaDriver", "W#qa-r1-sc01#COMPLAINT#cmp-1", "W#g03#COMPLAINT#cmp-1"],
      ["BudgetBreaker", "KILL#AGENT", "W#demo#COMPLAINT#cmp-1"],
      ["PreTokenTrigger", "W#g03#AUD#2026-10", "W#g03#WORLD"],
    ];
    for (const [role, own, foreign] of cases) {
      expect(leadingKeysAllow(role, [own], "write"), `${role} ${own}`).toBe(true);
      expect(leadingKeysAllow(role, [foreign], "write"), `${role} ${foreign}`).toBe(false);
      expect(leadingKeysAllow(role, [own, foreign], "write"), `${role} mixed`).toBe(false);
      expect(leadingKeysAllow(role, [], "read"), `${role} scan`).toBe(false);
    }
  });

  it("keeps the QaDriver away from demo and guest worlds, reading only gprobe", () => {
    for (const world of ["demo", "g01", "g15", "gtest"]) {
      expect(leadingKeysAllow("QaDriver", [`W#${world}#COMPLAINT#cmp-1`], "read"), world).toBe(false);
    }
    expect(leadingKeysAllow("QaDriver", ["W#gprobe#WORLD"], "read")).toBe(true);
    expect(leadingKeysAllow("QaDriver", ["W#gprobe#WORLD"], "write")).toBe(false);
  });
});

describe("mocks and invocations", () => {
  it("grants both Function URL actions, and lambda:InvokeFunction only via the Function URL", () => {
    for (const mock of ["MOCK_CORE", "MOCK_NETWORK"] as const) {
      expect([...CAPABILITIES[mock].actions].sort()).toEqual(["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"]);
      expect(CAPABILITIES[mock].conditions).toEqual(MOCK_CONDITIONS);
    }
    expect(MOCK_CONDITIONS["lambda:InvokeFunction"]).toEqual({ "lambda:InvokedViaFunctionUrl": "true" });
  });

  it("never invokes a mock directly, and the QaDriver never invokes EmailEvents", () => {
    for (const fn of LAMBDAS) for (const target of entry(fn).invokes ?? []) expect(["CoreMock", "NetworkMock"], fn).not.toContain(target);
    expect(entry("QaDriver").invokes).not.toContain("EmailEvents");
    for (const fn of LAMBDAS) for (const target of entry(fn).invokes ?? []) expect(LAMBDAS, `${fn} → ${target}`).toContain(target);
  });

  it("links SimEnvelopeKey only to the Bff and InboundWhatsApp, never to the QaDriver", () => {
    const holders = LAMBDAS.filter((fn) => entry(fn).secrets?.includes("SimEnvelopeKey"));
    expect(holders.sort()).toEqual(["Bff", "InboundWhatsApp"]);
    expect(entry("QaDriver").secrets).toContain("QaSimEnvelopeKey");
    expect(entry("Bff").secrets).not.toContain("QaSimEnvelopeKey");
  });

  it("gives SessionKey to the workers and the seven tool targets only", () => {
    const holders = LAMBDAS.filter((fn) => entry(fn).secrets?.includes("SessionKey"));
    expect(holders.sort()).toEqual(["EventWorker", "QaEventWorker", "SignupEventWorker", ...TOOL_TARGETS].sort());
  });
});

describe("least privilege", () => {
  it("never grants a wildcard action", () => {
    for (const fn of LAMBDAS) for (const action of expectedActions(fn)) expect(action, fn).not.toContain("*");
  });

  it("keeps SES, End User Messaging and Guardrails away from the console BFF", () => {
    const actions = expectedActions("Bff");
    expect(actions.some((action) => action.startsWith("ses:") || action.startsWith("social-messaging:") || action.startsWith("bedrock:"))).toBe(false);
  });

  it("lets only the workers invoke the Harness", () => {
    const invokers = LAMBDAS.filter((fn) => expectedActions(fn).includes("bedrock-agentcore:InvokeHarness"));
    expect(invokers.sort()).toEqual(["EventWorker", "QaEventWorker", "SignupEventWorker"]);
  });

  it("reads and deletes only from the QA DLQ, and only in the QaDriver", () => {
    for (const fn of LAMBDAS.filter((name) => name !== "QaDriver")) {
      for (const action of [...QA_DRIVER_DLQ_ONLY_ACTIONS, "cloudwatch:DescribeAlarmHistory"]) expect(expectedActions(fn), fn).not.toContain(action);
    }
    expect(entry("QaDriver").fence).toContain("only on the QA DLQ");
  });

  it("reports drift between generated and declared actions", () => {
    expect(actionDrift("EmailEvents", ["lambda:InvokeFunction", "sqs:SendMessage"])).toEqual({ extra: [], missing: [] });
    expect(actionDrift("EmailEvents", ["lambda:InvokeFunction", "sqs:SendMessage", "ses:SendEmail"])).toEqual({ extra: ["ses:SendEmail"], missing: [] });
    expect(actionDrift("CoreMock", [])).toEqual({ extra: [], missing: [] });
  });

  it("matches the policies the WP-02 stubs generate: none yet", () => {
    for (const fn of LAMBDAS) expect(actionDrift(fn, expectedActions(fn))).toEqual({ extra: [], missing: [] });
  });
});

describe("guest self-signup (docs/architecture-guests.md §12)", () => {
  const LEADS_ROLES = Object.keys(LEADS_GRANTS) as LeadsRole[];

  it("lets no role of the demo reach Leads: only the closed list, and never through `tables`", () => {
    expect([...LEADS_ROLES].sort()).toEqual(["Bff", "LeadNotifier", "PostConfirmationTrigger", "PreSignUpTrigger", "PreTokenTrigger", "QaDriver", "WorldJanitor"]);
    for (const fn of LAMBDAS) expect(expectedTables(fn), fn).not.toHaveProperty("Leads");
    for (const fn of LAMBDAS.filter((name) => !(LEADS_ROLES as string[]).includes(name))) expect(Object.keys(LEADS_GRANTS), fn).not.toContain(fn);
  });

  it("never lets the Bff read a lead, and lets the pre-token trigger read only its world id", () => {
    expect(leadsAllow("Bff", { action: "dynamodb:GetItem", key: "LEAD#sub-1" })).toBe(false);
    expect(leadsAllow("Bff", { action: "dynamodb:Query", key: "LEAD#sub-1" })).toBe(false);
    expect(leadsAllow("Bff", { action: "dynamodb:Query", key: "EMAIL#h1" })).toBe(false);
    expect(leadsAllow("Bff", { action: "dynamodb:Query", key: "EMAIL#h1", index: "ByEmailHash" })).toBe(true);
    expect(leadsAllow("Bff", { action: "dynamodb:PutItem", key: "LEAD#sub-1" })).toBe(true);
    expect(leadsAllow("Bff", { action: "dynamodb:GetItem", key: "SIGNUP#s1" })).toBe(true);
    const lead = { action: "dynamodb:GetItem", key: "LEAD#sub-1" };
    expect(leadsAllow("PreTokenTrigger", { ...lead, attributes: ["pk", "sk", "worldId"] })).toBe(true);
    expect(leadsAllow("PreTokenTrigger", { ...lead, attributes: ["worldId", "email"] })).toBe(false);
    expect(leadsAllow("PreTokenTrigger", lead)).toBe(false);
    expect(leadsAllow("PreSignUpTrigger", { action: "dynamodb:GetItem", key: "PENDING#h1" })).toBe(true);
    expect(leadsAllow("PreSignUpTrigger", { action: "dynamodb:GetItem", key: "LEAD#sub-1" })).toBe(false);
    expect(leadsAllow("QaDriver", { action: "dynamodb:GetItem", key: "LEAD#sub-1" })).toBe(false);
    expect(leadsAllow("QaDriver", { action: "dynamodb:DeleteItem", key: "QALEAD#run1#sub-1" })).toBe(true);
    expect(leadsAllow("LeadNotifier", { action: "dynamodb:PutItem", key: "LEAD#sub-1" })).toBe(false);
  });

  it("lets LeadNotifier send only from no-reply@ and only to @craftech.io", () => {
    expect(expectedActions("LeadNotifier")).toEqual(["ses:SendEmail"]);
    expect(entry("LeadNotifier").capabilities).not.toContain("PIPELINE");
    const statement = leadNoticeStatement({ account: "776805327629", region: "us-east-1" });
    const values = (test: string, variable: string) => statement.conditions.find((entry) => entry.test === test && entry.variable === variable)?.values ?? [];
    expect(values("StringEquals", "ses:FromAddress")).toEqual(["no-reply@reclamo.demo.craftech.io"]);
    const recipients = values("ForAllValues:StringLike", "ses:Recipients");
    for (const [address, allowed] of [["leads@craftech.io", true], ["lead@example.com", false], ["a@sub.craftech.io", false], ["a@craftech.io.evil.com", false]] as const) {
      expect(recipients.some((pattern) => stringLike(pattern, address)), address).toBe(allowed);
    }
    expect(values("Null", "ses:Recipients")).toEqual(["false"]);
    expect(values("Null", "ses:FromAddress")).toEqual(["false"]);
  });

  it("lets the QaDriver's notice.probe send only from no-reply@ and only to the SES mailbox simulator's success@", () => {
    expect(expectedActions("QaDriver")).toContain("ses:SendEmail");
    expect(INFRA_PROBE_RECIPIENT).toBe(LEAD_NOTICE_PROBE_RECIPIENT);
    const statement = leadNoticeProbeStatement({ account: "776805327629", region: "us-east-1" });
    expect(statement.resources).toEqual(leadNoticeStatement({ account: "776805327629", region: "us-east-1" }).resources);
    const values = (test: string, variable: string) => statement.conditions.find((entry) => entry.test === test && entry.variable === variable)?.values ?? [];
    expect(values("StringEquals", "ses:FromAddress")).toEqual(["no-reply@reclamo.demo.craftech.io"]);
    const recipients = values("ForAllValues:StringLike", "ses:Recipients");
    for (const [address, allowed] of [["success@simulator.amazonses.com", true], ["bounce@simulator.amazonses.com", false], ["leads@craftech.io", false], ["lead@example.com", false]] as const) {
      expect(recipients.some((pattern) => stringLike(pattern, address)), address).toBe(allowed);
    }
    expect(values("Null", "ses:Recipients")).toEqual(["false"]);
  });

  it("fences the self-signup worlds: Bff, WorldJanitor and the signup worker reach gs-*, the QaDriver never", () => {
    for (const role of ["Bff", "WorldJanitor", "SignupEventWorker", "PostConfirmationTrigger"] as const) expect(leadingKeysAllow(role, ["W#gs-abcdefghij#WORLD"], "write"), role).toBe(true);
    expect(leadingKeysAllow("QaDriver", ["W#gs-abcdefghij#WORLD"], "read")).toBe(false);
    expect(leadingKeysAllow("SignupEventWorker", ["W#g03#COMPLAINT#cmp-1"], "write")).toBe(false);
    expect(leadingKeysAllow("SignupEventWorker", ["KILL#AGENT"], "write")).toBe(false);
    expect(leadingKeysAllow("PostConfirmationTrigger", ["W#demo#WORLD"], "write")).toBe(false);
    expect(leadingKeysAllow("BudgetBreaker", ["KILL#SIGNUP"], "write")).toBe(true);
    expect(leadingKeysAllow("Bff", ["KILL#SIGNUP"], "write")).toBe(false);
    expect(leadingKeysAllow("Bff", ["SWITCH#SIGNUP"], "read")).toBe(true);
    expect(leadingKeysAllow("WorldJanitor", ["GUEST#REGISTERED"], "read")).toBe(true);
    // The runner's sign-up worlds: their own queue and capacity; the QaDriver primes only the QA one.
    expect(leadingKeysAllow("WorldJanitor", ["GUEST#QA#REGISTERED"], "read")).toBe(true);
    expect(leadingKeysAllow("WorldJanitor", ["GUESTCAP#QA"], "write")).toBe(true);
    expect(leadingKeysAllow("QaDriver", ["GUESTCAP#QA"], "write")).toBe(true);
    expect(leadingKeysAllow("QaDriver", ["GUESTCAP#ACTIVE"], "write")).toBe(false);
  });

  it("gives the signup secrets only where they are needed", () => {
    expect(LAMBDAS.filter((fn) => entry(fn).secrets?.includes("LeadNotifyEmail"))).toEqual(["LeadNotifier"]);
    expect(LAMBDAS.filter((fn) => entry(fn).secrets?.includes("EdgeOriginKey"))).toEqual(["Bff"]);
    expect(expectedActions("Bff")).toEqual(expect.arrayContaining(["cognito-idp:AdminGetUser", "cognito-idp:AdminDeleteUser"]));
    expect(expectedActions("QaDriver")).toContain("cognito-idp:AdminConfirmSignUp");
    // A self-signup's Username is the lead's email: the QaDriver never lists the pool (deploy.yml runs
    // `console:unverify-staff -- --check` with the deploy role instead), and never writes an attribute.
    expect(expectedActions("QaDriver")).not.toContain("cognito-idp:ListUsers");
    expect(expectedActions("QaDriver").filter((action) => /^cognito-idp:(List|Describe)/.test(action))).toEqual([]);
    expect(expectedActions("QaDriver")).not.toContain("cognito-idp:AdminUpdateUserAttributes");
    expect(expectedActions("CustomMessageTrigger")).toEqual([]);
    expect(expectedTables("CustomMessageTrigger")).toEqual({});
  });

  it("grants every admin call of the self-signup's Cognito port to both roles that run signupService", () => {
    // The Bff runs it for visitors (routers/handler.ts); the QaDriver runs it in process for `guest.signup`
    // (qa-driver/stage-ports.ts). An admin call missing from either role fails the signup as UNAVAILABLE.
    const port = readFileSync(resolve(process.cwd(), "packages/bff/src/guests/cognito-port.ts"), "utf8");
    const adminCalls = [...new Set([...port.matchAll(/new (Admin[A-Za-z]+)Command\(/g)].map(([, name]) => `cognito-idp:${name}`))].sort();
    expect(adminCalls).toEqual(["cognito-idp:AdminDeleteUser", "cognito-idp:AdminGetUser"]);
    for (const role of ["Bff", "QaDriver"] as const) for (const action of adminCalls) expect(expectedActions(role), `${role} ${action}`).toContain(action);
    for (const [role, file] of [["Bff", "routers/handler.ts"], ["QaDriver", "qa-driver/stage-ports.ts"]] as const) {
      expect(readFileSync(resolve(process.cwd(), "packages/bff/src", file), "utf8"), role).toMatch(/signupService\(stageSignupDeps\(log\)\)|signupService\(deps\)/);
    }
  });
});
