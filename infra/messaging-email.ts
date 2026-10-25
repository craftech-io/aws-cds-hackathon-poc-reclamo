// Email channel: Amazon SES v2, OUTBOUND ONLY (ADR-0003; docs/architecture.md §1, §2, §14 and §15;
// docs/architecture-integrations.md §1-§2; docs/architecture-guests.md §2 and §12; docs/build-plan.md
// WP-18). Names, records, events and IAM documents live in infra/messaging-email-spec.ts (checked by
// messaging-email-spec.test.ts); this module only turns them into resources:
//
//   - domain identity `reclamo.demo.craftech.io` with Easy DKIM (RSA 2048, three CNAMEs in the zone).
//     No MAIL FROM of our own (it needs an MX): DMARC passes through aligned DKIM. The identity names
//     no default configuration set, so Cognito's emails go out without one (no header with the app id);
//   - `_dmarc.reclamo.demo.craftech.io` TXT `p=reject`;
//   - configuration set `<app>-email-<stage>` (TLS required, reputation metrics, bounces and complaints
//     suppressed, no open or click tracking) with its events to the default EventBridge bus. The rule
//     towards `EmailEvents` belongs to infra/workers.ts (WP-20), owner of the Function, and takes its
//     pattern from `emailEventPattern` of the spec;
//   - `EmailSender`: the Linkable a holder of `PIPELINE` links; it names the set and the sender and
//     carries `SEND_EMAIL`, fenced by FROM, recipients and set (docs/architecture.md §14);
//   - the sending authorization policy of the identity for Cognito (`email.cognito-idp.amazonaws.com`):
//     this account, the exact ARN of the console pool, `no-reply@` as FROM, no recipient fence
//     (docs/architecture-guests.md §12). Built in every deploy from the pool's own ARN, so it exists
//     before the pool switches to `DEVELOPER`; the pool never depends on it (see the spec).
//
// Nothing here receives email: no receipt rule, rule set, filter, MAIL FROM or MX
// (`npm run lint:no-ses-receiving`; the CI role denies all of them and `MX` records).
//
// Why `aws.sesv2.*` and not `sst.aws.Email`: the component waits for DKIM inside the deploy (hours in a
// delegated zone), binds its own configuration set and links `ses:*`. DKIM is checked after the deploy;
// until it reads SUCCESS the smoke warns, the pool keeps Cognito's default sender and the email
// scenarios wait (docs/architecture.md §15 step 6, §16).
//
// Verify (reads only, docs/architecture.md §15 step 6):
//   aws --profile craftech-demos sesv2 get-email-identity --email-identity reclamo.demo.craftech.io
//     DkimAttributes.Status = SUCCESS · ConfigurationSetName absent · MailFromAttributes default
//   aws --profile craftech-demos sesv2 get-email-identity-policies --email-identity reclamo.demo.craftech.io
//     only cognito-user-pool-mail, ArnEquals aws:SourceArn = the pool's ARN
//   aws --profile craftech-demos sesv2 get-configuration-set-event-destinations --configuration-set-name aws-cds-hackathon-poc-reclamo-email-poc
//   dig +short TXT _dmarc.reclamo.demo.craftech.io     "v=DMARC1; p=reject; adkim=r; aspf=r"
//   dig +short MX reclamo.demo.craftech.io             (empty)

import { ZONE_ID, answersFromAddress, appDomain, noReplyFromAddress } from "./dns";
import {
  ANSWERS_FROM_ADDRESS,
  COGNITO_MAIL_POLICY_NAME,
  CONFIGURATION_SET,
  DKIM_KEY_LENGTH,
  DKIM_TOKEN_COUNT,
  DMARC_RECORD,
  DNS_TTL_SECONDS,
  EMAIL_DOMAIN,
  EMAIL_EVENTS,
  EMAIL_EVENT_DESTINATION,
  EMAIL_SENDER_LINK,
  SEND_ACTIONS,
  SES_REGION,
  assertEmailAddresses,
  assertSesRegion,
  cognitoMailPolicy,
  configurationSetName,
  defaultEventBusArn,
  dkimRecord,
  sendEmailStatement,
  type EmailRecordSpec,
  type Place,
} from "./messaging-email-spec";

assertEmailAddresses({ domain: appDomain, answersFrom: answersFromAddress, noReplyFrom: noReplyFromAddress });

/** Account and region of the stage; the deploy fails if the provider is not in SES's region. */
export const emailPlace: $util.Output<Place> = $util
  .all([aws.getCallerIdentityOutput({}).accountId, aws.getRegionOutput({}).region])
  .apply(([account, region]) => {
    assertSesRegion(region);
    return { account, region };
  });

/** `<app>-email-<stage>`, the name the CI role and every `ses:SendEmail` statement fence. */
export const emailConfigurationSetName = configurationSetName($app.name, $app.stage);

// ---- Identity, DKIM and DMARC -----------------------------------------------------------------------

export const emailIdentity = new aws.sesv2.EmailIdentity("EmailIdentity", {
  emailIdentity: EMAIL_DOMAIN,
  dkimSigningAttributes: { nextSigningKeyLength: DKIM_KEY_LENGTH },
});

function dnsRecord(spec: $util.Output<EmailRecordSpec> | EmailRecordSpec, logicalName: string): aws.route53.Record {
  const record = $util.output(spec);
  return new aws.route53.Record(logicalName, {
    zoneId: ZONE_ID,
    type: record.type,
    name: record.name,
    ttl: DNS_TTL_SECONDS,
    records: record.records.apply((values) => [...values]),
  });
}

// Easy DKIM: the three tokens exist as soon as the identity does, so the records resolve after it.
export const dkimRecords = Array.from({ length: DKIM_TOKEN_COUNT }, (_, index) =>
  dnsRecord(
    emailIdentity.dkimSigningAttributes.apply((attributes) => {
      const token = attributes.tokens[index];
      if (token === undefined) throw new Error(`SES returned fewer than ${DKIM_TOKEN_COUNT} DKIM tokens for ${EMAIL_DOMAIN}`);
      return dkimRecord(index, token);
    }),
    `EmailDkimRecord${index}`,
  ),
);

export const dmarcRecord = dnsRecord(DMARC_RECORD, DMARC_RECORD.logicalName);

// ---- Configuration set and events -------------------------------------------------------------------

export const emailConfigurationSet = new aws.sesv2.ConfigurationSet(CONFIGURATION_SET.logicalName, {
  configurationSetName: emailConfigurationSetName,
  deliveryOptions: { tlsPolicy: CONFIGURATION_SET.tlsPolicy },
  reputationOptions: { reputationMetricsEnabled: CONFIGURATION_SET.reputationMetrics },
  sendingOptions: { sendingEnabled: true },
  suppressionOptions: { suppressedReasons: [...CONFIGURATION_SET.suppressedReasons] },
});

export const emailEventDestination = new aws.sesv2.ConfigurationSetEventDestination(EMAIL_EVENT_DESTINATION.logicalName, {
  configurationSetName: emailConfigurationSet.configurationSetName,
  eventDestinationName: EMAIL_EVENT_DESTINATION.name,
  eventDestination: {
    enabled: true,
    matchingEventTypes: EMAIL_EVENTS.map((event) => event.sesType),
    eventBridgeDestination: { eventBusArn: emailPlace.apply(defaultEventBusArn) },
  },
});

// ---- Sender of the outbound gate ----------------------------------------------------------------------

const sendEmail = emailPlace.apply((place) => sendEmailStatement(place, emailConfigurationSetName));

// SST builds a role's policy from each permission's `resources` as a list: one Output holding the whole
// array reaches IAM as a statement with no Resource ("Policy statement must contain resources"). Each
// ARN therefore goes as its own Output; the count comes from the same builder with a placeholder place
// and is checked again when the Output resolves.
const SEND_EMAIL_RESOURCE_COUNT = sendEmailStatement({ account: "000000000000", region: SES_REGION }, emailConfigurationSetName).resources.length;
const sendEmailResources = Array.from({ length: SEND_EMAIL_RESOURCE_COUNT }, (_, index) =>
  sendEmail.apply(({ resources }) => {
    const arn = resources[index];
    if (resources.length !== SEND_EMAIL_RESOURCE_COUNT || arn === undefined) throw new Error(`SEND_EMAIL expects ${SEND_EMAIL_RESOURCE_COUNT} ARN(s), got ${resources.length}.`);
    return arn;
  }),
);

/** `Resource.EmailSender.{identity, configurationSet, fromAddress}`; linking it grants `SEND_EMAIL` only. */
export const emailSender = new sst.Linkable(EMAIL_SENDER_LINK, {
  properties: { identity: EMAIL_DOMAIN, configurationSet: emailConfigurationSet.configurationSetName, fromAddress: ANSWERS_FROM_ADDRESS },
  include: [
    sst.aws.permission({
      actions: [...SEND_ACTIONS],
      resources: sendEmailResources,
      conditions: sendEmail.conditions,
    }),
  ],
});

// ---- Cognito's sending authorization ------------------------------------------------------------------

// The pool belongs to infra/auth.ts, which sst.config.ts evaluates before this module. A dynamic import
// settles once that module has run and never closes a static import cycle (infra/late-links.ts).
const userPoolArn: $util.Output<string> = $util.output(import("./auth").then((module) => module.userPool.arn));

export const cognitoMailAuthorization = new aws.sesv2.EmailIdentityPolicy("CognitoMailPolicy", {
  emailIdentity: emailIdentity.emailIdentity,
  policyName: COGNITO_MAIL_POLICY_NAME,
  policy: $util.all([emailPlace, userPoolArn]).apply(([place, arn]) => JSON.stringify(cognitoMailPolicy({ ...place, userPoolArn: arn }))),
});
