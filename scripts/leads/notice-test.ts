/// <reference path="../../sst-env.d.ts" />
// The operator's test of the lead notice's delivery (FL-126). It runs with the
// account's profile, inside `sst shell` (the linked `LeadNotice` sender, the `LeadNotifyEmail` secret,
// the `AuditLog` table), never in CI and never from a scenario:
//
//   npm run leads:notice-test -- --check     says whether the secret names one @craftech.io mailbox; sends nothing
//   npm run leads:notice-test -- --send      sends ONE "[PRUEBA]" notice to that mailbox, audited LEAD_NOTICE_TEST
//
// The notice goes through the real transport of the lead notice (outbound/transports/lead-notice.ts),
// with its MAILBOX fence; no lead is created, read or notified. Nothing it prints names the mailbox.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoContext } from "../../packages/bff/src/connector/codec";
import { createConnector } from "../../packages/bff/src/connector/create";
import { DynamoStore } from "../../packages/bff/src/connector/dynamo/engine";
import { type NoticeTestDeps, noticeTestReady, sendLeadNoticeTest } from "../../packages/bff/src/leads/notice-test";
import { createLogger } from "../../packages/bff/src/lib/log";
import { readLinked } from "../../packages/bff/src/lib/resource";
import { secretValue } from "../../packages/bff/src/lib/secrets";
import { LeadNoticeLink, sesLeadNoticeTransport } from "../../packages/bff/src/outbound/transports/lead-notice";
import { parseFlags } from "../channels/cli-args";

export type NoticeTestAction = "check" | "send";

export function parseNoticeTestArgs(argv: readonly string[]): NoticeTestAction {
  const actions: NoticeTestAction[] = [];
  parseFlags(argv, { "--check": () => void actions.push("check"), "--send": () => void actions.push("send") });
  if (actions.length !== 1 || !actions[0]) throw new RangeError("pass exactly one of --check or --send");
  return actions[0];
}

/** What the run prints: the outcome and where it is audited, never the address. */
export async function runNoticeTest(action: NoticeTestAction, deps: NoticeTestDeps): Promise<string> {
  if (action === "check") {
    return noticeTestReady(deps.mailbox)
      ? "leads:notice-test: LeadNotifyEmail names one @craftech.io mailbox; --send sends one [PRUEBA] notice to it."
      : "leads:notice-test: LeadNotifyEmail is not-configured or not one @craftech.io address; nothing would be sent.";
  }
  const outcome = await sendLeadNoticeTest(deps);
  const month = deps.ctx.now().toISOString().slice(0, 7);
  return outcome === "SENT"
    ? `leads:notice-test: SENT one [PRUEBA] notice to the configured mailbox; audited LEAD_NOTICE_TEST SENT in SIGNUP#AUD#${month}.`
    : `leads:notice-test: NOT_CONFIGURED, nothing sent (LeadNotifyEmail is not one @craftech.io address); audited in SIGNUP#AUD#${month}.`;
}

function stageDeps(): NoticeTestDeps {
  const store = new DynamoStore();
  const ctx: RepoContext = { store, now: () => new Date() };
  return {
    ctx,
    connector: createConnector(store, { now: ctx.now }),
    transport: sesLeadNoticeTransport(readLinked("LeadNotice", LeadNoticeLink).from),
    mailbox: () => secretValue("LeadNotifyEmail"),
    log: createLogger({ bindings: { service: "leads-notice-test" } }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await runNoticeTest(parseNoticeTestArgs(process.argv.slice(2)), stageDeps()));
    if (process.argv.includes("--send")) console.log("leads:notice-test: confirm the [PRUEBA] message arrived in the mailbox.");
  } catch (error) {
    // Only our own argument errors carry a message; any other error only its name (never an address).
    console.error(`leads:notice-test: FAILED (${error instanceof RangeError ? error.message : error instanceof Error ? error.name : "UnknownError"})`);
    process.exit(1);
  }
}
