// `CH-RECIPIENT-FENCE` per world (docs/design-brief.md §7, docs/architecture-integrations.md §1 and
// §3): who a message may reach depends on the world it leaves from, never on what a request or a
// customer row says.
//
//   email     one recipient, no Cc/Bcc; the SES mailbox simulator (`success|bounce|ooto|complaint|
//             suppressionlist` with an optional `+label`, domain exactly `simulator.amazonses.com`), or,
//             only from the `demo` world, an exact address of `SeedOverrides.demoRecipients.emails`
//             (all `@craftech.io`); a guest world never reaches a real mailbox, even when a data change
//             points at a demo address
//   WhatsApp  `simulated` reaches the phone simulator only; `live` only from a world that may run live
//             (`demo`, `qa-live-*`) and only to a phone of `demoRecipients.phones`
//
// The strict RFC 5322 parse and the `Destination` = `To` check stay in the SES client and the
// transports (`RECIPIENT_NOT_ALLOWED` again there): this rule decides before anything is rendered.
import { mayRunLive, normalizePhone } from "@reclamo/shared";
import { block, missing, pass } from "./checks";
import type { PolicyContext } from "./context";
import type { RuleCheck } from "./types";

const SIMULATOR_DOMAIN = "simulator.amazonses.com";
const SIMULATOR_LOCAL = /^(?:success|bounce|ooto|complaint|suppressionlist)(?:\+[a-z0-9-]{1,40})?$/;
const DEMO_DOMAIN = "craftech.io";
/** A plain, lower-case address: one `@`, no quotes, spaces, controls or non-ASCII letters. */
const PLAIN_ADDRESS = /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function isSimulatorAddress(address: string): boolean {
  if (!PLAIN_ADDRESS.test(address)) return false;
  const at = address.lastIndexOf("@");
  return address.slice(at + 1) === SIMULATOR_DOMAIN && SIMULATOR_LOCAL.test(address.slice(0, at));
}

function isDemoAddress(address: string, demoEmails: readonly string[]): boolean {
  return PLAIN_ADDRESS.test(address) && address.endsWith(`@${DEMO_DOMAIN}`) && demoEmails.includes(address);
}

function checkEmail(ctx: PolicyContext): RuleCheck {
  const { to, cc, bcc } = ctx.request;
  if ((cc?.length ?? 0) > 0 || (bcc?.length ?? 0) > 0) return block("an email goes to a single recipient, never with Cc or Bcc", "RECIPIENT_NOT_ALLOWED");
  if (to === undefined) return missing(ctx.mode, "the email recipient");
  if (to !== to.trim() || to !== to.toLowerCase()) return block("the recipient is not a plain lower-case address", "RECIPIENT_NOT_ALLOWED");
  if (isSimulatorAddress(to)) return pass("the recipient is a mailbox of the SES simulator");
  if (ctx.request.worldId === "demo" && isDemoAddress(to, ctx.settings.demoRecipients.emails)) return pass("a registered demo recipient, from the demo world");
  const why = ctx.request.worldId === "demo" ? "neither the SES simulator nor a registered demo recipient" : "outside the SES simulator, the only mailboxes this world reaches";
  return block(`the recipient is ${why}`, "RECIPIENT_NOT_ALLOWED");
}

function samePhone(a: string, b: string): boolean {
  try {
    return normalizePhone(a) === normalizePhone(b);
  } catch {
    return false;
  }
}

function checkWhatsApp(ctx: PolicyContext): RuleCheck {
  if (ctx.input.modes.whatsapp === "simulated") return pass("WhatsApp is simulated in this world: the message reaches the phone simulator only");
  if (!mayRunLive(ctx.request.worldId)) return block("this world never runs WhatsApp live", "RECIPIENT_NOT_ALLOWED");
  const { to } = ctx.request;
  if (to === undefined) return missing(ctx.mode, "the live WhatsApp recipient");
  if (ctx.settings.demoRecipients.phones.some((phone) => samePhone(phone, to))) return pass("live WhatsApp to a registered demo phone");
  return block("live WhatsApp only reaches a registered demo phone", "RECIPIENT_NOT_ALLOWED");
}

/** `CH-RECIPIENT-FENCE`. */
export function checkRecipientFence(ctx: PolicyContext): RuleCheck {
  return ctx.byWhatsApp ? checkWhatsApp(ctx) : checkEmail(ctx);
}
