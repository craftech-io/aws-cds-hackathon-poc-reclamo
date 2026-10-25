/// <reference path="../../../../bff/sst-env.d.ts" />
// The QA self-signup of the deployed stage (docs/architecture-guests.md §3-§4, docs/test-plan.md SC-24),
// run from `sst shell --stage poc` with the operator's profile: the real sign-up service, Cognito and the
// deployed triggers through the `QaDriver` (`guest.signup`, `guest.confirm`, `guest.session`) with the
// run's own address `success+qa-<runId>-su1@simulator.amazonses.com`, so the world is `qa-<runId>-su1`
// and the lead a `QALEAD#` that is never notified nor exported; and `notice.probe`, the lead notice's real
// SES transport to the mailbox simulator only. Then reads only: the QA lead, the month's lead-notice audit
// counts (the visitors' and the probe's), and whether the notice mailbox is a @craftech.io one (a boolean,
// never the value). Nothing here prints an address, a token or a secret; the passwords never leave the Lambda.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetCommand, QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { type QaActionName, QaResponseSchema } from "@reclamo/bff/qa-driver/contract";
import { dynamoDocumentClient } from "@reclamo/bff/lib/clients";
import { tableName } from "@reclamo/bff/lib/resource";
import { secretValue } from "@reclamo/bff/lib/secrets";
import { leadNoticeRecipient } from "@reclamo/bff/leads/notice";
import { Lead, isTestLead } from "@reclamo/bff/leads/records";

/** infra/bff.ts `qaDriverName`: the function and its role have a fixed name. */
const QA_DRIVER = "aws-cds-hackathon-poc-reclamo-poc-qa-driver";
const KEY = "su1";
/** The scenario slug the driver's idempotency keys accept for a self-signup (SC-24's). */
const SLUG = "sc24";

export interface GuestTokens {
  readonly idToken: string;
  readonly accessToken: string;
  readonly exp: number;
  readonly worldStatus: string | null;
}

/** `<UTC yyyymmddhhmmss>-1`: the driver's run id (`^\d{1,20}-\d{1,3}$`). */
export function newRunId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/\D/g, "").slice(0, 14)}-1`;
}

export const worldOf = (runId: string): string => `qa-${runId}-${KEY}`;

const lambda = new LambdaClient({ region: "us-east-1", maxAttempts: 1, requestHandler: new NodeHttpHandler({ requestTimeout: 120_000, connectionTimeout: 5_000 }) });

/** One driver action of the run; a refusal throws with its code and reason only (never the input). */
async function qa(action: QaActionName, runId: string, input: unknown, step: number, label: string): Promise<unknown> {
  const payload = JSON.stringify({ action, idempotencyKey: `${runId}/${SLUG}/${step}/${label}`, input });
  const answer = await lambda.send(new InvokeCommand({ FunctionName: QA_DRIVER, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(payload) }));
  if (answer.FunctionError) throw new Error(`${action}: the QA driver failed (${answer.FunctionError})`);
  const parsed = QaResponseSchema.parse(JSON.parse(new TextDecoder().decode(answer.Payload ?? new Uint8Array())));
  if (!parsed.ok) throw new Error(`${action}: ${parsed.error.code} ${parsed.error.reason ?? ""}`.trim());
  return parsed.result;
}

/** The campaign of the run's visit, as the landing's link would carry it (`utm_source=qa`). */
export const QA_UTM = { source: "qa", medium: "e2e", campaign: "surfaces" } as const;

/** `guest.signup` (locale es, contact consent given, the run's campaign): the signupId of the code the account waits for. */
export async function signUp(runId: string): Promise<string> {
  const result = (await qa("guest.signup", runId, { runId, key: KEY, locale: "es", acceptContact: true, utm: QA_UTM }, 1, "signup")) as { status: string; signupId?: string };
  if (result.status !== "CODE_SENT" || result.signupId === undefined) throw new Error(`guest.signup answered ${result.status}`);
  return result.signupId;
}

/** `guest.confirm` without a code: `AdminConfirmSignUp` and the real post-confirmation trigger. */
export async function confirm(runId: string, signupId: string): Promise<string> {
  const result = (await qa("guest.confirm", runId, { runId, key: KEY, signupId }, 2, "confirm")) as { status: string; worldStatus?: string };
  if (result.status !== "CONFIRMED") throw new Error(`guest.confirm answered ${result.status}`);
  return result.worldStatus ?? "UNKNOWN";
}

/** A fresh SRP sign-in of the account (a new password inside the Lambda); `attempt` keeps each call new. */
export async function session(runId: string, attempt: number): Promise<GuestTokens> {
  return (await qa("guest.session", runId, { runId, key: KEY }, 3, `s${attempt}`)) as GuestTokens;
}

/** `notice.probe`: the real lead notice of a synthetic QA lead, through SES, to the mailbox simulator only. */
export async function noticeProbe(runId: string): Promise<{ readonly outcome: string; readonly recipient: string }> {
  return (await qa("notice.probe", runId, {}, 4, "probe")) as { outcome: string; recipient: string };
}

export function claimOf(token: string, name: string): unknown {
  const payload = token.split(".")[1] ?? "";
  return Reflect.get(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as object, name);
}

/** The QA lead of the run (`QALEAD#<runId>#<sub>`), parsed by the table's own schema. */
export async function readLead(runId: string, sub: string): Promise<Lead | undefined> {
  const answer = await dynamoDocumentClient().send(new GetCommand({ TableName: tableName("Leads"), Key: { pk: `QALEAD#${runId}#${sub}`, sk: "META" }, ConsistentRead: true }));
  return answer.Item ? Lead.parse(answer.Item) : undefined;
}

export interface NoticeEvidence {
  /** `LEAD_NOTICE_SENT` entries of the month (real visitors' leads). */
  readonly sent: number;
  /** `LEAD_NOTICE_SKIPPED` entries by outcome (QA_LEAD, NOT_CONFIGURED, DAILY_CAP…). */
  readonly skipped: Readonly<Record<string, number>>;
  readonly lastSentAt?: string;
  /** Whether `LeadNotifyEmail` holds a @craftech.io mailbox (the value is never read out). */
  readonly mailboxIsCraftech: boolean;
}

/** Action, outcome and instant of the month's lead-notice entries of one audit partition (no refs). */
async function noticeEntries(partition: string): Promise<Array<Record<string, unknown>>> {
  const client = dynamoDocumentClient();
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page: QueryCommandOutput = await client.send(
      new QueryCommand({
        TableName: tableName("AuditLog"),
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "begins_with(#action, :notice)",
        ExpressionAttributeNames: { "#action": "action", "#ts": "ts", "#outcome": "outcome" },
        ExpressionAttributeValues: { ":pk": partition, ":notice": "LEAD_NOTICE_" },
        ProjectionExpression: "#action, #outcome, #ts",
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

/** The month's lead-notice audit of the public edge (`SIGNUP#AUD#<yyyy-mm>`): counts only, no refs. */
export async function noticeEvidence(month: string): Promise<NoticeEvidence> {
  let sent = 0;
  let lastSentAt: string | undefined;
  const skipped: Record<string, number> = {};
  for (const item of await noticeEntries(`SIGNUP#AUD#${month}`)) {
    if (item.action === "LEAD_NOTICE_SENT") {
      sent += 1;
      if (typeof item.ts === "string" && (lastSentAt === undefined || item.ts > lastSentAt)) lastSentAt = item.ts;
    } else {
      const outcome = String(item.outcome ?? "UNKNOWN");
      skipped[outcome] = (skipped[outcome] ?? 0) + 1;
    }
  }
  return { sent, skipped, ...(lastSentAt ? { lastSentAt } : {}), mailboxIsCraftech: leadNoticeRecipient(secretValue("LeadNotifyEmail")) !== undefined };
}

/** `LEAD_NOTICE_PROBE` entries the runner's `notice.probe` left this month (`SIGNUP#AUD#QA#<yyyy-mm>`), by outcome. */
export async function probeEvidence(month: string): Promise<Readonly<Record<string, number>>> {
  const outcomes: Record<string, number> = {};
  for (const item of await noticeEntries(`SIGNUP#AUD#QA#${month}`)) {
    if (item.action !== "LEAD_NOTICE_PROBE") continue;
    const outcome = String(item.outcome ?? "UNKNOWN");
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return outcomes;
}

/** The lead without its address (a mailbox-simulator one, still never written out) and with its sub shortened. */
export function redactLead(lead: Lead): Record<string, unknown> {
  const { email: _email, sub, emailHash: _hash, ...rest } = lead;
  return { ...rest, email: "[redacted: SES mailbox simulator address of the run]", sub: `${sub.slice(0, 8)}…`, test: isTestLead(lead) };
}
