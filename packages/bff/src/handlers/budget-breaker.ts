/// <reference path="../../sst-env.d.ts" />
// `BudgetBreaker` (docs/architecture.md §12-§13, docs/architecture-guests.md §7 and §9, FL-109): the
// runtime cut that needs no deploy. It is subscribed to two topics and trusts neither blindly:
//
//   <app>-budget-alerts      the 100 % notification of the project's AWS Budget (plain text): turns on
//                            `KILL#AGENT` (no turn, no Bedrock call; numbers and acknowledgements keep
//                            going out by rule) and `KILL#SIGNUP` (the sign-up closes; the console stays)
//   <app>-auth-mail-alerts   the account's SES reputation alarms (`<app>-<stage>-SesComplaintRate`,
//                            `…-SesBounceRate`, a CloudWatch alarm message parsed with zod): ONLY
//                            `KILL#SIGNUP`, never `KILL#AGENT`, and only on a transition to `ALARM`
//
// Any other topic, alarm or message is refused and logged. Every kill is audited in the `demo` world
// (`AGENT_KILLED`, `SIGNUP_KILLED`; epoch 0: a stage-wide decision outside any world's epoch), keyed by
// the SNS message, so a redelivery writes nothing new. Lifting a kill is the operator's
// (`policy.setAgentKill`, `guests:signup-switch -- --on`) after reviewing what tripped it.
import { z } from "zod";
import { dynamoConnector } from "../connector/dynamo/connector";
import { DynamoStore } from "../connector/dynamo/engine";
import { isConflict } from "../connector/errors";
import type { Connector } from "../connector/port";
import type { TableStore } from "../connector/store";
import { signupRuntimeKeys } from "../leads/keys";
import { sha256Hex } from "../lib/crypto";
import { createLogger, type Logger } from "../lib/log";
import { readLinked } from "../lib/resource";

const SnsRecord = z.object({
  EventSource: z.literal("aws:sns"),
  Sns: z.object({
    TopicArn: z.string().regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/),
    MessageId: z.string().min(1).max(100),
    Timestamp: z.iso.datetime({ offset: true }),
    Subject: z.string().max(200).nullish(),
    Message: z.string().max(65_536),
  }),
});
export const BudgetBreakerEvent = z.object({ Records: z.array(z.unknown()).min(1).max(10) });

/** The CloudWatch alarm notification of the SES reputation alarms (only the fields we decide on). */
export const AlarmMessage = z.object({
  AlarmName: z.string().min(1).max(255),
  NewStateValue: z.enum(["ALARM", "OK", "INSUFFICIENT_DATA"]),
  Trigger: z.object({ MetricName: z.enum(["Reputation.ComplaintRate", "Reputation.BounceRate"]), Namespace: z.literal("AWS/SES") }).loose(),
}).loose();

export type BreakerAction = "AGENT_KILLED" | "SIGNUP_KILLED";

export interface BreakerOutcome {
  readonly messageId: string;
  readonly topic: "BUDGET" | "AUTH_MAIL" | "UNKNOWN";
  readonly actions: readonly BreakerAction[];
  /** Why nothing was done (`OK_STATE`, `UNKNOWN_TOPIC`, `UNRECOGNIZED_MESSAGE`, `BELOW_100`, `INVALID_RECORD`). */
  readonly ignored?: string;
}

export interface BudgetBreakerDeps {
  readonly connector: Connector;
  /** The same tables, for the global `KILL#SIGNUP` row of the sign-up (leads/keys.ts). */
  readonly store: TableStore;
  /** `Resource.App`: the fixed names of the two topics and of the alarms. */
  readonly app: { readonly name: string; readonly stage: string };
  readonly log: Logger;
  /** Real clock. */
  readonly now: () => Date;
}

const topicName = (arn: string): string => arn.slice(arn.lastIndexOf(":") + 1);

/** The threshold of an AWS Budgets notification ("…is greater than 100% of…"), when it says one. */
export function budgetThreshold(subject: string | null | undefined, message: string): number | "NOT_A_BUDGET_NOTICE" | undefined {
  const text = `${subject ?? ""}\n${message}`;
  if (!/AWS Budget/i.test(text)) return "NOT_A_BUDGET_NOTICE";
  const match = /greater than\s+([0-9]+(?:\.[0-9]+)?)\s*%/i.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

async function audit(deps: BudgetBreakerDeps, action: BreakerAction, sns: z.infer<typeof SnsRecord>["Sns"], refs: Record<string, string>): Promise<void> {
  try {
    await deps.connector.audit.append({
      worldId: "demo",
      epoch: 0,
      auditId: `aud-bb-${sha256Hex(`${sns.MessageId}#${action}`).slice(0, 32)}`,
      // The publish instant, not the run's: a redelivery of the same message hits the same key.
      ts: new Date(sns.Timestamp).toISOString(),
      action,
      actor: "SYSTEM",
      refs: { snsMessageId: sns.MessageId, ...refs },
      outcome: "KILL_ON",
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

async function killAgent(deps: BudgetBreakerDeps, sns: z.infer<typeof SnsRecord>["Sns"]): Promise<void> {
  await deps.connector.runtime.setKill({ on: true, by: "BUDGET", atReal: deps.now().toISOString(), reason: "BUDGET_100" });
  deps.log.error("budget_breaker.agent_killed", { source: "BUDGET" });
  await audit(deps, "AGENT_KILLED", sns, { source: "BUDGET" });
}

async function killSignup(deps: BudgetBreakerDeps, sns: z.infer<typeof SnsRecord>["Sns"], source: string): Promise<void> {
  await deps.store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.kill(), entity: "Kill", active: true, by: source, changedAtReal: deps.now().toISOString() } });
  deps.log.error("budget_breaker.signup_killed", { source });
  await audit(deps, "SIGNUP_KILLED", sns, { source });
}

async function onBudget(deps: BudgetBreakerDeps, sns: z.infer<typeof SnsRecord>["Sns"]): Promise<BreakerOutcome> {
  const base = { messageId: sns.MessageId, topic: "BUDGET" as const };
  const threshold = budgetThreshold(sns.Subject, sns.Message);
  if (threshold === "NOT_A_BUDGET_NOTICE") return { ...base, actions: [], ignored: "UNRECOGNIZED_MESSAGE" };
  // Only the 100 % notification publishes here; a lower one that arrives anyway is logged, not acted on.
  if (threshold !== undefined && threshold < 100) return { ...base, actions: [], ignored: "BELOW_100" };
  await killAgent(deps, sns);
  await killSignup(deps, sns, "BUDGET");
  return { ...base, actions: ["AGENT_KILLED", "SIGNUP_KILLED"] };
}

async function onAuthMail(deps: BudgetBreakerDeps, sns: z.infer<typeof SnsRecord>["Sns"]): Promise<BreakerOutcome> {
  const base = { messageId: sns.MessageId, topic: "AUTH_MAIL" as const };
  let raw: unknown;
  try {
    raw = JSON.parse(sns.Message);
  } catch {
    return { ...base, actions: [], ignored: "UNRECOGNIZED_MESSAGE" };
  }
  const alarm = AlarmMessage.safeParse(raw);
  const prefix = `${deps.app.name}-${deps.app.stage}-`;
  const expected = new Set([`${prefix}SesComplaintRate`, `${prefix}SesBounceRate`]);
  if (!alarm.success || !expected.has(alarm.data.AlarmName)) return { ...base, actions: [], ignored: "UNRECOGNIZED_MESSAGE" };
  if (alarm.data.NewStateValue !== "ALARM") return { ...base, actions: [], ignored: "OK_STATE" };
  // Never KILL#AGENT by this path: the reputation of Cognito's emails only closes the sign-up.
  await killSignup(deps, sns, alarm.data.Trigger.MetricName === "Reputation.ComplaintRate" ? "SES_COMPLAINT_RATE" : "SES_BOUNCE_RATE");
  return { ...base, actions: ["SIGNUP_KILLED"] };
}

/** Handles one SNS record; anything it cannot trust is refused, never acted on. */
export async function handleRecord(deps: BudgetBreakerDeps, record: unknown): Promise<BreakerOutcome> {
  const parsed = SnsRecord.safeParse(record);
  if (!parsed.success) return { messageId: "-", topic: "UNKNOWN", actions: [], ignored: "INVALID_RECORD" };
  const { Sns: sns } = parsed.data;
  const topic = topicName(sns.TopicArn);
  if (topic === `${deps.app.name}-budget-alerts`) return onBudget(deps, sns);
  if (topic === `${deps.app.name}-auth-mail-alerts`) return onAuthMail(deps, sns);
  return { messageId: sns.MessageId, topic: "UNKNOWN", actions: [], ignored: "UNKNOWN_TOPIC" };
}

/** Every record of the event; a storage failure throws, so SNS delivers the message again. */
export async function breakOnAlerts(deps: BudgetBreakerDeps, event: unknown): Promise<BreakerOutcome[]> {
  const parsed = BudgetBreakerEvent.safeParse(event);
  if (!parsed.success) {
    deps.log.warn("budget_breaker.refused", { reason: "INVALID_EVENT" });
    return [];
  }
  const outcomes: BreakerOutcome[] = [];
  for (const record of parsed.data.Records) {
    const outcome = await handleRecord(deps, record);
    if (outcome.ignored !== undefined) deps.log.warn("budget_breaker.refused", { topic: outcome.topic, reason: outcome.ignored });
    outcomes.push(outcome);
  }
  return outcomes;
}

const AppLink = z.object({ name: z.string().min(1), stage: z.string().min(1) });

let shared: Omit<BudgetBreakerDeps, "log"> | undefined;

/** Lambda entry. */
export async function handler(event: unknown): Promise<BreakerOutcome[]> {
  shared ??= { connector: dynamoConnector(), store: new DynamoStore(), app: readLinked("App", AppLink), now: () => new Date() };
  return breakOnAlerts({ ...shared, log: createLogger({ bindings: { service: "budget-breaker" } }) }, event);
}
