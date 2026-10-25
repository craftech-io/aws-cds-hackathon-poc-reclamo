/// <reference path="../../sst-env.d.ts" />
// Lambda entry of `LeadNotifier` (infra/leads.ts `LEAD_NOTIFIER_HANDLER`, docs/architecture-guests.md
// §9, FL-126). The post-confirmation trigger (or the Bff's repair) invokes it asynchronously with only
// `{leadId}`; leads/notifier.ts decides (one notice per lead, 100 a real day, never a QA lead, nothing
// while `LeadNotifyEmail` is `not-configured`) and outbound/transports/lead-notice.ts sends the
// plain-text notice to the one @craftech.io mailbox of the secret. The sender comes from the linked
// `LeadNotice`, the mailbox from the secret: never from the environment, never written in the code.
import type { RepoContext } from "../connector/codec";
import { createConnector } from "../connector/create";
import { DynamoStore } from "../connector/dynamo/engine";
import { signupCaps } from "../guests/caps";
import { type LeadNotifierDeps, type LeadNotifierOutcome, notifyLead } from "../leads/notifier";
import { leadsRepo } from "../leads/repo";
import { type LogSink, createLogger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { secretValue } from "../lib/secrets";
import { LeadNoticeLink, sesLeadNoticeTransport } from "../outbound/transports/lead-notice";

export type LeadNotifierAdapters = Omit<LeadNotifierDeps, "log">;

let adapters: LeadNotifierAdapters | undefined;

function stageAdapters(): LeadNotifierAdapters {
  if (!adapters) {
    const store = new DynamoStore();
    const ctx: RepoContext = { store, now: () => new Date() };
    adapters = {
      ctx,
      connector: createConnector(store, { now: ctx.now }),
      leads: leadsRepo(ctx),
      caps: signupCaps(ctx),
      transport: sesLeadNoticeTransport(readLinked("LeadNotice", LeadNoticeLink).from),
      mailbox: () => secretValue("LeadNotifyEmail"),
    };
  }
  return adapters;
}

/** The handler over explicit adapters (tests) or the stage's (the deployed entry). */
export function createLeadNotifierHandler(resolve: () => LeadNotifierAdapters = stageAdapters, sink?: LogSink) {
  return async (event: unknown): Promise<{ outcome: LeadNotifierOutcome }> => {
    const log = createLogger({ bindings: { service: "lead-notifier" }, ...(sink ? { sink } : {}) });
    const outcome = await notifyLead(event, { ...resolve(), log });
    // Only the outcome: never the lead's id, email or anything the visitor typed.
    log.info("lead.notice", { outcome });
    return { outcome };
  };
}

export const handler = createLeadNotifierHandler();
