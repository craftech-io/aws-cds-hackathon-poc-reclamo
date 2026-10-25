// Observability of docs/architecture.md §12 and ADR-0021 §11 (logs only, 30 days, no dashboards),
// checked without an account: the spec against the documents and against the code that writes each
// log line, and every infra module and sst.config.ts against the rules of "solo logs".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EDGE_CHALLENGE_ENFORCED, SIGNUP_FUNCTION_BUDGETS, WAF_SIGNUP_BLOCKS_ALARM } from "./guest-limits";
import { LAMBDA_CAPABILITIES, type LambdaName } from "./iam-capabilities";
import * as spec from "./observability-spec";

const APP = "aws-cds-hackathon-poc-reclamo";
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const lineOf = (start: string): string => architecture.split("\n").find((line) => line.startsWith(start)) ?? "";
const ticked = (line: string): string[] => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
const BFF = "packages/bff/src";
const LAMBDAS = new Set(Object.keys(LAMBDA_CAPABILITIES));
const place: spec.AlarmPlace = { app: APP, stage: "poc", wafWebAclMetric: "EdgeWebAcl", wafRuleMetric: (rule) => `Edge${rule}` };
const alarm = (key: string): spec.AlarmSpec => {
  const found = spec.ALARMS.find((item) => item.key === key);
  if (!found) throw new Error(`no alarm ${key}`);
  return found;
};

/** Every infra module that builds resources, and sst.config.ts (tests and the bootstrap template aside). */
const INFRA_SOURCES = [
  "sst.config.ts",
  ...readdirSync(resolve(process.cwd(), "infra"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".fakes.ts"))
    .map((name) => `infra/${name}`),
];
/** The code of a module without its comments (a comment may name what the module does NOT do). */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

describe("logs only (ADR-0021 §11, docs/architecture.md §12)", () => {
  it("declares no CloudWatch dashboard, no tracing of its own and no Model Invocation Logging", () => {
    for (const path of INFRA_SOURCES) {
      const text = code(path);
      expect(text, path).not.toMatch(/cloudwatch\.Dashboard|Dashboard\(/);
      expect(text, path).not.toMatch(/tracingConfig|TracingConfig|tracing\s*:/);
      expect(text, path).not.toMatch(/ModelInvocationLogging|modelInvocationLogging/);
    }
    expect(architecture).toContain("no hay dashboards de CloudWatch ni tracing propio y Model Invocation Logging está deshabilitado");
  });

  it("gives every Function's log group 30 days through the $transform of sst.config.ts, which no module overrides", () => {
    expect(code("sst.config.ts")).toMatch(/\$transform\(sst\.aws\.Function,[\s\S]*args\.logging \?\?= \{ retention: "1 month" \}/);
    const sstRetention = resolve(process.cwd(), ".sst/platform/src/components/aws/logging.ts");
    if (existsSync(sstRetention)) expect(readFileSync(sstRetention, "utf8")).toContain('"1 month": 30');
    for (const path of INFRA_SOURCES.filter((source) => source !== "sst.config.ts")) expect(code(path), path).not.toMatch(/\blogging\s*:/);
  });

  it("leaves no log group of its own without a retention: 30 days, the anchors 180", () => {
    let groups = 0;
    for (const path of INFRA_SOURCES) {
      const text = code(path);
      for (const match of text.matchAll(/new aws\.cloudwatch\.LogGroup\(/g)) {
        groups += 1;
        expect(text.slice(match.index, (match.index ?? 0) + 400), path).toMatch(/retentionInDays: (AGENT_LOG_RETENTION_DAYS|ANCHOR_RETENTION_DAYS)/);
      }
      expect(text, path).not.toMatch(/awsnative\.logs\.LogGroup/);
    }
    expect(groups).toBe(2);
    expect(read("infra/storage-keys.ts")).toContain("export const ANCHOR_RETENTION_DAYS = 180;");
    expect(read("infra/agentcore-spec.ts")).toMatch(/AGENT_LOG_RETENTION_DAYS = 30\b/);
  });

  it("declares the DEFAULT runtime group and aws/spans as manual configuration with their verification (§17 items 2 and 9)", () => {
    const section = architecture.slice(architecture.indexOf("## 17. Configuración manual declarada"), architecture.indexOf("## 18."));
    const item = (n: number) => section.split("\n").find((line) => line.startsWith(`| ${n} |`)) ?? "";
    expect(item(2)).toContain("aws/spans");
    expect(item(2)).toContain("aws --profile craftech-demos logs describe-log-groups --log-group-name-prefix aws/spans");
    expect(item(9)).toContain("-DEFAULT");
    expect(item(9)).toContain("put-retention-policy");
    expect(item(9)).toContain("--retention-in-days 30");
    expect(item(9)).toContain("aws --profile craftech-demos logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/");
  });

  it("builds every metric as a filter over the group SST creates for the function", () => {
    expect(code("infra/observability.ts")).toContain("functions[fn].nodes.logGroup");
    expect(code("infra/observability.ts")).toContain("new aws.cloudwatch.LogMetricFilter(");
    expect(spec.METRIC_NAMESPACE).toBe("ReclamoAgent");
    expect(lineOf("- Métricas `ReclamoAgent/*`")).not.toBe("");
  });
});

describe("metrics ReclamoAgent/* (docs/architecture.md §12)", () => {
  it("covers exactly the metrics of §12, in its order", () => {
    const documented = ticked(lineOf("- Métricas `ReclamoAgent/*`")).filter((token) => /^[A-Z][A-Za-z]+$/.test(token));
    expect(spec.DOCUMENTED_METRICS.map((metric) => metric.name)).toEqual(documented);
  });

  it("names only Lambdas of infra/iam-capabilities.ts as emitters, each once per metric", () => {
    for (const metric of spec.METRICS) {
      expect(metric.emitters.length, metric.name).toBeGreaterThan(0);
      expect(new Set(metric.emitters).size, metric.name).toBe(metric.emitters.length);
      for (const emitter of metric.emitters) expect(LAMBDAS.has(emitter), `${metric.name} ${emitter}`).toBe(true);
    }
  });

  it("matches a line the code writes, field by field, or names the work package that will write it", () => {
    for (const metric of spec.METRICS) {
      if (metric.source === undefined) {
        expect(metric.pendingIn, metric.name).toMatch(/^WP-\d+$/);
        continue;
      }
      expect(metric.pendingIn, metric.name).toBeUndefined();
      const path = `${BFF}/${metric.source}`;
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
      const text = read(path);
      const pattern = spec.metricPattern(metric);
      const message = /\$\.message = "([^"]+)"/.exec(pattern)?.[1];
      if (pattern.startsWith("{ $.metric =")) expect(text, metric.name).toContain(`"${metric.name}"`);
      else if (message !== undefined) expect(text, metric.name).toContain(`"${message}"`);
      else if (pattern.includes("$.level")) expect(text, metric.name).toContain(".error(");
      for (const field of [metric.value, ...Object.values(metric.dimensions ?? {})].filter((item): item is string => item !== undefined)) {
        expect(text, `${metric.name} ${field}`).toContain(field.slice(2));
      }
    }
  });

  it("counts a failed lead notice from the runtime's error line, as the notifier is never retried", () => {
    const notice = spec.DOCUMENTED_METRICS.find((metric) => metric.name === "LeadNoticeFailed");
    expect(notice?.emitters).toEqual(["LeadNotifier"]);
    expect(notice?.pattern).toBe('?"Invoke Error" ?"Task timed out"');
    expect(SIGNUP_FUNCTION_BUDGETS.LeadNotifier.retries).toBe(0);
  });

  it("derives emitters from the capabilities where only a capability can write the line", () => {
    const emitters = (name: string) => spec.METRICS.find((metric) => metric.name === name)?.emitters ?? [];
    expect(emitters("AnchorWriteFailed")).toEqual(expect.arrayContaining(["EventWorker", "Bff", "WorldJanitor", "QaDriver", "ToolActions", "EmailEvents"]));
    expect(emitters("AnchorWriteFailed")).not.toContain("PolicyAudit");
    expect(emitters("INVALID_TRANSITION")).not.toContain("PolicyAudit");
    expect(emitters("GateDecisions")).toEqual(expect.arrayContaining(["EventWorker", "SignupEventWorker", "QaEventWorker", "InboundWhatsApp", "ToolMessaging"]));
    expect(emitters("GateDecisions")).not.toContain("Bff");
    expect(emitters("ToolErrors")).toHaveLength(7);
  });

  it("builds one plain filter per metric and emitter, plus the dimensioned and scoped series, with unique names", () => {
    const filters = spec.metricFilterSpecs();
    expect(new Set(filters.map((filter) => filter.logicalName)).size).toBe(filters.length);
    for (const metric of spec.METRICS) {
      const own = filters.filter((filter) => filter.metric === metric.name);
      const plain = own.filter((filter) => filter.dimensions === undefined);
      expect(plain.map((filter) => filter.emitter), metric.name).toEqual([...metric.emitters]);
      expect(own.length, metric.name).toBe(metric.emitters.length * (1 + (metric.dimensions ? 1 : 0) + (metric.scoped ? 1 : 0)));
    }
    for (const filter of filters) {
      expect(Object.keys(filter.dimensions ?? {}).length).toBeLessThanOrEqual(3);
      // No dimension names a world: each value would be a metric billed by the hour.
      for (const field of Object.values(filter.dimensions ?? {})) if (field === "$.worldId") expect(filter.pattern).toContain('$.worldId = "demo"');
    }
    expect(filters.length).toBeLessThan(250);
  });

  it("counts SlaOverdue of demo apart, so only demo alarms", () => {
    const scoped = spec.metricFilterSpecs().filter((filter) => filter.metric === "SlaOverdue" && filter.dimensions !== undefined);
    expect(scoped.length).toBe(4);
    for (const filter of scoped) {
      expect(filter.pattern).toBe('{ $.metric = "SlaOverdue" && $.worldId = "demo" }');
      expect(filter.dimensions).toEqual({ World: "$.worldId" });
    }
    expect(alarm("SlaOverdue").terms).toEqual([{ kind: "metric", metric: "SlaOverdue", stat: "Sum", dimensions: { World: "demo" } }]);
    expect(lineOf("- Alarmas:")).toContain("`SlaOverdue` > 0 **solo en el mundo `demo`**");
  });
});

describe("alarms (docs/architecture.md §12)", () => {
  it("has an alarm for every metric alarm of §12 (the SES reputation ones live in infra/leads.ts)", () => {
    const names = new Set([...spec.METRICS.map((metric) => metric.name), "WafSignupBlocks", "SesComplaintRate"]);
    const documented = ticked(lineOf("- Alarmas:")).filter((token) => names.has(token));
    const keys = new Set(spec.ALARMS.map((item) => item.key));
    for (const name of documented) {
      if (name === "SesComplaintRate") expect(read("infra/leads.ts")).toContain('"SesComplaintRate"');
      else expect(keys.has(name), name).toBe(true);
    }
    for (const item of spec.ALARMS.filter((candidate) => names.has(candidate.key))) expect(documented, item.key).toContain(item.key);
    expect(new Set(spec.ALARMS.map((item) => item.key)).size).toBe(spec.ALARMS.length);
  });

  it("keeps the thresholds of §12: TurnErrors > 5 in 15 min, WafSignupBlocks > 50 in 5 min, GuestWorldsQueued > 20 for an hour", () => {
    expect(alarm("TurnErrors")).toMatchObject({ threshold: 5, periodSeconds: 900 });
    expect(alarm("WafSignupBlocks")).toMatchObject({ threshold: WAF_SIGNUP_BLOCKS_ALARM.blocks, periodSeconds: WAF_SIGNUP_BLOCKS_ALARM.periodSeconds });
    expect(alarm("GuestWorldsQueued")).toMatchObject({ threshold: 20, periodSeconds: 3_600, terms: [{ kind: "metric", metric: "GuestWorldsQueued", stat: "Minimum" }] });
    for (const key of ["PolicyViolations", "ChainBroken", "ScanFailures", "TurnCapHits", "GlobalCapHits", "AgentKilled", "MalwareFindings", "WorldResetStuck", "WorldCreateStuck", "LeadNoticeFailed", "INVALID_TRANSITION"]) {
      expect(alarm(key), key).toMatchObject({ threshold: 0, terms: [{ kind: "metric", metric: key, stat: "Sum" }] });
    }
  });

  it("adds AnchorWriter's dead letters to the callers' failures in AnchorWriteFailed", () => {
    const queries = spec.alarmQueries(alarm("AnchorWriteFailed"), place);
    expect(queries.map((query) => query.metric?.metricName ?? query.expression)).toEqual(["AnchorWriteFailed", "ApproximateNumberOfMessagesVisible", "FILL(m0, 0) + FILL(m1, 0)"]);
    expect(queries[1]?.metric?.dimensions).toEqual({ QueueName: `${APP}-poc-AnchorWriteFailures` });
  });

  it("watches the rules of the edge web ACL that stop a sign-up in WafSignupBlocks (rule 6 only while it challenges)", () => {
    const queries = spec.alarmQueries(alarm("WafSignupBlocks"), place);
    const blocked = { namespace: "AWS/WAFV2", metricName: "BlockedRequests", stat: "Sum", period: 300, dimensions: { WebACL: "EdgeWebAcl", Rule: "EdgePublicPostRate" } };
    const challenged = { namespace: "AWS/WAFV2", metricName: "ChallengeRequests", stat: "Sum", period: 300, dimensions: { WebACL: "EdgeWebAcl", Rule: "EdgeSignupTokenGuard" } };
    expect(queries.filter((query) => query.metric !== undefined).map((query) => query.metric)).toEqual(EDGE_CHALLENGE_ENFORCED ? [blocked, challenged] : [blocked]);
    const waf = read("infra/waf.ts");
    for (const { rule } of spec.WAF_SIGNUP_RULES) expect(waf).toContain(`name: "${rule}"`);
  });

  it("names every alarm <app>-<stage>-<key>, one query returning data", () => {
    expect(spec.alarmName(APP, "poc", "QaDlq")).toBe(`${APP}-poc-QaDlq`);
    for (const item of spec.ALARMS) {
      const queries = spec.alarmQueries(item, place);
      expect(queries.filter((query) => query.returnData), item.key).toHaveLength(1);
      for (const query of queries) expect(query.id).toMatch(/^[a-z][A-Za-z0-9_]*$/);
    }
  });
});

describe("dead letters [FL-108]", () => {
  it("alarms on the production dead letters apart from the QA ones, counting messages in flight too", () => {
    const production = spec.alarmQueries(alarm("ProductionDlq"), place);
    const queues = production.flatMap((query) => (query.metric?.dimensions?.QueueName ? [query.metric.dimensions.QueueName] : []));
    expect([...new Set(queues)]).toEqual([`${APP}-poc-CustomerEventsDlq.fifo`, `${APP}-poc-SignupCustomerEventsDlq.fifo`, `${APP}-poc-ScanDeadlinesDlq`]);
    expect(queues).not.toContain(`${APP}-poc-QaCustomerEventsDlq.fifo`);
    expect(production.at(-1)?.expression).toBe("FILL(m0, 0) + FILL(m1, 0) + FILL(m2, 0) + FILL(m3, 0) + FILL(m4, 0) + FILL(m5, 0)");
    const qa = spec.alarmQueries(alarm(spec.QA_DLQ_ALARM_KEY), place);
    expect(qa.flatMap((query) => (query.metric ? [query.metric.metricName] : []))).toEqual(["ApproximateNumberOfMessagesVisible", "ApproximateNumberOfMessagesNotVisible"]);
    expect(qa[0]?.metric?.dimensions).toEqual({ QueueName: `${APP}-poc-QaCustomerEventsDlq.fifo` });
    expect(alarm("ProductionDlq")).toMatchObject({ threshold: 0, periodSeconds: 60 });
    expect(lineOf("- Alarmas:")).toContain("DLQ de producción > 0 (la de QA tiene su propia alarma, solo para `SC-19/5`)");
  });

  it("lets the QaDriver read only its own alarm's history, and counts every dead-lettered event", () => {
    expect(spec.QA_DLQ_ALARM_ACTIONS).toEqual(["cloudwatch:DescribeAlarmHistory"]);
    expect(LAMBDA_CAPABILITIES.QaDriver.actions).toContain("cloudwatch:DescribeAlarmHistory");
    expect(LAMBDA_CAPABILITIES.QaDriver.fence).toContain("DescribeAlarmHistory only on the QA DLQ alarm");
    const deadLettered = spec.METRICS.find((metric) => metric.name === "EventDeadLettered");
    expect(deadLettered?.emitters).toEqual(["EventWorker", "SignupEventWorker", "QaEventWorker"]);
  });
});

describe("project budget and its breaker (docs/architecture.md §12, §14)", () => {
  const TOPIC = `arn:aws:sns:us-east-1:776805327629:${APP}-budget-alerts`;

  it("filters by the cost tag Project and notices at 50, 80 and 100 %, the breaker only at 100 %", () => {
    expect(spec.budgetName(APP, "poc")).toBe(`${APP}-poc-monthly`);
    expect(spec.budgetCostFilter(APP)).toEqual({ name: "TagKeyValue", values: [`user:Project$${APP}`] });
    const notices = spec.budgetNotifications(["ops@craftech.io"], TOPIC);
    expect(notices.map((notice) => [notice.threshold, notice.subscriberSnsTopicArns])).toEqual([
      [50, []],
      [80, []],
      [100, [TOPIC]],
    ]);
    for (const notice of notices) expect(notice).toMatchObject({ notificationType: "ACTUAL", thresholdType: "PERCENTAGE", subscriberEmailAddresses: ["ops@craftech.io"] });
    expect(spec.budgetNotifications([], TOPIC)).toEqual([expect.objectContaining({ threshold: 100, subscriberEmailAddresses: [], subscriberSnsTopicArns: [TOPIC] })]);
    expect(lineOf("- **Presupuesto**")).toContain("avisos al 50, 80 y 100 % a `SeedOverrides.budgetEmail`");
  });

  it("reads budgetEmail from SeedOverrides and fails without echoing a malformed value", () => {
    expect(spec.budgetSubscribers("{}")).toEqual([]);
    expect(spec.budgetSubscribers(JSON.stringify({ budgetEmail: " Ops@Craftech.io " }))).toEqual(["ops@craftech.io"]);
    expect(() => spec.budgetSubscribers(JSON.stringify({ budgetEmail: "not-an-address" }))).toThrow(/budgetEmail must be one email address/);
    try {
      spec.budgetSubscribers(JSON.stringify({ budgetEmail: "x secret y" }));
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
    expect(() => spec.budgetSubscribers("not json")).toThrow(/not valid JSON/);
  });

  it("publishes to the fixed topic of §1, which only AWS Budgets of this account may use", () => {
    expect(spec.budgetAlertsTopicName(APP)).toBe(`${APP}-budget-alerts`);
    expect(architecture).toContain(`| Topic de presupuesto | \`${APP}-budget-alerts\``);
    expect(read("infra/bootstrap/ci-role.yaml")).toContain(":${AppName}-budget-alerts");
    const policy = spec.budgetAlertsTopicPolicy({ topicArn: TOPIC, account: "776805327629" });
    expect(policy.Statement).toEqual([
      { Sid: "AwsBudgetsOfThisAccount", Effect: "Allow", Principal: { Service: "budgets.amazonaws.com" }, Action: "sns:Publish", Resource: TOPIC, Condition: { StringEquals: { "aws:SourceAccount": "776805327629" } } },
    ]);
    expect(LAMBDA_CAPABILITIES.BudgetBreaker.fence).toContain("…-budget-alerts (both kills)");
  });

  it("keeps the budget inside the CI role's budget fence", () => {
    expect(read("infra/bootstrap/ci-role.yaml")).toContain(":budget/${AppName}-*");
    expect(spec.PROJECT_BUDGET.breakerAtPercent).toBe(100);
    expect(spec.PROJECT_BUDGET.limitUsdPerMonth).toBeGreaterThan(0);
  });
});

describe("emitters by function", () => {
  it("gives every function that writes a §12 alarm metric at least one filter", () => {
    const covered = new Set<LambdaName>(spec.metricFilterSpecs().map((filter) => filter.emitter));
    for (const fn of ["EventWorker", "InboundWhatsApp", "MediaIntake", "ScheduleDispatch", "WorldJanitor", "PolicyAudit", "LeadNotifier", "QaDriver", "Bff", "EmailEvents", "PostConfirmationTrigger"] as const) {
      expect(covered.has(fn), fn).toBe(true);
    }
  });
});
