// What `LeadNotifier` does (docs/architecture-guests.md §9, FL-126; its Lambda entry is
// handlers/lead-notifier.ts): invoked asynchronously by the post-confirmation trigger (or by the
// Bff's repair) with only `{leadId}`. It re-reads the lead, sends at most one notice per lead (a conditional claim on `notifiedAtReal`, given back if the send
// fails so the asynchronous retry can try again), at most 100 per real day, never for a QA lead and
// never while `LeadNotifyEmail` is `not-configured`. Every outcome is audited without the email.
import type { RepoContext } from "../connector/codec";
import type { Connector } from "../connector/port";
import type { Logger } from "../lib/log";
import type { LeadNoticeTransport } from "../outbound/transports/lead-notice";
import type { SignupCaps } from "../guests/caps";
import { leadNotice, leadNoticeRecipient } from "./notice";
import { LeadNoticeRequest } from "../guests/provision";
import { isTestLead } from "./records";
import type { LeadsRepo } from "./repo";
import { auditEdge } from "../guests/service-deps";

export interface LeadNotifierDeps {
  readonly ctx: RepoContext;
  readonly connector: Pick<Connector, "write">;
  readonly leads: LeadsRepo;
  readonly caps: SignupCaps;
  readonly transport: LeadNoticeTransport;
  /** Value of the `LeadNotifyEmail` secret. */
  readonly mailbox: () => string;
  readonly log: Logger;
}

export type LeadNotifierOutcome = "SENT" | "ALREADY_SENT" | "NO_LEAD" | "QA_LEAD" | "NOT_CONFIGURED" | "DAILY_CAP";

export async function notifyLead(raw: unknown, deps: LeadNotifierDeps): Promise<LeadNotifierOutcome> {
  const { leadId } = LeadNoticeRequest.parse(raw);
  const skip = async (outcome: Exclude<LeadNotifierOutcome, "SENT">): Promise<LeadNotifierOutcome> => {
    if (outcome !== "ALREADY_SENT") await auditEdge(deps, { action: "LEAD_NOTICE_SKIPPED", outcome, refs: { leadRef: leadId } });
    return outcome;
  };
  const lead = await deps.leads.getLead(leadId);
  if (!lead) return skip("NO_LEAD");
  if (isTestLead(lead)) return skip("QA_LEAD");
  if (lead.notifiedAtReal) return skip("ALREADY_SENT");
  const to = leadNoticeRecipient(deps.mailbox());
  if (!to) return skip("NOT_CONFIGURED");
  if (!(await deps.caps.leadNotice())) return skip("DAILY_CAP");
  if (!(await deps.leads.claimNotice(leadId))) return skip("ALREADY_SENT");
  try {
    await deps.transport.send(leadNotice(lead, to));
  } catch (error) {
    await deps.leads.releaseNotice(leadId).catch(() => undefined);
    throw error;
  }
  await auditEdge(deps, { action: "LEAD_NOTICE_SENT", outcome: "SENT", refs: { leadRef: leadId } });
  return "SENT";
}
