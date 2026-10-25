// Step 5 of the gate (docs/architecture-integrations.md §1 "Cerco", §3; FL-073): the recipient fence
// with the strict parsers, after the policy's `CH-RECIPIENT-FENCE` already decided on the plain form.
// The same fences run again inside the SES client and inside the live WhatsApp transport, and IAM
// repeats the email one (`ses:Recipients`); here a refusal is decided before the tape says `ALLOWED`,
// so nothing reaches SES or End User Messaging Social and the tape shows `BLOCKED CH-RECIPIENT-FENCE`.
//
//   email     one address of the SES mailbox simulator (strict RFC 5322 parse, lower-case exact domain,
//             known mailbox, `+label` of `[a-z0-9-]{1,40}`), or, only from `demo`, an exact address of
//             `SeedOverrides.demoRecipients.emails`; reserved domains, look-alike suffixes, quotes,
//             several `@`, IDN and controls refused (channels/email/recipient-fence.ts)
//   WhatsApp  `simulated` reaches only the phone simulator; `live` only from a world the stage lets run
//             live and only to a phone of `SeedOverrides.demoRecipients.phones`
import { type ChannelMode, mayRunLive, normalizePhone } from "@reclamo/shared";
import type { FenceDecision, FenceIntent } from "../channels/email/recipient-fence";
import { type ChannelModes, stageAllowsLiveWhatsApp } from "../lib/resource";

export const RECIPIENT_FENCE_RULE = "CH-RECIPIENT-FENCE";

export type FenceVerdict = { readonly allowed: true; readonly target: "SIMULATOR" | "DEMO_RECIPIENT" | "PHONE_SIMULATOR" | "DEMO_PHONE" } | { readonly allowed: false; readonly reason: string };

/** The SES client's own fence (`EmailClient.checkRecipient`): the same decision, never a send. */
export function emailFence(check: (intent: FenceIntent) => FenceDecision, intent: { readonly worldId: string; readonly to: string | undefined }): FenceVerdict {
  if (intent.to === undefined) return { allowed: false, reason: "NO_RECIPIENT" };
  const decision = check({ worldId: intent.worldId, to: intent.to });
  return decision.allowed ? { allowed: true, target: decision.target } : { allowed: false, reason: decision.reason };
}

function samePhone(a: string, b: string): boolean {
  try {
    return normalizePhone(a) === normalizePhone(b);
  } catch {
    return false;
  }
}

export interface WhatsAppFenceInput {
  readonly worldId: string;
  /** The world's effective mode (registry.ts `worldWhatsAppMode`). */
  readonly mode: ChannelMode;
  /** The live number the transport would write to (only read in `live`). */
  readonly to: string | undefined;
  readonly demoPhones: readonly string[];
  readonly stageModes: ChannelModes;
}

export function whatsappFence(input: WhatsAppFenceInput): FenceVerdict {
  if (input.mode === "simulated") return { allowed: true, target: "PHONE_SIMULATOR" };
  if (!mayRunLive(input.worldId) || !stageAllowsLiveWhatsApp(input.worldId, input.stageModes)) return { allowed: false, reason: "WORLD_NEVER_LIVE" };
  if (input.to === undefined) return { allowed: false, reason: "NO_RECIPIENT" };
  return input.demoPhones.some((phone) => samePhone(phone, input.to ?? "")) ? { allowed: true, target: "DEMO_PHONE" } : { allowed: false, reason: "PHONE_NOT_REGISTERED" };
}
