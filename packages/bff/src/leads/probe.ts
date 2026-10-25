// The QA-safe proof of the lead notice's transport (docs/architecture-guests.md §9, the QaDriver's
// `notice.probe`, SC-24): the real `leadNotice()` of a synthetic QA lead, sent through the real SES
// transport, to the SES mailbox simulator only (the transport's `PROBE` fence and the QaDriver's IAM both
// allow nothing else), and audited `LEAD_NOTICE_PROBE` in the runner's own partition of the edge. A real
// lead is never read, and the team's mailbox is never written to: its first real notice is the
// operator's to confirm (`LEAD_NOTICE_SENT` in `SIGNUP#AUD#<yyyy-mm>`).
import { CURRENT_SIGNUP_CONSENT } from "../copy/signup-consent";
import type { RepoContext } from "../connector/codec";
import type { Connector } from "../connector/port";
import { qaSignupEmail } from "../guests/signup";
import { auditEdge } from "../guests/service-deps";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { LeadNoticeTransport } from "../outbound/transports/lead-notice";
import type { QaScope } from "./keys";
import { SOURCE_POC } from "./limits";
import { LEAD_NOTICE_PROBE_RECIPIENT, leadNotice } from "./notice";
import { Lead } from "./records";

/** The probe's own key: never a sign-up's (`su<n>` with n ≥ 1). */
export const PROBE_KEY = "su0";

export interface NoticeProbeDeps {
  readonly ctx: RepoContext;
  readonly connector: Pick<Connector, "write">;
  readonly transport: LeadNoticeTransport;
  readonly log: Logger;
}

/** A synthetic QA lead of the run: the simulator's address, a campaign, both consents. */
export function probeLead(runId: string, now: Date): Lead {
  const qa: QaScope = { runId, key: PROBE_KEY };
  const at = now.toISOString();
  const email = qaSignupEmail(qa);
  return Lead.parse({
    sub: `notice-probe-${runId}`,
    email,
    consents: { terms: { acceptedAtReal: at, textVersion: CURRENT_SIGNUP_CONSENT.version }, contact: { accepted: true, atReal: at, textVersion: CURRENT_SIGNUP_CONSENT.version } },
    sourcePoc: SOURCE_POC,
    locale: "es",
    utm: { source: "qa", campaign: "notice-probe" },
    emailHash: sha256Hex(email),
    worldId: `qa-${runId}-${PROBE_KEY}`,
    signupAtReal: at,
    confirmedAtReal: at,
    qa,
  });
}

export async function probeLeadNotice(runId: string, deps: NoticeProbeDeps): Promise<{ readonly outcome: "SENT"; readonly recipient: "SES_MAILBOX_SIMULATOR" }> {
  const notice = leadNotice(probeLead(runId, deps.ctx.now()), LEAD_NOTICE_PROBE_RECIPIENT);
  try {
    await deps.transport.send(notice);
  } catch (error) {
    await auditEdge(deps, { action: "LEAD_NOTICE_PROBE", outcome: "FAILED", refs: { runId, errorName: error instanceof Error ? error.name : "UnknownError" }, qa: true });
    throw error;
  }
  await auditEdge(deps, { action: "LEAD_NOTICE_PROBE", outcome: "SENT", refs: { runId }, qa: true });
  return { outcome: "SENT", recipient: "SES_MAILBOX_SIMULATOR" };
}
