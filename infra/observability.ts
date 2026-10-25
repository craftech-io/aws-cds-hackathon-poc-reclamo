// Observability and cost (docs/architecture.md §12, ADR-0021 §11, docs/build-plan.md WP-37). Names,
// patterns, thresholds and the budget live in infra/observability-spec.ts (checked by its test).
//
//   Logs      Only logs. Every Lambda's group is created by SST with the 30 days of the $transform in
//             sst.config.ts; the anchors keep 180 (infra/storage.ts); the Harness runtime group of `live`
//             is created by infra/agentcore.ts before its endpoint, 30 days. The `…-DEFAULT` runtime group
//             and `aws/spans` are declared manual configuration (docs/architecture.md §17 items 9 and 2).
//             No CloudWatch dashboard, no tracing of our own, Model Invocation Logging stays off: nothing
//             in infra/ enables any of them (observability-spec.test.ts).
//   Metrics   `ReclamoAgent/*`: one CloudWatch Logs metric filter per metric and emitting function, over
//             the group SST creates for it (`fn.nodes.logGroup`; its name follows SST's suffix, not the
//             function's). AWS WAF publishes its per-rule metrics in `AWS/WAFV2` on its own.
//   Alarms    The ones of §12, named `<app>-<stage>-<key>`; missing data never breaches. They notify
//             nobody: the state is read with `describe-alarms` (and by the QaDriver for its DLQ alarm).
//             The two SES reputation alarms, which do act (KILL#SIGNUP), live in infra/leads.ts.
//   Budget    `aws.budgets.Budget` `<app>-<stage>-monthly` on the cost tag `Project` (§17 item 7), notices
//             at 50, 80 and 100 % to `SeedOverrides.budgetEmail`; the 100 % notice also publishes to
//             `<app>-budget-alerts`, to which BudgetBreaker (infra/bff.ts) is subscribed.
//
// Cost: metric filters are free; a custom metric bills by the hour only while it receives data; one
// alarm metric at US$ 0.10 a month each; the first two budgets of an account are free.
//
// Verify (reads only):
//   aws --profile craftech-demos logs describe-metric-filters --log-group-name <log group of EventWorker>
//   aws --profile craftech-demos cloudwatch describe-alarms --alarm-name-prefix aws-cds-hackathon-poc-reclamo-poc- --query "MetricAlarms[].[AlarmName,StateValue]"
//   aws --profile craftech-demos cloudwatch list-dashboards                                           → none of this app
//   aws --profile craftech-demos logs describe-log-groups --query "logGroups[?contains(logGroupName, 'reclamo')].[logGroupName,retentionInDays]"
//     → 30 everywhere, 180 for /aws-cds-hackathon-poc-reclamo/poc/register-anchors
//   aws --profile craftech-demos budgets describe-notifications-for-budget --account-id 776805327629 --budget-name aws-cds-hackathon-poc-reclamo-poc-monthly
//   aws --profile craftech-demos sns list-subscriptions-by-topic --topic-arn arn:aws:sns:us-east-1:776805327629:aws-cds-hackathon-poc-reclamo-budget-alerts
//   aws --profile craftech-demos bedrock get-model-invocation-logging-configuration                  → no loggingConfig

import { toolFunctions } from "./agent-tools";
import { TOOL_FUNCTIONS } from "./agentcore-spec";
import { customMessageTrigger, postConfirmationTrigger, preSignUpTrigger, preTokenTrigger } from "./auth";
import { budgetBreaker, bff, policyAudit, qaDriver, worldJanitor } from "./bff";
import type { LambdaName } from "./iam-capabilities";
import { leadNotifier } from "./leads";
import { inboundWhatsApp } from "./messaging-whatsapp";
import { coreMock, networkMock } from "./mocks";
import {
  ALARMS,
  METRIC_NAMESPACE,
  PROJECT_BUDGET,
  QA_DLQ_ALARM_ACTIONS,
  QA_DLQ_ALARM_KEY,
  QA_DLQ_ALARM_LINK,
  alarmName,
  alarmQueries,
  budgetAlertsTopicName,
  budgetAlertsTopicPolicy,
  budgetCostFilter,
  budgetName,
  budgetNotifications,
  budgetSubscribers,
  metricFilterSpecs,
  type AlarmPlace,
  type AlarmSpec,
} from "./observability-spec";
import { SeedOverrides } from "./secrets";
import { PROJECT } from "./tags";
import { applyEdgeWaf, edgeWafRules } from "./waf";
import { anchorWriter, emailEvents, eventWorker, mediaIntake, qaEventWorker, scheduleDispatch, signupEventWorker } from "./workers";

/** Every Lambda of infra/iam-capabilities.ts, by name: a metric can only name an emitter that exists. */
const functions = {
  InboundWhatsApp: inboundWhatsApp,
  EventWorker: eventWorker,
  SignupEventWorker: signupEventWorker,
  QaEventWorker: qaEventWorker,
  ...(Object.fromEntries(Object.entries(TOOL_FUNCTIONS).map(([target, fn]) => [fn, toolFunctions[target as keyof typeof toolFunctions]])) as Record<(typeof TOOL_FUNCTIONS)[keyof typeof TOOL_FUNCTIONS], sst.aws.Function>),
  MediaIntake: mediaIntake,
  EmailEvents: emailEvents,
  ScheduleDispatch: scheduleDispatch,
  Bff: bff,
  WorldJanitor: worldJanitor,
  PolicyAudit: policyAudit,
  BudgetBreaker: budgetBreaker,
  CoreMock: coreMock,
  NetworkMock: networkMock,
  QaDriver: qaDriver,
  AnchorWriter: anchorWriter,
  PreTokenTrigger: preTokenTrigger,
  PreSignUpTrigger: preSignUpTrigger,
  PostConfirmationTrigger: postConfirmationTrigger,
  CustomMessageTrigger: customMessageTrigger,
  LeadNotifier: leadNotifier,
} satisfies Record<LambdaName, sst.aws.Function>;

/** The group SST created for a function, which the function logs to (`loggingConfig.logGroup`). */
function logGroupName(fn: LambdaName): $util.Output<string> {
  return functions[fn].nodes.logGroup.apply((group) => {
    if (group === undefined) throw new Error(`${fn} has no SST log group; the $transform of sst.config.ts gives every Function logging.retention, and its metric filters need it.`);
    return group.name;
  });
}

// ---- Metric filters ------------------------------------------------------------------------------

export const metricFilters: aws.cloudwatch.LogMetricFilter[] = metricFilterSpecs().map(
  (spec) =>
    new aws.cloudwatch.LogMetricFilter(spec.logicalName, {
      logGroupName: logGroupName(spec.emitter),
      pattern: spec.pattern,
      metricTransformation: {
        name: spec.metric,
        namespace: METRIC_NAMESPACE,
        value: spec.value,
        unit: spec.unit,
        ...(spec.dimensions === undefined ? {} : { dimensions: { ...spec.dimensions } }),
      },
    }),
);

// ---- Alarms --------------------------------------------------------------------------------------

/** The metric names infra/waf.ts gives the edge web ACL and its rules (the dimensions of `AWS/WAFV2`). */
function wafMetricNames(): Pick<AlarmPlace, "wafWebAclMetric" | "wafRuleMetric"> {
  const edgeArgs = {} as aws.wafv2.WebAclArgs;
  applyEdgeWaf(edgeArgs);
  const webAcl = (edgeArgs.visibilityConfig as { metricName?: string } | undefined)?.metricName;
  if (webAcl === undefined) throw new Error("infra/waf.ts gives the edge web ACL no metric name.");
  const rules = new Map(edgeWafRules().map((rule) => [rule.name, rule.visibilityConfig.metricName]));
  return {
    wafWebAclMetric: webAcl,
    wafRuleMetric: (rule) => {
      const metric = rules.get(rule);
      if (metric === undefined) throw new Error(`The edge web ACL has no rule ${rule} (infra/waf.ts).`);
      return metric;
    },
  };
}

const place: AlarmPlace = { app: $app.name, stage: $app.stage, ...wafMetricNames() };

function createAlarm(spec: AlarmSpec): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`Alarm${spec.key.replace(/_/g, "")}`, {
    name: alarmName($app.name, $app.stage, spec.key),
    alarmDescription: spec.description,
    comparisonOperator: "GreaterThanThreshold",
    threshold: spec.threshold,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: "notBreaching",
    metricQueries: alarmQueries(spec, place).map((query) => ({
      id: query.id,
      returnData: query.returnData,
      ...(query.label === undefined ? {} : { label: query.label }),
      ...(query.expression === undefined ? {} : { expression: query.expression }),
      ...(query.metric === undefined
        ? {}
        : {
            metric: {
              namespace: query.metric.namespace,
              metricName: query.metric.metricName,
              stat: query.metric.stat,
              period: query.metric.period,
              ...(query.metric.dimensions === undefined ? {} : { dimensions: { ...query.metric.dimensions } }),
            },
          }),
    })),
  });
}

export const alarms: Readonly<Record<string, aws.cloudwatch.MetricAlarm>> = Object.fromEntries(ALARMS.map((spec) => [spec.key, createAlarm(spec)]));

const qaDlqAlarm = alarms[QA_DLQ_ALARM_KEY];
if (qaDlqAlarm === undefined) throw new Error(`infra/observability-spec.ts declares no ${QA_DLQ_ALARM_KEY} alarm.`);

/** The QaDriver's view of its DLQ alarm (`alarm.history`): the name and DescribeAlarmHistory on it only. */
export const QaDlqAlarm = new sst.Linkable(QA_DLQ_ALARM_LINK, {
  properties: { name: qaDlqAlarm.name },
  include: [sst.aws.permission({ actions: [...QA_DLQ_ALARM_ACTIONS], resources: [qaDlqAlarm.arn] })],
});

// ---- Project budget and its breaker --------------------------------------------------------------

const accountId = aws.getCallerIdentityOutput({}).accountId;

export const budgetAlerts = new sst.aws.SnsTopic("BudgetAlerts", {
  transform: {
    topic: (args) => {
      args.name = budgetAlertsTopicName($app.name);
    },
  },
});

export const budgetAlertsPolicy = new aws.sns.TopicPolicy("BudgetAlertsPolicy", {
  arn: budgetAlerts.arn,
  policy: $util.all([budgetAlerts.arn, accountId]).apply(([topicArn, account]) => JSON.stringify(budgetAlertsTopicPolicy({ topicArn, account }))),
});

export const budgetBreakerSubscription = budgetAlerts.subscribe("BudgetBreakerBudget", budgetBreaker.arn);

// `budgetEmail` of the secret, never echoed; without it the 100 % notice still reaches the breaker.
const budgetEmails = SeedOverrides.value.apply((json) => {
  const emails = budgetSubscribers(json);
  if (emails.length === 0) $util.log.warn("SeedOverrides has no budgetEmail: only the 100 % notice exists, for BudgetBreaker (docs/seed-spec.md §1).");
  return emails;
});

export const projectBudget = new aws.budgets.Budget(
  "ProjectBudget",
  {
    name: budgetName($app.name, $app.stage),
    budgetType: "COST",
    limitAmount: String(PROJECT_BUDGET.limitUsdPerMonth),
    limitUnit: "USD",
    timeUnit: "MONTHLY",
    costFilters: [budgetCostFilter(PROJECT)],
    notifications: $util.all([budgetEmails, budgetAlerts.arn]).apply(([emails, topicArn]) => budgetNotifications(emails, topicArn)),
  },
  // AWS Budgets checks it may publish before it accepts the notification.
  { dependsOn: [budgetAlertsPolicy] },
);
