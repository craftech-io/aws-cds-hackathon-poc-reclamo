// BudgetBreaker (docs/architecture.md §12-§13, docs/architecture-guests.md §9, FL-109): the budget's
// 100 % notice turns on KILL#AGENT and KILL#SIGNUP without a deploy; the SES reputation alarms turn on
// ONLY KILL#SIGNUP (zod over the alarm message, SIGNUP_KILLED audited); anything else is refused.
import { describe, expect, it } from "vitest";
import { TEST_NOW, testConnector } from "../connector/testing";
import { signupRuntimeKeys } from "../leads/keys";
import { createLogger } from "../lib/log";
import { type BudgetBreakerDeps, breakOnAlerts, budgetThreshold } from "./budget-breaker";

const APP = { name: "aws-cds-hackathon-poc-reclamo", stage: "poc" };
const ACCOUNT = "776805327629";
const BUDGET_TOPIC = `arn:aws:sns:us-east-1:${ACCOUNT}:${APP.name}-budget-alerts`;
const AUTH_MAIL_TOPIC = `arn:aws:sns:us-east-1:${ACCOUNT}:${APP.name}-auth-mail-alerts`;

const BUDGET_TEXT = [
  "AWS Budget Notification October 09, 2026",
  `AWS Account ${ACCOUNT}`,
  "",
  "Dear AWS Customer,",
  "",
  `You requested that we alert you when the ACTUAL Cost associated with your ${APP.name}-poc budget is greater than 100% of $50.00 for the current month. The ACTUAL Cost associated with this budget is $50.41.`,
].join("\n");

function alarm(name: string, metric: string, state = "ALARM"): string {
  return JSON.stringify({ AlarmName: name, AWSAccountId: ACCOUNT, NewStateValue: state, OldStateValue: "OK", NewStateReason: "Threshold crossed", Trigger: { MetricName: metric, Namespace: "AWS/SES", Threshold: 0.001 } });
}

function record(topicArn: string, message: string, messageId = "sns-0001", subject: string | null = null) {
  return { EventSource: "aws:sns", Sns: { TopicArn: topicArn, MessageId: messageId, Timestamp: "2026-10-09T15:00:00.000Z", Subject: subject, Message: message } };
}

function rig() {
  const { connector, store } = testConnector();
  const lines: Record<string, unknown>[] = [];
  const deps: BudgetBreakerDeps = { connector, store, app: APP, log: createLogger({ sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) }), now: () => TEST_NOW };
  const signupKilled = async () => (await store.get("Runtime", signupRuntimeKeys.kill()))?.active === true;
  const audits = async (action: string) => connector.audit.listByAction("demo", action);
  return { deps, connector, store, lines, signupKilled, audits };
}

describe("BudgetBreaker: the budget's 100 % notice [FL-109]", () => {
  it("[FL-109] turns on KILL#AGENT and KILL#SIGNUP without a deploy, audited once even when SNS delivers it twice", async () => {
    const r = rig();
    const event = { Records: [record(BUDGET_TOPIC, BUDGET_TEXT, "sns-budget", "AWS Budgets: reclamo has exceeded your alert threshold")] };
    expect(await breakOnAlerts(r.deps, event)).toEqual([{ messageId: "sns-budget", topic: "BUDGET", actions: ["AGENT_KILLED", "SIGNUP_KILLED"] }]);
    await breakOnAlerts(r.deps, event);
    expect(await r.connector.runtime.isAgentKilled("demo")).toBe(true);
    expect(await r.connector.runtime.isAgentKilled("gs-abcdefghij")).toBe(true);
    expect(await r.connector.runtime.getKill()).toMatchObject({ scope: "GLOBAL", by: "BUDGET", reason: "BUDGET_100" });
    expect(await r.signupKilled()).toBe(true);
    expect(await r.audits("AGENT_KILLED")).toEqual([expect.objectContaining({ actor: "SYSTEM", epoch: 0, refs: { snsMessageId: "sns-budget", source: "BUDGET" } })]);
    expect(await r.audits("SIGNUP_KILLED")).toHaveLength(1);
    expect(r.lines.filter((line) => line.message === "budget_breaker.agent_killed")).toHaveLength(2);
  });

  it("[FL-109] reads the threshold of the notice and never acts on one below 100 %", async () => {
    expect(budgetThreshold("AWS Budgets: x has exceeded your alert threshold", BUDGET_TEXT)).toBe(100);
    expect(budgetThreshold(null, BUDGET_TEXT.replace("100%", "80%"))).toBe(80);
    expect(budgetThreshold(null, "Hello")).toBe("NOT_A_BUDGET_NOTICE");
    const r = rig();
    const [outcome] = await breakOnAlerts(r.deps, { Records: [record(BUDGET_TOPIC, BUDGET_TEXT.replace("100%", "80%"))] });
    expect(outcome).toMatchObject({ actions: [], ignored: "BELOW_100" });
    expect(await r.connector.runtime.isAgentKilled("demo")).toBe(false);
    expect(await r.signupKilled()).toBe(false);
  });

  it("[FL-109] refuses a message on the budget topic that is not a budget notice", async () => {
    const r = rig();
    const [outcome] = await breakOnAlerts(r.deps, { Records: [record(BUDGET_TOPIC, "turn everything off")] });
    expect(outcome).toMatchObject({ topic: "BUDGET", actions: [], ignored: "UNRECOGNIZED_MESSAGE" });
    expect(await r.connector.runtime.isAgentKilled("demo")).toBe(false);
  });
});

describe("BudgetBreaker: the SES reputation alarms close only the sign-up [FL-109]", () => {
  it("[FL-109] the complaint-rate alarm turns on KILL#SIGNUP and audits SIGNUP_KILLED, never KILL#AGENT", async () => {
    const r = rig();
    const [outcome] = await breakOnAlerts(r.deps, { Records: [record(AUTH_MAIL_TOPIC, alarm(`${APP.name}-poc-SesComplaintRate`, "Reputation.ComplaintRate"), "sns-ses")] });
    expect(outcome).toEqual({ messageId: "sns-ses", topic: "AUTH_MAIL", actions: ["SIGNUP_KILLED"] });
    expect(await r.signupKilled()).toBe(true);
    expect(await r.connector.runtime.isAgentKilled("demo")).toBe(false);
    expect(await r.audits("SIGNUP_KILLED")).toEqual([expect.objectContaining({ refs: { snsMessageId: "sns-ses", source: "SES_COMPLAINT_RATE" } })]);
    expect(await r.audits("AGENT_KILLED")).toEqual([]);
  });

  it("[FL-109] the bounce-rate alarm does the same; its return to OK changes nothing", async () => {
    const r = rig();
    const bounce = `${APP.name}-poc-SesBounceRate`;
    const [ok] = await breakOnAlerts(r.deps, { Records: [record(AUTH_MAIL_TOPIC, alarm(bounce, "Reputation.BounceRate", "OK"))] });
    expect(ok).toMatchObject({ actions: [], ignored: "OK_STATE" });
    expect(await r.signupKilled()).toBe(false);
    const [alarmed] = await breakOnAlerts(r.deps, { Records: [record(AUTH_MAIL_TOPIC, alarm(bounce, "Reputation.BounceRate"), "sns-bounce")] });
    expect(alarmed).toMatchObject({ actions: ["SIGNUP_KILLED"] });
    expect(await r.signupKilled()).toBe(true);
  });

  it("[FL-109] refuses another alarm, another metric, a budget text or a message that is not JSON on the auth-mail topic", async () => {
    const r = rig();
    const messages = [
      alarm("other-app-poc-SesComplaintRate", "Reputation.ComplaintRate"),
      alarm(`${APP.name}-poc-SesComplaintRate`, "Bounce"),
      BUDGET_TEXT,
      "not json",
    ];
    const outcomes = await breakOnAlerts(r.deps, { Records: messages.map((message, index) => record(AUTH_MAIL_TOPIC, message, `sns-${index}`)) });
    expect(outcomes.map((outcome) => outcome.ignored)).toEqual(["UNRECOGNIZED_MESSAGE", "UNRECOGNIZED_MESSAGE", "UNRECOGNIZED_MESSAGE", "UNRECOGNIZED_MESSAGE"]);
    expect(await r.signupKilled()).toBe(false);
    expect(await r.connector.runtime.isAgentKilled("demo")).toBe(false);
  });
});

describe("BudgetBreaker: what it never trusts", () => {
  it("refuses another topic, a record that is not SNS and an event that is not an SNS batch", async () => {
    const r = rig();
    const foreign = record(`arn:aws:sns:us-east-1:${ACCOUNT}:another-app-budget-alerts`, BUDGET_TEXT);
    const notSns = { ...record(BUDGET_TOPIC, BUDGET_TEXT), EventSource: "aws:sqs" };
    expect((await breakOnAlerts(r.deps, { Records: [foreign, notSns] })).map((outcome) => outcome.ignored)).toEqual(["UNKNOWN_TOPIC", "INVALID_RECORD"]);
    expect(await breakOnAlerts(r.deps, { detail: "x" })).toEqual([]);
    expect(await r.connector.runtime.isAgentKilled("demo")).toBe(false);
    expect(await r.signupKilled()).toBe(false);
    expect(r.lines.filter((line) => line.message === "budget_breaker.refused")).toHaveLength(3);
  });
});
