// Recipient fence of the single SES client (docs/architecture-integrations.md §1 "Cerco",
// docs/architecture.md §13, rule `CH-RECIPIENT-FENCE`). It runs inside the client before anything is
// stored or sent, and the gate runs it again as its step 5 (`checkRecipient`); IAM repeats it with
// `ses:Recipients` (simulator and `@craftech.io`) and its `Null` guard.
//
// A customer email may go to:
//   1. SES's mailbox simulator: domain exactly `simulator.amazonses.com`, local part one of `success`,
//      `bounce`, `ooto`, `complaint`, `suppressionlist`, with an optional `+<[a-z0-9-]{1,40}>` label;
//   2. only from the `demo` world, an exact address of `SeedOverrides.demoRecipients.emails` (at most
//      five, all `@craftech.io`). A guest or QA world never reaches a real inbox, even when a data
//      change points its customer at a demo address.
// Anything the strict parser refuses (upper case, quotes, several `@`, IDN, control characters) and
// every reserved domain is refused. The MIME carries one `To` and no `Cc`/`Bcc`, and
// `Destination.ToAddresses` must be exactly that `To` (`assertSingleRecipient`).
import { z } from "zod";
import { ChannelError } from "@reclamo/shared";
import { type AddressProblem, type ParsedAddress, isReservedDomain, parseAddress } from "./address";
import { DEMO_RECIPIENT_DOMAIN, DEMO_WORLD, MAX_DEMO_RECIPIENTS, SES_SIMULATOR_DOMAIN, SES_SIMULATOR_MAILBOXES, SIMULATOR_LABEL, type SimulatorMailbox } from "./config";

export const RECIPIENT_FENCE_RULE = "CH-RECIPIENT-FENCE";

export type FenceReason = `ADDRESS_${AddressProblem}` | "RESERVED_DOMAIN" | "SIMULATOR_MAILBOX" | "SIMULATOR_LABEL" | "DEMO_RECIPIENT_OUTSIDE_DEMO" | "NOT_ALLOWED";

export type FenceDecision =
  | { readonly allowed: true; readonly to: ParsedAddress; readonly target: "SIMULATOR"; readonly mailbox: SimulatorMailbox }
  | { readonly allowed: true; readonly to: ParsedAddress; readonly target: "DEMO_RECIPIENT" }
  | { readonly allowed: false; readonly code: "RECIPIENT_NOT_ALLOWED"; readonly ruleId: typeof RECIPIENT_FENCE_RULE; readonly reason: FenceReason };

export interface FenceIntent {
  readonly worldId: string;
  /** The recipient exactly as it would go on `Destination.ToAddresses`. */
  readonly to: string;
}

/** Demo recipients in force (`SeedOverrides.demoRecipients.emails`): real team inboxes, PII, never logged. */
export type DemoRecipients = () => readonly string[];

function refused(reason: FenceReason): FenceDecision {
  return { allowed: false, code: "RECIPIENT_NOT_ALLOWED", ruleId: RECIPIENT_FENCE_RULE, reason };
}

function simulatorDecision(to: ParsedAddress): FenceDecision {
  const plus = to.local.indexOf("+");
  const mailbox = plus === -1 ? to.local : to.local.slice(0, plus);
  const label = plus === -1 ? undefined : to.local.slice(plus + 1);
  if (!(SES_SIMULATOR_MAILBOXES as readonly string[]).includes(mailbox)) return refused("SIMULATOR_MAILBOX");
  if (label !== undefined && !SIMULATOR_LABEL.test(label)) return refused("SIMULATOR_LABEL");
  return { allowed: true, to, target: "SIMULATOR", mailbox: mailbox as SimulatorMailbox };
}

export function checkRecipientFence(intent: FenceIntent, demoRecipients: DemoRecipients): FenceDecision {
  const parsed = parseAddress(intent.to);
  if (!parsed.ok) return refused(`ADDRESS_${parsed.problem}`);
  const to = parsed.value;
  if (isReservedDomain(to.domain)) return refused("RESERVED_DOMAIN");
  if (to.domain === SES_SIMULATOR_DOMAIN) return simulatorDecision(to);
  const listed = to.domain === DEMO_RECIPIENT_DOMAIN && demoRecipients().includes(to.address);
  if (!listed) return refused("NOT_ALLOWED");
  return intent.worldId === DEMO_WORLD ? { allowed: true, to, target: "DEMO_RECIPIENT" } : refused("DEMO_RECIPIENT_OUTSIDE_DEMO");
}

const SeedOverridesRecipients = z.looseObject({
  demoRecipients: z.looseObject({ emails: z.array(z.string()).max(MAX_DEMO_RECIPIENTS) }).optional(),
});

/**
 * The demo recipients of the `SeedOverrides` secret: each one a strict `@craftech.io` address. A secret
 * that is not JSON, lists more than five, or holds anything else fails closed: no demo recipient at
 * all (the error never quotes the secret).
 */
export function demoRecipientsFromSeedOverrides(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = SeedOverridesRecipients.safeParse(json);
  if (!parsed.success) return [];
  const emails = parsed.data.demoRecipients?.emails ?? [];
  const valid = emails.every((email) => {
    const address = parseAddress(email);
    return address.ok && address.value.domain === DEMO_RECIPIENT_DOMAIN;
  });
  return valid ? emails : [];
}

/**
 * The MIME's recipients and the API's `Destination.ToAddresses` name one and the same address: exactly
 * one `To`, no `Cc` and no `Bcc` (with `Content.Raw`, SES could otherwise read recipients from the
 * MIME that IAM's `ses:Recipients` never evaluated).
 */
export function assertSingleRecipient(destination: readonly string[], mime: { readonly to: readonly string[]; readonly cc: number; readonly bcc: number }): void {
  if (destination.length !== 1 || mime.to.length !== 1 || mime.cc !== 0 || mime.bcc !== 0) {
    throw new ChannelError("INVALID", "EMAIL", "an email has exactly one To and no Cc or Bcc");
  }
  if (destination[0] !== mime.to[0]) throw new ChannelError("INVALID", "EMAIL", "Destination.ToAddresses differs from the To of the MIME");
}
