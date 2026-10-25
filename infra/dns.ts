// DNS for the app (docs/architecture.md §1).
//
// The only stage, `poc`, lives under `demo.craftech.io`, a hosted zone delegated to the demos
// account and shared by all demos. The zone pre-exists: it is referenced by id and never managed
// here (the only records this app creates are its own records, inside that zone). Certificates are
// DNS-validated in this same zone, so nothing touches the parent account.
//
//   reclamo.demo.craftech.io   console, landing and /api/* behind the Router; SES sending identity
//                              (Easy DKIM CNAMEs and the DMARC TXT, infra/messaging-email.ts)
//
// Email is OUTBOUND ONLY (ADR-0003): this app never declares an MX record, a custom MAIL FROM
// domain or anything that receives mail. `npm run lint:no-ses-receiving` fails if one appears, and
// the CI deploy role is denied `MX` records (infra/bootstrap/ci-role.yaml, DenyMxRecords).

export const ZONE_ID = "Z043097217S4W7QWXU5O0";
export const ZONE_NAME = "demo.craftech.io";
export const PRODUCT_SUBDOMAIN = "reclamo";

/** Domain of the app: console, landing, API and the SES sending identity. */
export const appDomain = `${PRODUCT_SUBDOMAIN}.${ZONE_NAME}`;

/** Sender of the formal written answers (docs/architecture.md §1). */
export const answersFromAddress = `respuestas@${appDomain}`;

/** Sender of the Cognito invitations of the staff (docs/architecture.md §1). */
export const noReplyFromAddress = `no-reply@${appDomain}`;

/** Public URL of the app (console and landing at `/`, `/api/*` behind the Router). */
export const appUrl = `https://${appDomain}`;

/**
 * Route 53 adapter for `domain.dns` of the Router and for the SES records. Pinned to the delegated
 * zone so SST never searches for a zone by name and never resolves to the parent `craftech.io` zone.
 */
export const dns = sst.aws.dns({ zone: ZONE_ID });
