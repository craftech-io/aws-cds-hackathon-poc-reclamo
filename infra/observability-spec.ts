// Observability of the app as plain data and pure functions (docs/architecture.md §12, ADR-0021 §11,
// docs/build-plan.md WP-37). No SST or Pulumi dependency: infra/observability.ts builds the resources
// from this file, and infra/observability-spec.test.ts checks every value against the documents, the
// code that writes the log lines and the modules that hold the other numbers of §12.
//
// Logs only. Every metric of `ReclamoAgent/*` is a CloudWatch Logs metric filter over the log group SST
// creates for a function (`fn.nodes.logGroup`), one filter per metric and emitting function. The code
// writes one JSON line per occurrence with a `metric` field (`countMetric` of worker/audit.ts and the
// `log.*("…", { metric })` lines, packages/bff/src/lib/log.ts); a few metrics match another line of the
// code instead (`pattern`). A metric "per X" carries its dimensions AND a plain series without them,
// which is the one an alarm watches (a dimensioned series has no total an alarm could read). No
// dimension ever names a world: a dimension value is a metric of its own and billed by the hour.
// Emitters are derived from infra/iam-capabilities.ts where a line can only come from a capability (an
// anchor request only from a holder of ANCHOR), so a new holder is counted without editing this file.
// A filter whose line no code writes yet (`pendingIn`) costs nothing: a custom metric bills only for
// the hours it receives data.

import { EDGE_CHALLENGE_ENFORCED } from "./guest-limits";
import { LAMBDA_CAPABILITIES, expectedTables, resolveCapabilities, type CapabilityName, type LambdaName } from "./iam-capabilities";
import { queueName, type QueueName } from "./workers-spec";

export const METRIC_NAMESPACE = "ReclamoAgent";

export type MetricUnit = "Count" | "Milliseconds" | "None";

export interface MetricSpec {
  readonly name: string;
  /** Functions whose log group carries the line: one metric filter per log group. */
  readonly emitters: readonly LambdaName[];
  /** Defaults to `{ $.metric = "<name>" }`. */
  readonly pattern?: string;
  /** JSON field holding the value; one per line by default. */
  readonly value?: string;
  readonly unit: MetricUnit;
  /** Dimension name → JSON field of the line (CloudWatch accepts at most 3). */
  readonly dimensions?: Readonly<Record<string, string>>;
  /** A series restricted to one value of a field, with that field as its only dimension (an alarm on `demo` alone). */
  readonly scoped?: { readonly dimension: string; readonly field: string; readonly equals: string };
  /** File under packages/bff/src whose line the filter matches. */
  readonly source?: string;
  /** Work package that writes the line, while no code does. */
  readonly pendingIn?: string;
}

const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];
const holdersOf = (capability: CapabilityName): LambdaName[] => LAMBDAS.filter((fn) => resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes(capability));

export const EVENT_WORKERS = ["EventWorker", "SignupEventWorker", "QaEventWorker"] as const satisfies readonly LambdaName[];
export const TOOL_LAMBDAS: readonly LambdaName[] = LAMBDAS.filter((fn) => fn.startsWith("Tool"));
/** Every sender runs the outbound gate (PIPELINE): the tape line of each decision. */
const SENDERS = holdersOf("PIPELINE");
/** Who appends a chain entry asks AnchorWriter for its anchor (ANCHOR, WORLDS included). */
const ANCHOR_REQUESTERS = holdersOf("ANCHOR");
/** A complaint transition is written only by a role that writes `Complaints`. */
const COMPLAINT_WRITERS = LAMBDAS.filter((fn) => expectedTables(fn).Complaints === "write");
/** Where a model call can be refused by the kill, the turn caps or the global caps. */
const MODEL_GATED: readonly LambdaName[] = [...EVENT_WORKERS, "InboundWhatsApp", "ToolInvestigation"];
const SCANNERS: readonly LambdaName[] = ["MediaIntake", "InboundWhatsApp"];
const FACTORY: readonly LambdaName[] = ["WorldJanitor", "QaDriver"];

const ms = "Milliseconds" as const;
const count = "Count" as const;

/** The metrics of docs/architecture.md §12, in its order. */
export const DOCUMENTED_METRICS: readonly MetricSpec[] = [
  { name: "AckLatency", emitters: ["InboundWhatsApp"], value: "$.ackLatencyMs", unit: ms, dimensions: { coldStart: "$.coldStart" }, source: "intake/acknowledge.ts" },
  { name: "TurnLatency", emitters: EVENT_WORKERS, value: "$.latencyMs", unit: ms, dimensions: { withImage: "$.withImage" }, source: "turns/record.ts" },
  { name: "TurnErrors", emitters: EVENT_WORKERS, unit: count, dimensions: { stopReason: "$.stopReason" }, source: "turns/record.ts" },
  { name: "ToolErrors", emitters: TOOL_LAMBDAS, pattern: '{ $.level = "error" }', unit: count, source: "agent-tools/common/handler.ts" },
  { name: "GateDecisions", emitters: SENDERS, unit: count, dimensions: { decision: "$.decision", ruleId: "$.ruleId", sender: "$.senderClass" }, source: "outbound/tape.ts" },
  { name: "PolicyViolations", emitters: ["PolicyAudit"], unit: count, source: "policy-audit/types.ts" },
  { name: "GuardrailBlocks", emitters: EVENT_WORKERS, unit: count, dimensions: { origin: "$.origin" }, source: "worker/guardrail-block.ts" },
  { name: "ReceiptReadFallbacks", emitters: ["ToolInvestigation", "QaDriver"], unit: count, source: "receipts/reader.ts" },
  { name: "ScanLatency", emitters: SCANNERS, value: "$.scanLatencyMs", unit: ms, source: "media-intake/resolve.ts" },
  { name: "ScanFailures", emitters: SCANNERS, unit: count, dimensions: { status: "$.status" }, source: "media-intake/intake.ts" },
  { name: "LateFiresDiscarded", emitters: ["ScheduleDispatch"], unit: count, source: "timers/dispatch.ts" },
  { name: "EarlyFiresDiscarded", emitters: ["ScheduleDispatch"], unit: count, source: "timers/dispatch.ts" },
  { name: "AnchorWriteFailed", emitters: ANCHOR_REQUESTERS, unit: count, source: "complaints/register.ts" },
  {
    name: "SlaOverdue",
    emitters: [...EVENT_WORKERS, "InboundWhatsApp"],
    unit: count,
    // A guest who moves its clock forward may let seeded complaints fall due: only `demo` alarms.
    scoped: { dimension: "World", field: "$.worldId", equals: "demo" },
    source: "timers/effects.ts",
  },
  { name: "MemoryPurgeIncomplete", emitters: FACTORY, unit: count, source: "worlds/memory-purge.ts" },
  { name: "WorldCreateDuration", emitters: FACTORY, value: "$.durationMs", unit: ms, source: "worlds/create.ts" },
  { name: "WorldResetDuration", emitters: FACTORY, value: "$.durationMs", unit: ms, source: "worlds/reset-work.ts" },
  { name: "WorldResetStuck", emitters: ["WorldJanitor"], unit: count, source: "worlds/reset.ts" },
  { name: "TurnCapHits", emitters: MODEL_GATED, unit: count, source: "worker/run-turn.ts" },
  { name: "GlobalCapHits", emitters: MODEL_GATED, unit: count, source: "worker/run-turn.ts" },
  { name: "AgentKilled", emitters: MODEL_GATED, unit: count, source: "worker/kill.ts" },
  { name: "ObligationsFired", emitters: EVENT_WORKERS, unit: count, dimensions: { kind: "$.kind" }, source: "worker/obligations.ts" },
  { name: "PayerMismatch", emitters: [...EVENT_WORKERS, "ToolInvestigation"], unit: count, source: "reconcile/service.ts" },
  { name: "ChainBroken", emitters: ["PolicyAudit", "Bff", "QaDriver"], unit: count, source: "complaints/register-verify.ts" },
  { name: "EmailBounces", emitters: ["EmailEvents"], pattern: '{ $.message = "email_events.enqueued" && $.type = "BOUNCE" }', unit: count, source: "email-events/admit.ts" },
  { name: "EmailComplaints", emitters: ["EmailEvents"], pattern: '{ $.message = "email_events.enqueued" && $.type = "COMPLAINT" }', unit: count, source: "email-events/admit.ts" },
  { name: "CostPerComplaint", emitters: EVENT_WORKERS, value: "$.costUsd", unit: "None", pendingIn: "WP-46" },
  { name: "MalwareFindings", emitters: SCANNERS, unit: count, source: "media-intake/intake.ts" },
  { name: "SignupsStarted", emitters: ["Bff"], unit: count, pendingIn: "WP-54" },
  { name: "SignupsConfirmed", emitters: ["PostConfirmationTrigger"], pattern: '{ $.message = "signup.post_confirmation" && $.outcome = "REGISTERED" }', unit: count, source: "auth-triggers/post-confirmation.ts" },
  { name: "GuestWorldsActive", emitters: ["WorldJanitor"], value: "$.active", unit: count, pendingIn: "WP-34" },
  { name: "GuestWorldsQueued", emitters: ["WorldJanitor"], value: "$.queued", unit: count, source: "worlds/guest-provision.ts" },
  { name: "GuestWorldsExpired", emitters: ["WorldJanitor"], unit: count, source: "worlds/reset-work.ts" },
  { name: "WorldCreateStuck", emitters: ["WorldJanitor"], unit: count, source: "worlds/guest-provision.ts" },
  // The notifier is never retried (infra/guest-limits.ts): a send that throws ends the invocation with
  // the runtime's error line, which is what this text pattern counts.
  { name: "LeadNoticeFailed", emitters: ["LeadNotifier"], pattern: '?"Invoke Error" ?"Task timed out"', unit: count, source: "handlers/lead-notifier.ts" },
];

/** Lines the code already writes for a filter beyond the list of §12 (their callers say a filter counts them). */
export const CODE_METRICS: readonly MetricSpec[] = [
  { name: "INVALID_TRANSITION", emitters: COMPLAINT_WRITERS, unit: count, source: "complaints/state-machine.ts" },
  { name: "EventDeadLettered", emitters: EVENT_WORKERS, unit: count, source: "worker/settle.ts" },
  { name: "EventWrongQueue", emitters: EVENT_WORKERS, unit: count, source: "worker/worker.ts" },
  { name: "TimerDispatchFailures", emitters: ["ScheduleDispatch", ...EVENT_WORKERS], unit: count, source: "timers/fire.ts" },
  { name: "CoreUnavailable", emitters: holdersOf("MOCK_CORE"), unit: count, source: "core/client.ts" },
  { name: "NetworkErrors", emitters: holdersOf("MOCK_NETWORK"), unit: count, source: "networks/client.ts" },
  { name: "GuestMailCapHits", emitters: SENDERS, unit: count, source: "outbound/dispatch.ts" },
  { name: "WhatsAppEnvelopeRejected", emitters: ["InboundWhatsApp"], unit: count, source: "channels/whatsapp/inbound.ts" },
  { name: "WhatsAppInboundRejected", emitters: ["InboundWhatsApp"], unit: count, source: "channels/whatsapp/inbound-message.ts" },
  { name: "WhatsAppSendFailed", emitters: ["InboundWhatsApp"], unit: count, source: "channels/whatsapp/events.ts" },
  { name: "MemoryPurgeDeferred", emitters: FACTORY, unit: count, source: "worlds/reset-work.ts" },
];

export const METRICS: readonly MetricSpec[] = [...DOCUMENTED_METRICS, ...CODE_METRICS];

export function metricPattern(spec: MetricSpec): string {
  return spec.pattern ?? `{ $.metric = "${spec.name}" }`;
}

export interface MetricFilterSpec {
  /** Pulumi name: `Metric<metric>[By<dimensions>|In<value>]<emitter>`. */
  readonly logicalName: string;
  readonly emitter: LambdaName;
  readonly metric: string;
  readonly pattern: string;
  readonly value: string;
  readonly unit: MetricUnit;
  readonly dimensions?: Readonly<Record<string, string>>;
}

const pascal = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** One plain filter per metric and emitter, plus its dimensioned and scoped series. */
export function metricFilterSpecs(metrics: readonly MetricSpec[] = METRICS): MetricFilterSpec[] {
  return metrics.flatMap((spec) =>
    spec.emitters.flatMap((emitter) => {
      const base = { emitter, metric: spec.name, value: spec.value ?? "1", unit: spec.unit };
      const filters: MetricFilterSpec[] = [{ ...base, logicalName: `Metric${spec.name}${emitter}`, pattern: metricPattern(spec) }];
      if (spec.dimensions) {
        const by = Object.keys(spec.dimensions).map(pascal).join("");
        filters.push({ ...base, logicalName: `Metric${spec.name}By${by}${emitter}`, pattern: metricPattern(spec), dimensions: spec.dimensions });
      }
      if (spec.scoped) {
        const { dimension, field, equals } = spec.scoped;
        const pattern = metricPattern(spec).replace(/ }$/, ` && ${field} = "${equals}" }`);
        filters.push({ ...base, logicalName: `Metric${spec.name}In${pascal(equals)}${emitter}`, pattern, dimensions: { [dimension]: field } });
      }
      return filters;
    }),
  );
}

// ---- Alarms ---------------------------------------------------------------------------------------

/** One series an alarm adds up. */
export type AlarmTerm =
  | { readonly kind: "metric"; readonly metric: string; readonly stat: "Sum" | "Minimum"; readonly dimensions?: Readonly<Record<string, string>> }
  /** Messages of a queue: visible plus in flight (a message `dlq.find` is reading still counts). */
  | { readonly kind: "queue"; readonly queue: QueueName; readonly inFlight: boolean }
  /** A rule of the edge web ACL in `AWS/WAFV2` (infra/waf.ts names the rule metrics). */
  | { readonly kind: "waf"; readonly rule: string; readonly metric: "BlockedRequests" | "ChallengeRequests" };

export interface AlarmSpec {
  /** `<app>-<stage>-<key>`. */
  readonly key: string;
  readonly description: string;
  readonly terms: readonly AlarmTerm[];
  readonly threshold: number;
  readonly periodSeconds: number;
}

const MINUTE = 60;
const FIVE_MINUTES = 300;
const FIFTEEN_MINUTES = 900;
const HOUR = 3_600;

const sum = (metric: string, dimensions?: Readonly<Record<string, string>>): AlarmTerm => ({ kind: "metric", metric, stat: "Sum", ...(dimensions ? { dimensions } : {}) });
const above = (metric: string, description: string, threshold = 0, periodSeconds = FIVE_MINUTES): AlarmSpec => ({ key: metric, description, terms: [sum(metric)], threshold, periodSeconds });
const deadLetters = (queue: QueueName): AlarmTerm => ({ kind: "queue", queue, inFlight: true });

/** Production dead letters: the two customer queues of demo, gNN, gtest, gprobe and gs-*, and the scan deadlines. */
export const PRODUCTION_DLQS: readonly QueueName[] = ["CustomerEventsDlq", "SignupCustomerEventsDlq", "ScanDeadlinesDlq"];
/** The QA dead letters have their own alarm, the only one the QaDriver reads (`SC-19/5`, FL-108). */
export const QA_DLQ: QueueName = "QaCustomerEventsDlq";
export const QA_DLQ_ALARM_KEY = "QaDlq";
export const QA_DLQ_ALARM_LINK = "QaDlqAlarm";
export const QA_DLQ_ALARM_ACTIONS = ["cloudwatch:DescribeAlarmHistory"] as const;

/**
 * Rules of the edge web ACL that stop a sign-up request: the rate block of the public API (rule 3), and the
 * token guard (rule 6) only while it challenges (`EDGE_CHALLENGE_ENFORCED`; a counted request is not stopped).
 */
type WafRuleMetric = { readonly rule: string; readonly metric: "BlockedRequests" | "ChallengeRequests" };
const TOKEN_GUARD: WafRuleMetric = { rule: "SignupTokenGuard", metric: "ChallengeRequests" };
export const WAF_SIGNUP_RULES: readonly WafRuleMetric[] = [{ rule: "PublicPostRate", metric: "BlockedRequests" }, ...(EDGE_CHALLENGE_ENFORCED ? [TOKEN_GUARD] : [])];

/** The alarms of docs/architecture.md §12 (the two SES reputation alarms live in infra/leads.ts). Missing data never breaches. */
export const ALARMS: readonly AlarmSpec[] = [
  {
    key: "ProductionDlq",
    description: "An event failed twice and waits in a production dead-letter queue (docs/architecture.md §7); the QA one has its own alarm.",
    terms: PRODUCTION_DLQS.map(deadLetters),
    threshold: 0,
    periodSeconds: MINUTE,
  },
  { key: QA_DLQ_ALARM_KEY, description: "An event of a QA world was dead-lettered (SC-19/5 expects exactly one).", terms: [deadLetters(QA_DLQ)], threshold: 0, periodSeconds: MINUTE },
  above("PolicyViolations", "PolicyAudit found a sent message without its ALLOWED entry, one the policy denies when re-evaluated, a foreign settlement line or a broken chain."),
  { key: "SlaOverdue", description: "A complaint of the demo world went past its regulatory deadline.", terms: [sum("SlaOverdue", { World: "demo" })], threshold: 0, periodSeconds: FIVE_MINUTES },
  above("ChainBroken", "A register, refund or tape chain does not verify against its anchors (ANCHOR_CONFLICT included)."),
  {
    key: "AnchorWriteFailed",
    description: "An anchor request failed in its caller, or AnchorWriter dead-lettered one after its retries.",
    terms: [sum("AnchorWriteFailed"), { kind: "queue", queue: "AnchorWriteFailures", inFlight: false }],
    threshold: 0,
    periodSeconds: FIVE_MINUTES,
  },
  above("ScanFailures", "GuardDuty could not scan an image (ACCESS_DENIED, FAILED, UNSUPPORTED or TIMEOUT)."),
  above("TurnErrors", "More than 5 agent turns failed in 15 minutes.", 5, FIFTEEN_MINUTES),
  above("TurnCapHits", "A world reached its cap of agent turns."),
  above("GlobalCapHits", "A global cap of model calls was reached."),
  above("AgentKilled", "A model call was refused because the agent is cut (KILL#AGENT)."),
  above("MalwareFindings", "GuardDuty found a threat in an uploaded image."),
  above("WorldResetStuck", "A world reset made no progress in three attempts."),
  above("WorldCreateStuck", "A guest world creation made no progress in three attempts."),
  above("LeadNoticeFailed", "The internal notice of a new lead could not be sent."),
  {
    key: "WafSignupBlocks",
    description: "The edge web ACL stopped more than 50 sign-up or recovery requests in 5 minutes (its rate rule, and the token guard while it challenges).",
    terms: WAF_SIGNUP_RULES.map(({ rule, metric }) => ({ kind: "waf", rule, metric })),
    threshold: 50,
    periodSeconds: FIVE_MINUTES,
  },
  {
    key: "GuestWorldsQueued",
    description: "More than 20 self-signup worlds stayed queued for a whole hour: the cap of active worlds is too small.",
    terms: [{ kind: "metric", metric: "GuestWorldsQueued", stat: "Minimum" }],
    threshold: 20,
    periodSeconds: HOUR,
  },
  above("INVALID_TRANSITION", "Code asked for a complaint transition the state machine forbids."),
];

/** `<app>-<stage>-<key>`: fixed, so the QaDriver reads the history of its alarm by name. */
export function alarmName(app: string, stage: string, key: string): string {
  return `${app}-${stage}-${key}`;
}

export interface MetricQuery {
  readonly id: string;
  readonly returnData: boolean;
  readonly expression?: string;
  readonly label?: string;
  readonly metric?: { readonly namespace: string; readonly metricName: string; readonly stat: string; readonly period: number; readonly dimensions?: Readonly<Record<string, string>> };
}

/** What the queries of an alarm need from the stage: the queues' physical names and the WAF metric names. */
export interface AlarmPlace {
  readonly app: string;
  readonly stage: string;
  readonly wafWebAclMetric: string;
  readonly wafRuleMetric: (rule: string) => string;
}

const QUEUE_METRICS = { visible: "ApproximateNumberOfMessagesVisible", inFlight: "ApproximateNumberOfMessagesNotVisible" } as const;

function termQueries(term: AlarmTerm, period: number, place: AlarmPlace): Array<NonNullable<MetricQuery["metric"]>> {
  switch (term.kind) {
    case "metric":
      return [{ namespace: METRIC_NAMESPACE, metricName: term.metric, stat: term.stat, period, ...(term.dimensions ? { dimensions: term.dimensions } : {}) }];
    case "queue": {
      const dimensions = { QueueName: queueName(place.app, place.stage, term.queue) };
      const names = term.inFlight ? [QUEUE_METRICS.visible, QUEUE_METRICS.inFlight] : [QUEUE_METRICS.visible];
      return names.map((metricName) => ({ namespace: "AWS/SQS", metricName, stat: "Maximum", period, dimensions }));
    }
    case "waf":
      return [{ namespace: "AWS/WAFV2", metricName: term.metric, stat: "Sum", period, dimensions: { WebACL: place.wafWebAclMetric, Rule: place.wafRuleMetric(term.rule) } }];
  }
}

/** The queries of an alarm: one metric, or the sum of several with missing points as zero. */
export function alarmQueries(spec: AlarmSpec, place: AlarmPlace): MetricQuery[] {
  const metrics = spec.terms.flatMap((term) => termQueries(term, spec.periodSeconds, place));
  if (metrics.length === 1) return [{ id: "m0", returnData: true, label: spec.key, metric: metrics[0] }];
  return [
    ...metrics.map((metric, index) => ({ id: `m${index}`, returnData: false, metric })),
    { id: "total", returnData: true, label: spec.key, expression: metrics.map((_, index) => `FILL(m${index}, 0)`).join(" + ") },
  ];
}

// ---- Project budget and its breaker ------------------------------------------------------------------

/**
 * Monthly budget of the project, filtered by the cost allocation tag `Project` (docs/architecture.md
 * §12, §17 item 7), notices at 50, 80 and 100 % of the actual cost to `SeedOverrides.budgetEmail`; the
 * 100 % notice also publishes to `<app>-budget-alerts`, whose subscriber `BudgetBreaker` sets
 * `KILL#AGENT` and `KILL#SIGNUP` without a deploy. The amount is provisional (no document fixes it):
 * above the worst month of the guest pools the CTO accepted (docs/architecture-guests.md §7) is a
 * runaway, below it the cut would close a demo that works; WP-46 measures the cost per complaint.
 */
export const PROJECT_BUDGET = { limitUsdPerMonth: 1_000, notifyAtPercent: [50, 80, 100], breakerAtPercent: 100, costTagKey: "Project" } as const;

/** Inside the `budget/<app>-*` fence of the CI deploy role (bootstrap `ProjectBudget`). */
export function budgetName(app: string, stage: string): string {
  return `${app}-${stage}-monthly`;
}

/** Fixed name of docs/architecture.md §1, inside the deploy role's `sns:<app>-budget-alerts` statement. */
export function budgetAlertsTopicName(app: string): string {
  return `${app}-budget-alerts`;
}

export function budgetCostFilter(project: string): { readonly name: "TagKeyValue"; readonly values: string[] } {
  return { name: "TagKeyValue", values: [`user:${PROJECT_BUDGET.costTagKey}$${project}`] };
}

/** Only AWS Budgets of this account may publish to the breaker's topic (docs/architecture.md §14). */
export function budgetAlertsTopicPolicy(scope: { readonly topicArn: string; readonly account: string }) {
  return {
    Version: "2012-10-17" as const,
    Statement: [
      { Sid: "AwsBudgetsOfThisAccount", Effect: "Allow" as const, Principal: { Service: "budgets.amazonaws.com" }, Action: "sns:Publish", Resource: scope.topicArn, Condition: { StringEquals: { "aws:SourceAccount": scope.account } } },
    ],
  };
}

const ONE_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** `SeedOverrides.budgetEmail`, read at deploy time; absent → none. Never echoed: the secret holds real addresses. */
export function budgetSubscribers(seedOverridesJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(seedOverridesJson);
  } catch {
    throw new Error("SeedOverrides is not valid JSON (docs/seed-spec.md §1)");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("SeedOverrides must be a JSON object");
  const email: unknown = Reflect.get(parsed, "budgetEmail");
  if (email === undefined) return [];
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!ONE_ADDRESS.test(address)) throw new Error("SeedOverrides.budgetEmail must be one email address (docs/seed-spec.md §1)");
  return [address];
}

export interface BudgetNotification {
  readonly comparisonOperator: "GREATER_THAN";
  readonly notificationType: "ACTUAL";
  readonly threshold: number;
  readonly thresholdType: "PERCENTAGE";
  readonly subscriberEmailAddresses: string[];
  readonly subscriberSnsTopicArns: string[];
}

/** The notices, all on the actual cost; the breaker's at 100 % exists even without an email. */
export function budgetNotifications(emails: readonly string[], breakerTopicArn: string): BudgetNotification[] {
  return PROJECT_BUDGET.notifyAtPercent.flatMap((threshold) => {
    const topics = threshold === PROJECT_BUDGET.breakerAtPercent ? [breakerTopicArn] : [];
    if (emails.length === 0 && topics.length === 0) return [];
    return [{ comparisonOperator: "GREATER_THAN", notificationType: "ACTUAL", threshold, thresholdType: "PERCENTAGE", subscriberEmailAddresses: [...emails], subscriberSnsTopicArns: topics }];
  });
}
