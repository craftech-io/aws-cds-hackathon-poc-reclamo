// Fixed values of the outbound email channel (docs/architecture-integrations.md §1-§2,
// docs/architecture.md §1, §6): the sender, the configuration set, the SES mailbox simulator, the
// limits of one email and the abuse caps on the real clock. Names that depend on the stage are built
// from the app and stage SST links in (`Resource.App`), never read from the environment.
import { EMAIL_TEXT } from "../../copy";
import type { ClientTimeouts } from "../../lib/clients";

/** Domain of the app's SES identity; the only `From` of a customer email is `respuestas@` there. */
export const APP_MAIL_DOMAIN = "reclamo.demo.craftech.io";
export const ANSWERS_ADDRESS = `respuestas@${APP_MAIL_DOMAIN}`;
/** Display name of the sender (copy/es-AR.ts); RFC 2047-encoded in the MIME because of the "í". */
export const SENDER_DISPLAY_NAME = EMAIL_TEXT.FROM_NAME;

/** `aws-cds-hackathon-poc-reclamo-email-poc`: the configuration set every customer email names. */
export function configurationSetName(app: string, stage: string): string {
  return `${app}-email-${stage}`;
}

/** SES's mailbox simulator (docs/seed-spec.md §5): events without touching the account's reputation. */
export const SES_SIMULATOR_DOMAIN = "simulator.amazonses.com";
export const SES_SIMULATOR_MAILBOXES = ["success", "bounce", "ooto", "complaint", "suppressionlist"] as const;
export type SimulatorMailbox = (typeof SES_SIMULATOR_MAILBOXES)[number];
/** The optional `+<label>` of a simulator address: `<worldId>-<customerId>`, `qa-<runId>-<scenario>-<key>`. */
export const SIMULATOR_LABEL = /^[a-z0-9-]{1,40}$/;

/** Real team inboxes of `SeedOverrides.demoRecipients.emails`: at most five, only this domain, only from `demo`. */
export const DEMO_RECIPIENT_DOMAIN = "craftech.io";
export const MAX_DEMO_RECIPIENTS = 5;
/** The only world whose emails may reach a demo recipient. */
export const DEMO_WORLD = "demo";

/** Attachments decided by complaints/answer.ts: at most five PDFs, 2 MB in total. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENTS_BYTES = 2 * 1024 * 1024;
export const PDF_CONTENT_TYPE = "application/pdf";
export const ATTACHMENT_FILENAME = /^[A-Za-z0-9._-]{1,100}\.pdf$/;

/** Our headers (an `X-Reclamo-Mail-Id` lets the viewer and QA find the exact `.eml`). */
export const MAIL_ID_HEADER = "X-Reclamo-Mail-Id";
export const WORLD_HEADER = "X-Reclamo-World";

/** `ses:SendEmail` per world and real hour (`W#<w>#RATE#EMAIL#<realHour>`). */
export const EMAILS_PER_WORLD_HOUR = 200;
/** Emails to real demo recipients per real day, in total (only `demo` reaches them). */
export const DEMO_RECIPIENT_EMAILS_PER_DAY = 20;
/** Segments of the `RATE#` buckets of the email caps (connector/repos/caps.ts). */
export const EMAIL_RATE_SEGMENT = "EMAIL";
export const DEMO_RECIPIENT_RATE_SEGMENT = "DEMORCPT";

/**
 * Budget of one `SendEmail`. SES has no idempotency key, so the SDK must not retry on its own (a retry
 * after a timeout could deliver twice): one SDK attempt, and channels/email/outbound.ts retries only
 * the throttling answers, which SES gives before accepting anything. The transport that builds the
 * `SESv2Client` (outbound/transports/) uses these values.
 */
export const SES_SEND_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };
/** Errors SES returns before accepting the email: safe to send again. */
export const SES_THROTTLING_ERRORS: ReadonlySet<string> = new Set(["TooManyRequestsException", "ThrottlingException", "LimitExceededException"]);
export const SES_SEND_ATTEMPTS = 3;
/** Writing the `.eml` and its view render to `Emails`. */
export const EMAIL_STORE_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

/** EmailTags every customer email carries; `EmailEvents` matches the record by them. */
export const EMAIL_TAG = {
  world: "worldId",
  epoch: "epoch",
  complaint: "complaintId",
  mail: "mailId",
  kind: "kind",
  stage: "stage",
  configurationSet: "ses:configuration-set",
} as const;

/**
 * Root of a world's objects (docs/architecture.md §6): `W/<worldId>/` for `demo`, guests and `sim-*`;
 * `qa/<runId>/<worldId>/` for a scenario world (`runId` = `<github run id>-<attempt>`), `qa/qamin/`
 * for `qamin`, and `qa/<worldId>/` for any other QA world, so every QA object lives under `qa/`.
 */
export function worldObjectRoot(worldId: string): string {
  if (worldId === "qamin") return "qa/qamin/";
  if (worldId.startsWith("qa-")) {
    const runId = /^qa-(?:live-)?(\d+-\d+)-/.exec(worldId)?.[1];
    return runId === undefined ? `qa/${worldId}/` : `qa/${runId}/${worldId}/`;
  }
  return `W/${worldId}/`;
}
