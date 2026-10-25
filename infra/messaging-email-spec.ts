// Amazon SES of the app as plain data and pure functions: OUTBOUND ONLY (ADR-0003; docs/architecture.md
// §1, §2 and §14; docs/architecture-integrations.md §1-§2; docs/architecture-guests.md §2, §9 and §12;
// docs/build-plan.md WP-18). No SST or Pulumi dependency: infra/messaging-email.ts turns this file into
// resources and infra/messaging-email-spec.test.ts checks every value against the docs, infra/dns.ts,
// the CI bootstrap and infra/iam-capabilities.ts.
//
// What exists: the domain identity with Easy DKIM (three CNAMEs), the DMARC TXT `p=reject`, the
// configuration set `<app>-email-<stage>` with its EventBridge destination (the rule towards
// `EmailEvents` belongs to infra/workers.ts, WP-20), the sending authorization policy of the identity
// for Cognito, and the send statements of the two senders of the app (`SEND_EMAIL` of the outbound
// gate, `SEND_LEAD_NOTICE` of `LeadNotifier`). What never exists: a receipt rule, a rule set, a receipt
// filter, a custom MAIL FROM (it needs an MX) or an MX record (`npm run lint:no-ses-receiving`).

import { CAPABILITIES, LAMBDA_CAPABILITIES } from "./iam-capabilities";

/** SES of the stage (docs/architecture.md §1). */
export const SES_REGION = "us-east-1";

/** Account and region an ARN belongs to (infra/messaging-email.ts resolves them from the caller identity). */
export interface Place {
  readonly account: string;
  readonly region: string;
}

export function assertSesRegion(region: string): void {
  if (region !== SES_REGION) throw new Error(`SES of this app lives in ${SES_REGION} (docs/architecture.md §1); the provider points at ${region}.`);
}

// ---- Domain and senders --------------------------------------------------------------------------

/** Sending identity: the app's own domain, never a subdomain or another demo of the shared zone. */
export const EMAIL_DOMAIN = "reclamo.demo.craftech.io";
/** Written answers and certificates of the outbound gate (docs/architecture-integrations.md §1). */
export const ANSWERS_FROM_ADDRESS = `respuestas@${EMAIL_DOMAIN}`;
/** Cognito's emails (staff invitations, guest codes) and the lead notice (docs/architecture-guests.md §9). */
export const NO_REPLY_FROM_ADDRESS = `no-reply@${EMAIL_DOMAIN}`;
/** SES mailbox simulator: the only recipients of every world but `demo` (docs/architecture.md §13). */
export const SES_SIMULATOR_DOMAIN = "simulator.amazonses.com";
/** Team mailboxes: the demo recipients of `SeedOverrides` and the lead notice (`LeadNotifyEmail`). */
export const TEAM_DOMAIN = "craftech.io";

export interface EmailAddresses {
  readonly domain: string;
  readonly answersFrom: string;
  readonly noReplyFrom: string;
}

/** infra/dns.ts names the same domain and senders for the Router and Cognito; a drift fails the deploy. */
export function assertEmailAddresses(fromDns: EmailAddresses): void {
  const expected: EmailAddresses = { domain: EMAIL_DOMAIN, answersFrom: ANSWERS_FROM_ADDRESS, noReplyFrom: NO_REPLY_FROM_ADDRESS };
  for (const key of Object.keys(expected) as Array<keyof EmailAddresses>) {
    if (fromDns[key] !== expected[key]) throw new Error(`infra/dns.ts names the ${key} ${fromDns[key]}, but SES uses ${expected[key]}.`);
  }
}

// ---- DNS records -----------------------------------------------------------------------------------

export const DNS_TTL_SECONDS = 300;
/** Easy DKIM always issues three tokens; each one becomes a CNAME under `_domainkey`. */
export const DKIM_TOKEN_COUNT = 3;
export const DKIM_KEY_LENGTH = "RSA_2048_BIT";
/** `p=reject`: nobody sends as us. Without a MAIL FROM of our own, DMARC passes through aligned DKIM. */
export const DMARC_VALUE = "v=DMARC1; p=reject; adkim=r; aspf=r";

/** Record types this module writes; the CI role allows A, AAAA, CNAME and TXT and denies MX. */
export type EmailRecordType = "CNAME" | "TXT";

export interface EmailRecordSpec {
  readonly logicalName: string;
  readonly type: EmailRecordType;
  readonly name: string;
  readonly records: readonly string[];
}

export const DMARC_RECORD: EmailRecordSpec = { logicalName: "EmailDmarc", type: "TXT", name: `_dmarc.${EMAIL_DOMAIN}`, records: [DMARC_VALUE] };

export function dkimRecord(index: number, token: string): EmailRecordSpec {
  if (!Number.isInteger(index) || index < 0 || index >= DKIM_TOKEN_COUNT) throw new Error(`a DKIM record index is 0..${DKIM_TOKEN_COUNT - 1}`);
  if (!/^[a-z0-9]{16,64}$/.test(token)) throw new Error("a DKIM token is 16 to 64 lowercase letters and digits");
  return { logicalName: `EmailDkimRecord${index}`, type: "CNAME", name: `${token}._domainkey.${EMAIL_DOMAIN}`, records: [`${token}.dkim.amazonses.com`] };
}

/** The CI role changes only `reclamo.demo.craftech.io` and `*.reclamo.demo.craftech.io` (docs/architecture.md §2). */
export function insideAppDomain(recordName: string): boolean {
  const name = recordName.toLowerCase().replace(/\.$/, "");
  return name === EMAIL_DOMAIN || name.endsWith(`.${EMAIL_DOMAIN}`);
}

// ---- Configuration set and events ------------------------------------------------------------------

/** `<app>-email-<stage>`: a fixed name, fenced by name in the CI role and in `ses:SendEmail`. */
export const configurationSetName = (app: string, stage: string): string => `${app}-email-${stage}`;

/**
 * TLS required towards the receiving MTA; reputation metrics on (bounce and complaint rates of the set);
 * bounces and complaints suppressed; no open or click tracking (no pixel, no rewritten link).
 */
export const CONFIGURATION_SET = {
  logicalName: "EmailConfigurationSet",
  tlsPolicy: "REQUIRE",
  reputationMetrics: true,
  suppressedReasons: ["BOUNCE", "COMPLAINT"],
} as const;

export const EMAIL_EVENT_DESTINATION = { logicalName: "EmailConfigurationSetEvents", name: "eventbridge" } as const;

// Events `EmailEvents` consumes (docs/architecture-integrations.md §2): `sesType` for the destination,
// `detailType` as EventBridge shows it. No OPEN or CLICK: they would switch tracking on.
export const EMAIL_EVENTS = [
  { sesType: "SEND", detailType: "Email Sent" },
  { sesType: "DELIVERY", detailType: "Email Delivered" },
  { sesType: "BOUNCE", detailType: "Email Bounced" },
  { sesType: "COMPLAINT", detailType: "Email Complaint Received" },
  { sesType: "REJECT", detailType: "Email Rejected" },
  { sesType: "DELIVERY_DELAY", detailType: "Email Delivery Delayed" },
  { sesType: "RENDERING_FAILURE", detailType: "Email Rendering Failed" },
] as const;

/** SES publishes configuration set events to the account's default bus only. */
export const defaultEventBusArn = (place: Place): string => `arn:aws:events:${place.region}:${place.account}:event-bus/default`;

export interface EmailEventPattern {
  readonly source: string[];
  readonly "detail-type": string[];
  readonly detail: { readonly mail: { readonly tags: { readonly "ses:configuration-set": string[] } } };
}

/** The rule infra/workers.ts puts on the shared default bus: SES events of OUR set and nothing else. */
export function emailEventPattern(configurationSet: string): EmailEventPattern {
  return {
    source: ["aws.ses"],
    "detail-type": EMAIL_EVENTS.map((event) => event.detailType),
    detail: { mail: { tags: { "ses:configuration-set": [configurationSet] } } },
  };
}

export const sesIdentityArn = (place: Place): string => `arn:aws:ses:${place.region}:${place.account}:identity/${EMAIL_DOMAIN}`;
export const sesConfigurationSetArn = (place: Place, name: string): string => `arn:aws:ses:${place.region}:${place.account}:configuration-set/${name}`;

// ---- Send statements (docs/architecture.md §14, docs/architecture-guests.md §12) -------------------

export interface StatementCondition {
  readonly test: string;
  readonly variable: string;
  readonly values: string[];
}

/** The shape `sst.aws.permission` takes. */
export interface SendStatement {
  readonly actions: string[];
  readonly resources: string[];
  readonly conditions: StatementCondition[];
}

/** `ses:SendEmail` of SES v2; `Content.Raw` is authorized as `ses:SendRawEmail` (the v1 API is never called); never a wildcard. */
export const SEND_ACTIONS: readonly string[] = CAPABILITIES.SEND_EMAIL.actions;
export const LEAD_NOTICE_ACTIONS: readonly string[] = LAMBDA_CAPABILITIES.LeadNotifier.actions;

/** Recipients IAM lets the gate reach; the exact demo addresses are a fence of code only (§14). */
export const SEND_EMAIL_RECIPIENTS = [`*@${SES_SIMULATOR_DOMAIN}`, `*@${TEAM_DOMAIN}`] as const;
/** `*@craftech.io` never matches a subdomain (`x@mail.craftech.io` ends otherwise). */
export const LEAD_NOTICE_RECIPIENTS = [`*@${TEAM_DOMAIN}`] as const;

// With `Content.Raw` SES may leave `ses:Recipients` and `ses:FromAddress` empty; a `ForAllValues`
// condition over an empty set passes, so a request without either key is denied by the `Null` guards.
function fencedSend(fromAddress: string, recipients: readonly string[]): StatementCondition[] {
  return [
    { test: "StringEquals", variable: "ses:FromAddress", values: [fromAddress] },
    { test: "ForAllValues:StringLike", variable: "ses:Recipients", values: [...recipients] },
    { test: "Null", variable: "ses:Recipients", values: ["false"] },
    { test: "Null", variable: "ses:FromAddress", values: ["false"] },
  ];
}

/**
 * `SEND_EMAIL` (holders of `PIPELINE`): the identity AND the app's configuration set, from `respuestas@`.
 * The customer emails go as `Content.Raw`, authorized as `ses:SendRawEmail`; SES may leave `ses:FromAddress`
 * and `ses:Recipients` empty for them, so the keys are checked when SES fills them, and the single recipient
 * is fenced in code (channels/email/outbound.ts, `assertSingleRecipient`).
 */
export function sendEmailStatement(place: Place, configurationSet: string): SendStatement {
  return {
    actions: [...SEND_ACTIONS],
    resources: [sesIdentityArn(place), sesConfigurationSetArn(place, configurationSet)],
    conditions: [
      { test: "StringEqualsIfExists", variable: "ses:FromAddress", values: [ANSWERS_FROM_ADDRESS] },
      { test: "ForAllValues:StringLike", variable: "ses:Recipients", values: [...SEND_EMAIL_RECIPIENTS] },
    ],
  };
}

/** `SEND_LEAD_NOTICE` (`LeadNotifier`): the identity only (the notice names no set), from `no-reply@` to the team. */
export function leadNoticeStatement(place: Place): SendStatement {
  return {
    actions: [...LEAD_NOTICE_ACTIONS],
    resources: [sesIdentityArn(place)],
    conditions: fencedSend(NO_REPLY_FROM_ADDRESS, LEAD_NOTICE_RECIPIENTS),
  };
}

/** The one recipient of the QaDriver's `notice.probe`: the SES mailbox simulator's `success@`, never a person. */
export const LEAD_NOTICE_PROBE_RECIPIENT = `success@${SES_SIMULATOR_DOMAIN}`;

/** From `no-reply@` to the simulator's one address only (`notice.probe`). */
export function leadNoticeProbeConditions(): StatementCondition[] {
  return fencedSend(NO_REPLY_FROM_ADDRESS, [LEAD_NOTICE_PROBE_RECIPIENT]);
}

/** `notice.probe` (QaDriver): the lead notice's statement with the simulator's one address as the only recipient. */
export function leadNoticeProbeStatement(place: Place): SendStatement {
  return { ...leadNoticeStatement(place), conditions: leadNoticeProbeConditions() };
}

/** Logical name of the Linkable that carries `SEND_EMAIL` and names the set and the sender. */
export const EMAIL_SENDER_LINK = "EmailSender";

// ---- Sending authorization of the identity for Cognito (ADR-0020, docs/architecture-guests.md §12) ----

/** Service principal Cognito uses to send through an SES identity of its own Region. */
export const COGNITO_EMAIL_PRINCIPAL = "email.cognito-idp.amazonaws.com";
/** Name of the policy on the identity (the staff-only `cognito-staff-invitations` of WP-08 is replaced). */
export const COGNITO_MAIL_POLICY_NAME = "cognito-user-pool-mail";
export const COGNITO_SEND_ACTIONS = ["ses:SendEmail", "ses:SendRawEmail"] as const;

/** The exact ARN of ONE user pool of this account and region: never a wildcard, never another account. */
export function assertExactUserPoolArn(place: Place, userPoolArn: string): void {
  const prefix = `arn:aws:cognito-idp:${place.region}:${place.account}:userpool/`;
  const id = userPoolArn.startsWith(prefix) ? userPoolArn.slice(prefix.length) : "";
  if (!new RegExp(`^${place.region}_[A-Za-z0-9]{1,55}$`).test(id)) {
    throw new Error(`the Cognito sending policy needs the exact ARN of the user pool in ${place.region} of this account, not "${userPoolArn}"`);
  }
}

export interface CognitoMailPolicyScope extends Place {
  readonly userPoolArn: string;
}

/**
 * Lets Cognito send as `no-reply@` for this pool only: `aws:SourceAccount`, `ArnEquals aws:SourceArn` =
 * the pool's exact ARN and `ses:FromAddress`. No recipient condition: a self-signup guest receives
 * their code at their own address, and the code fences who gets one (docs/architecture-guests.md §7).
 *
 * The same document in both phases of the pool's sender (docs/architecture-guests.md §2): phase 1
 * (`COGNITO_DEFAULT`, DKIM not SUCCESS yet) and phase 2 (`DEVELOPER`). infra/messaging-email.ts builds
 * it in EVERY deploy from the pool's own ARN, so the policy always predates phase 2: a deploy only
 * enters phase 2 when the identity was already verified when it started, and the deploy that created
 * the identity created this policy with it. The pool never waits for the policy (that would close a
 * cycle with the ARN), and no lookup by name is needed: the pool's physical name is generated by SST.
 */
export function cognitoMailPolicy(scope: CognitoMailPolicyScope) {
  assertExactUserPoolArn(scope, scope.userPoolArn);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CognitoUserPoolMail",
        Effect: "Allow",
        Principal: { Service: COGNITO_EMAIL_PRINCIPAL },
        Action: [...COGNITO_SEND_ACTIONS],
        Resource: sesIdentityArn(scope),
        Condition: {
          StringEquals: { "aws:SourceAccount": scope.account, "ses:FromAddress": NO_REPLY_FROM_ADDRESS },
          ArnEquals: { "aws:SourceArn": scope.userPoolArn },
        },
      },
    ],
  } as const;
}
