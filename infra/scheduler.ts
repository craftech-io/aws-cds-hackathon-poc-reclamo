// EventBridge Scheduler for the timers (docs/architecture.md §10 and §14, ADR-0004, ADR-0011,
// docs/build-plan.md WP-31).
//
// Everything due at a simulated hour is a `Timers/W#<w>#TIMER#…` item (ADR-0004). A world that runs in
// real time (`RUNNING`) gives each timer due within the next real hour one one-time schedule
// `tm-<worldId>-e<epoch>-<hash>` (`at()`, FlexibleTimeWindow OFF, ActionAfterCompletion DELETE), at most
// 50 per world, which the code holding TIMERS creates, moves and deletes at runtime
// (packages/bff/src/timers, WP-30). A paused world has none. This module creates what those schedules need
// and nothing that fires by itself:
//
//   Schedules group        `<app>-<stage>-schedules`: the fence of `scheduler:*` for the code (TIMERS), for
//                          the CI deploy role and for the permissions boundary (bootstrap).
//   scheduler-invoke role  `<app>-<stage>-scheduler-invoke`: every timer schedule runs with it. Trusted only
//                          by scheduler.amazonaws.com for this account and this group; its only permission
//                          is lambda:InvokeFunction on ScheduleDispatch (infra/workers.ts), which decides
//                          from the stored timer and clock, never from the input (docs/architecture.md §10).
//   Scheduler (Linkable)   capability TIMERS: `Resource.Scheduler.{groupName, roleArn, targetArn}`, the four
//                          schedule actions on the group's schedules and iam:PassRole of the invocation
//                          role, only towards scheduler.amazonaws.com. Every holder of PIPELINE or WORLDS
//                          links it (late links of infra/messaging-whatsapp.ts, infra/workers.ts,
//                          infra/agent-tools.ts and infra/bff.ts).
//   DispatchScheduler      the same capability for ScheduleDispatch itself (`Resource.DispatchScheduler.
//   (Linkable)             {groupName, roleArn}`): the `Scheduler` Linkable names ScheduleDispatch as its
//                          target, so linking it there would make the function depend on its own ARN;
//                          ScheduleDispatch takes its own ARN from the invocation instead.
//
// Cost: per schedule invocation; nothing bills while every world is paused.
//
// Verify:
//   aws --profile craftech-demos scheduler get-schedule-group --name aws-cds-hackathon-poc-reclamo-poc-schedules
//   aws --profile craftech-demos scheduler list-schedules --group-name aws-cds-hackathon-poc-reclamo-poc-schedules
//     → empty while every world is PAUSED
//   aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-reclamo-poc-scheduler-invoke
//     → Path /aws-cds-hackathon-poc-reclamo/, PermissionsBoundary …-ci-boundary, trust scheduler.amazonaws.com
//       with aws:SourceAccount and the group as aws:SourceArn
//   aws --profile craftech-demos iam get-role-policy --role-name aws-cds-hackathon-poc-reclamo-poc-scheduler-invoke --policy-name <name>
//     → lambda:InvokeFunction on ScheduleDispatch only

import { CAPABILITIES } from "./iam-capabilities";
import { scheduleDispatch } from "./workers";

export const SCHEDULER_SERVICE = "scheduler.amazonaws.com";

/** The group every timer schedule of the stage lives in (docs/architecture.md §1 and §10). */
export function scheduleGroupName(app: string, stage: string): string {
  return `${app}-${stage}-schedules`;
}

/** The role every timer schedule of the stage runs with. */
export function schedulerInvocationRoleName(app: string, stage: string): string {
  return `${app}-${stage}-scheduler-invoke`;
}

/** TIMERS on the group's schedules; `iam:PassRole` is granted apart, conditioned on the service. */
export const SCHEDULE_ACTIONS: readonly string[] = CAPABILITIES.TIMERS.actions.filter((action) => action.startsWith("scheduler:"));

/** Trust of the invocation role: the Scheduler of this account, for schedules of this group only. */
export function schedulerTrustDocument(accountId: string, groupArn: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: SCHEDULER_SERVICE },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": accountId, "aws:SourceArn": groupArn } },
      },
    ],
  };
}

/** The invocation role's only permission. */
export function schedulerInvokeDocument(targetArn: string): object {
  return {
    Version: "2012-10-17",
    Statement: [{ Sid: "InvokeScheduleDispatchOnly", Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [targetArn] }],
  };
}

const accountId = aws.getCallerIdentityOutput({}).accountId;

export const scheduleGroup = new aws.scheduler.ScheduleGroup("Schedules", { name: scheduleGroupName($app.name, $app.stage) });

export const schedulerInvocationRole = new aws.iam.Role("SchedulerInvocationRole", {
  name: schedulerInvocationRoleName($app.name, $app.stage),
  description: "Assumed by EventBridge Scheduler for the timer schedules of the app's group; invokes ScheduleDispatch only.",
  assumeRolePolicy: $util.all([accountId, scheduleGroup.arn]).apply(([account, groupArn]) => JSON.stringify(schedulerTrustDocument(account, groupArn))),
});

export const schedulerInvocationPolicy = new aws.iam.RolePolicy("SchedulerInvocationPolicy", {
  role: schedulerInvocationRole.id,
  policy: scheduleDispatch.arn.apply((arn) => JSON.stringify(schedulerInvokeDocument(arn))),
});

/** The group's schedules whose name starts with `prefix` (every one, `tm-` every timer, `tm-qa-` the QA worlds'). */
const groupSchedules = (prefix: string) => $interpolate`arn:aws:scheduler:${aws.getRegionOutput({}).region}:${accountId}:schedule/${scheduleGroup.name}/${prefix}*`;

/** The permissions of TIMERS: the schedule actions on the group's schedules, PassRole only towards the Scheduler. */
function timerPermissions(prefix = "") {
  return [
    sst.aws.permission({ actions: [...SCHEDULE_ACTIONS], resources: [groupSchedules(prefix)] }),
    sst.aws.permission({
      actions: ["iam:PassRole"],
      resources: [schedulerInvocationRole.arn],
      conditions: [{ test: "StringEquals", variable: "iam:PassedToService", values: [SCHEDULER_SERVICE] }],
    }),
  ];
}

/** Capability TIMERS: `Resource.Scheduler.{groupName, roleArn, targetArn}` and the permissions to program a timer. */
const schedulerProperties = { groupName: scheduleGroup.name, roleArn: schedulerInvocationRole.arn, targetArn: scheduleDispatch.arn };

export const Scheduler = new sst.Linkable("Scheduler", { properties: schedulerProperties, include: timerPermissions() });

/**
 * The same `Resource.Scheduler` (SST names a link after its component's URN) with TIMERS only on the
 * schedules named `<prefix>*`: `tm-` for WorldJanitor, `tm-qa-` for the QaDriver (docs/architecture.md §14).
 */
export function schedulerFencedTo(prefix: "tm-" | "tm-qa-") {
  return { urn: Scheduler.urn, getSSTLink: () => ({ properties: schedulerProperties, include: timerPermissions(prefix) }) };
}

/** Capability TIMERS of ScheduleDispatch: the same permissions, without the target (its own ARN). */
export const DispatchScheduler = new sst.Linkable("DispatchScheduler", {
  properties: {
    groupName: scheduleGroup.name,
    roleArn: schedulerInvocationRole.arn,
  },
  include: timerPermissions(),
});
