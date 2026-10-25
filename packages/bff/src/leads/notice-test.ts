// The operator's proof that the lead notice reaches the team's mailbox (FL-126,
// `npm run leads:notice-test -- --send`): ONE `[PRUEBA]` notice through the real SES transport of the
// lead notice (its `MAILBOX` fence: one @craftech.io address, the fixed subjects), to the mailbox of the
// `LeadNotifyEmail` secret, audited `LEAD_NOTICE_TEST` in the visitors' partition of the edge
// (`SIGNUP#AUD#<yyyy-mm>`), next to the `LEAD_NOTICE_SENT` of real leads. No lead is read or written,
// and neither the answer nor the audit carries the address.
import type { RepoContext } from "../connector/codec";
import type { Connector } from "../connector/port";
import { auditEdge } from "../guests/service-deps";
import type { Logger } from "../lib/log";
import type { LeadNoticeTransport } from "../outbound/transports/lead-notice";
import { leadNoticeRecipient, leadNoticeTest } from "./notice";

export interface NoticeTestDeps {
  readonly ctx: RepoContext;
  readonly connector: Pick<Connector, "write">;
  readonly transport: LeadNoticeTransport;
  /** Value of the `LeadNotifyEmail` secret. */
  readonly mailbox: () => string;
  readonly log: Logger;
}

export type NoticeTestOutcome = "SENT" | "NOT_CONFIGURED";

/** Whether the secret names one @craftech.io mailbox (what `--check` reports); never the address. */
export function noticeTestReady(mailbox: () => string): boolean {
  return leadNoticeRecipient(mailbox()) !== undefined;
}

export async function sendLeadNoticeTest(deps: NoticeTestDeps): Promise<NoticeTestOutcome> {
  const to = leadNoticeRecipient(deps.mailbox());
  if (to === undefined) {
    await auditEdge(deps, { action: "LEAD_NOTICE_TEST", outcome: "NOT_CONFIGURED", refs: { by: "operator" } });
    return "NOT_CONFIGURED";
  }
  try {
    await deps.transport.send(leadNoticeTest(to, deps.ctx.now()));
  } catch (error) {
    await auditEdge(deps, { action: "LEAD_NOTICE_TEST", outcome: "FAILED", refs: { by: "operator", errorName: error instanceof Error ? error.name : "UnknownError" } });
    throw error;
  }
  await auditEdge(deps, { action: "LEAD_NOTICE_TEST", outcome: "SENT", refs: { by: "operator" } });
  return "SENT";
}
