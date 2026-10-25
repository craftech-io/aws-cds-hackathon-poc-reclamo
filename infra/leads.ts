// Leads of the guest self-signup (docs/architecture-guests.md §9, §10 and §12, ADR-0020 §9).
//
//   Leads             The table itself is declared with every other table (infra/storage-keys.ts
//                     `TABLES.Leads`, infra/storage-tables.ts) so the key layout, the TTL and the
//                     indexes come from the same code: keys `SIGNUP#`, `PENDING#`, `CANON#`, `LEAD#`,
//                     `LEADDEL#` (QA: `QASIGNUP#`, `QAPENDING#`, `QALEAD#`), indexes `ByEmailHash` and
//                     `BySub` with keys only, TTL on `expiresAt`, and NO point-in-time recovery: a lead
//                     deleted on request must not survive in a copy. Removal `remove` like every
//                     resource of the stage: export the leads before an `sst remove`
//                     (infra/bootstrap/README.md). Outside the demo data: no world factory, reset,
//                     export, tape or metric reads it.
//   Access            Never through `link` (an SST link of a table grants `dynamodb:*`): the table is
//                     linked by name only and each role of the closed list gets the statements of
//                     LEADS_GRANTS (infra/iam-leading-keys.ts) through `leadsPermissions`. infra/auth.ts
//                     uses it for the triggers; infra/bff.ts (WP-37) for Bff, WorldJanitor and QaDriver.
//   LeadNotifier      One email per confirmed lead, from no-reply@ to the single @craftech.io mailbox of
//                     the `LeadNotifyEmail` secret (`not-configured` → nothing is sent, audited
//                     `LEAD_NOTICE_SKIPPED`). IAM fences the send: identity of the app, `ses:FromAddress`
//                     no-reply@, `ses:Recipients` only `*@craftech.io` (SEND_LEAD_NOTICE). Invoked
//                     asynchronously by the post-confirmation trigger (and by the Bff's repair), never
//                     retried by Lambda: a lost notice is an alarm, a duplicate would reach a person.
//   auth-mail alerts  Cognito's emails leave without a configuration set, so their complaints and
//                     bounces are only visible in the account's SES reputation. `SesComplaintRate`
//                     (≥ 0.1 %) and `SesBounceRate` (≥ 2 %) publish to `<app>-auth-mail-alerts`, to
//                     which `BudgetBreaker` (infra/bff.ts, WP-37) is subscribed: it sets `KILL#SIGNUP`
//                     and never `KILL#AGENT` by this way. Only CloudWatch, from those two alarms of this
//                     account, may publish to the topic.
//
// Verify (reads only, docs/architecture-guests.md §15):
//   aws --profile craftech-demos dynamodb describe-continuous-backups --table-name <Leads> → DISABLED
//   aws --profile craftech-demos cloudwatch describe-alarms --alarm-name-prefix aws-cds-hackathon-poc-reclamo-poc-Ses

import { authMailFrom } from "./auth-email";
import { SES_REPUTATION_ALARMS, SIGNUP_FUNCTION_BUDGETS } from "./guest-limits";
import { LEADS_GRANTS, WORLD_LEADING_KEYS, type LeadsRole } from "./iam-leading-keys";
import { LEAD_NOTICE_ACTIONS, leadNoticeProbeConditions, leadNoticeStatement, sesIdentityArn } from "./messaging-email-spec";
import { LeadNotifyEmail } from "./secrets";
import { tableAccess } from "./storage";
import { leadingKeysConditions, type IamCondition } from "./storage-keys";
import { AuditLog, Leads, Runtime } from "./storage-tables";

export { Leads };

/** Lambda entry of the notifier (WP-54's file; a stub answering UNAVAILABLE until then). */
export const LEAD_NOTIFIER_HANDLER = "packages/bff/src/handlers/lead-notifier.handler";

/** Fixed name, inside the deploy role's `<app>-*` fence for topics. */
export function authMailAlertsTopicName(app: string): string {
  return `${app}-auth-mail-alerts`;
}

export type SesReputationAlarm = keyof Pick<typeof SES_REPUTATION_ALARMS, "complaint" | "bounce">;

/** `<app>-<stage>-SesComplaintRate` and `<app>-<stage>-SesBounceRate`. */
export function sesAlarmName(app: string, stage: string, alarm: SesReputationAlarm): string {
  return `${app}-${stage}-${alarm === "complaint" ? "SesComplaintRate" : "SesBounceRate"}`;
}

/** One statement for the `permissions` of an `sst.aws.Function`. */
export interface LeadsPermission {
  readonly actions: string[];
  readonly resources: $util.Input<string>[];
  readonly conditions: IamCondition[];
}

/** The statements of a role on `Leads`, from LEADS_GRANTS: by leading key, attribute and index. */
export function leadsPermissions(role: LeadsRole, tableArn: $util.Input<string>): LeadsPermission[] {
  return LEADS_GRANTS[role].map((grant) => {
    const conditions = leadingKeysConditions(grant.leadingKeys);
    if ("attributes" in grant) {
      conditions.push({ test: "ForAllValues:StringEquals", variable: "dynamodb:Attributes", values: [...grant.attributes] });
      conditions.push({ test: "Null", variable: "dynamodb:Attributes", values: ["false"] });
    }
    if ("select" in grant) conditions.push({ test: "StringEqualsIfExists", variable: "dynamodb:Select", values: [grant.select] });
    const resource = "index" in grant ? $interpolate`${tableArn}/index/${grant.index}` : tableArn;
    return { actions: [...grant.actions], resources: [resource], conditions };
  });
}

/** `Resource.LeadNotice.from` of the notifier: the product name and no-reply@ (never a lead's data). */
export const leadNotice = new sst.Linkable("LeadNotice", { properties: { from: authMailFrom } });

const caller = aws.getCallerIdentityOutput({});
const region = aws.getRegionOutput({});
// SEND_LEAD_NOTICE: `ses:SendEmail` on the identity, from no-reply@ to *@craftech.io only (the spec of
// infra/messaging-email.ts, the identity's owner, builds it; iam-capabilities.test.ts evaluates it).
const sendLeadNotice = $util.all([caller.accountId, region.region]).apply(([account, regionName]) => leadNoticeStatement({ account, region: regionName }));
/** The QaDriver's `notice.probe` (infra/bff.ts): the same send, to the SES mailbox simulator's `success@` only. */
export const sendLeadNoticeProbe = {
  actions: [...LEAD_NOTICE_ACTIONS],
  resources: [$util.all([caller.accountId, region.region]).apply(([account, regionName]) => sesIdentityArn({ account, region: regionName }))],
  conditions: leadNoticeProbeConditions(),
};

const budget = SIGNUP_FUNCTION_BUDGETS.LeadNotifier;
/** Its fence (WORLD_LEADING_KEYS): the daily counter of notices on Runtime and the signup audit partition. */
const NOTICE_KEYS: readonly string[] = WORLD_LEADING_KEYS.LeadNotifier.write;

export const leadNotifier = new sst.aws.Function("LeadNotifier", {
  handler: LEAD_NOTIFIER_HANDLER,
  description: "Notice of a new lead, only to the single @craftech.io mailbox of the LeadNotifyEmail secret",
  timeout: `${budget.timeoutSeconds} seconds`,
  memory: `${budget.memoryMb} MB`,
  retries: budget.retries,
  link: [Leads, Runtime, AuditLog, LeadNotifyEmail, leadNotice],
  // `output` resolves the ARNs inside every statement, so the list carries plain strings.
  permissions: $util.output([
    ...leadsPermissions("LeadNotifier", Leads.arn),
    { actions: ["dynamodb:UpdateItem"], resources: [Runtime.arn], conditions: leadingKeysConditions(NOTICE_KEYS.filter((key) => key.startsWith("LEADNOTICE#"))) },
    tableAccess("AuditLog", "append", NOTICE_KEYS.filter((key) => key.startsWith("SIGNUP#AUD#"))),
    sendLeadNotice,
  ]),
});

export const authMailAlerts = new sst.aws.SnsTopic("AuthMailAlerts", {
  transform: {
    topic: (args) => {
      args.name = authMailAlertsTopicName($app.name);
    },
  },
});

const alarmArn = (alarm: SesReputationAlarm) => $interpolate`arn:aws:cloudwatch:${region.region}:${caller.accountId}:alarm:${sesAlarmName($app.name, $app.stage, alarm)}`;

export const authMailAlertsPolicy = new aws.sns.TopicPolicy("AuthMailAlertsPolicy", {
  arn: authMailAlerts.arn,
  policy: $util.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SesReputationAlarmsOfThisApp",
        Effect: "Allow",
        Principal: { Service: "cloudwatch.amazonaws.com" },
        Action: "sns:Publish",
        Resource: authMailAlerts.arn,
        Condition: { StringEquals: { "aws:SourceAccount": caller.accountId }, ArnEquals: { "aws:SourceArn": [alarmArn("complaint"), alarmArn("bounce")] } },
      },
    ],
  }),
});

function sesReputationAlarm(alarm: SesReputationAlarm): aws.cloudwatch.MetricAlarm {
  const { metricName, threshold } = SES_REPUTATION_ALARMS[alarm];
  const logical = alarm === "complaint" ? "SesComplaintRate" : "SesBounceRate";
  return new aws.cloudwatch.MetricAlarm(`${logical}Alarm`, {
    name: sesAlarmName($app.name, $app.stage, alarm),
    alarmDescription: `SES ${metricName} of the account reached ${threshold * 100} %: the self-signup closes (KILL#SIGNUP) until the operator reopens it.`,
    namespace: "AWS/SES",
    metricName,
    statistic: "Maximum",
    period: SES_REPUTATION_ALARMS.periodSeconds,
    evaluationPeriods: SES_REPUTATION_ALARMS.evaluationPeriods,
    threshold,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    treatMissingData: "notBreaching",
    alarmActions: [authMailAlerts.arn],
  });
}

export const sesComplaintRateAlarm = sesReputationAlarm("complaint");
export const sesBounceRateAlarm = sesReputationAlarm("bounce");

// BudgetBreaker lives in infra/bff.ts (WP-37), evaluated after this module: a dynamic import inside
// an Output settles once it has run. Until it exports `budgetBreaker`, the alarms still publish and the
// deploy warns; the subscription appears on the first deploy that has the function.
$util.output(import("./bff")).apply((module) => {
  const breaker: unknown = Reflect.get(module, "budgetBreaker");
  if (breaker === undefined) {
    $util.log.warn("infra/bff.ts exports no budgetBreaker yet: the SES reputation alarms publish to <app>-auth-mail-alerts with no subscriber.");
    return;
  }
  if (!(breaker instanceof sst.aws.Function)) throw new Error("infra/bff.ts exports budgetBreaker, but it is not an sst.aws.Function.");
  authMailAlerts.subscribe("BudgetBreakerAuthMail", breaker.arn);
});
