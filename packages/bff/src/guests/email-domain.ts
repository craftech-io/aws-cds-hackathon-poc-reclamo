// The email of a self-signup (docs/architecture-guests.md §4): the username is the normalized
// literal address (one account per email, Cognito is case-insensitive), the caps count by the
// canonical address (no `+tag`, no dots in Gmail), and an address is accepted only when it is plain
// ASCII in RFC 5322 dot-atom form, not reserved, not of this app or the SES mailbox simulator, not a
// disposable mailbox, and its domain has an MX or an A/AAAA record (2 s budget).
import { Resolver } from "node:dns/promises";
import { isDisposableDomain } from "./disposable-domains";

export const EMAIL_MAX_LENGTH = 254;
const LOCAL_MAX_LENGTH = 64;

const ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,63}$/;

/** Lower case, trimmed, NFC. */
export function normalizeEmail(raw: string): string {
  return raw.trim().normalize("NFC").toLowerCase();
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** The address the caps count by: no `+tag`; for Gmail, no dots and one domain. */
export function canonicalEmail(normalized: string): string {
  const at = normalized.lastIndexOf("@");
  const local = normalized.slice(0, at).split("+")[0] ?? "";
  const domain = normalized.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) return `${local.replaceAll(".", "")}@gmail.com`;
  return `${local}@${domain}`;
}

// RFC 2606 / RFC 6761 names, the app's own domain and the SES mailbox simulator.
const RESERVED_SUFFIXES = ["example", "test", "invalid", "localhost", "local", "internal", "example.com", "example.net", "example.org", "simulator.amazonses.com", "demo.craftech.io"];

function endsWithDomain(domain: string, suffix: string): boolean {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

export type EmailVerdict = { readonly ok: true; readonly email: string; readonly domain: string } | { readonly ok: false; readonly reason: "INVALID_EMAIL" | "EMAIL_NOT_ACCEPTED" };

/** The shape rules, without the network (the demos zone covers the app's own domain). */
export function checkEmailShape(raw: string): EmailVerdict {
  const email = normalizeEmail(raw);
  // ASCII only: no SMTPUTF8 local parts, no IDN (homographs).
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(email)) return { ok: false, reason: "INVALID_EMAIL" };
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (at <= 0 || local.length > LOCAL_MAX_LENGTH || !LOCAL.test(local)) return { ok: false, reason: "INVALID_EMAIL" };
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !TLD.test(labels.at(-1) ?? "")) return { ok: false, reason: "INVALID_EMAIL" };
  // `qa-` is the prefix of the scenario runner's usernames; a visitor never gets it.
  if (local.startsWith("qa-")) return { ok: false, reason: "INVALID_EMAIL" };
  if (RESERVED_SUFFIXES.some((suffix) => endsWithDomain(domain, suffix))) return { ok: false, reason: "INVALID_EMAIL" };
  if (isDisposableDomain(domain)) return { ok: false, reason: "EMAIL_NOT_ACCEPTED" };
  return { ok: true, email, domain };
}

/** Whether a domain can receive mail at all. */
export interface MailDomainResolver {
  receivesMail(domain: string): Promise<boolean>;
}

const DNS_TIMEOUT_MS = 2_000;

/** MX first, then A/AAAA (RFC 5321 implicit MX); any failure or a timeout counts as "no". */
export function dnsMailDomainResolver(timeoutMs: number = DNS_TIMEOUT_MS): MailDomainResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const has = async (lookup: () => Promise<unknown[]>): Promise<boolean> => {
    try {
      return (await lookup()).length > 0;
    } catch {
      return false;
    }
  };
  return {
    async receivesMail(domain) {
      const deadline = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs + 200).unref());
      const lookup = (async () => (await has(() => resolver.resolveMx(domain))) || (await has(() => resolver.resolve4(domain))) || has(() => resolver.resolve6(domain)))();
      return Promise.race([lookup, deadline]);
    },
  };
}

/** Shape, then DNS. */
export async function checkEmail(raw: string, resolver: MailDomainResolver): Promise<EmailVerdict> {
  const shape = checkEmailShape(raw);
  if (!shape.ok) return shape;
  return (await resolver.receivesMail(shape.domain)) ? shape : { ok: false, reason: "INVALID_EMAIL" };
}

/** A self-signup username has an `@`; staff, `guest-NN` and `qa-*` users never do. */
export function isEmailUsername(username: string): boolean {
  return username.includes("@");
}
