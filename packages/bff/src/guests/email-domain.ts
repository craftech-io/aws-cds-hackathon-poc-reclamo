// The email of a self-signup (docs/architecture-guests.md §4): the username is the normalized
// literal address (one account per email, Cognito is case-insensitive), the caps count by the
// canonical address (no `+tag`, no dots in Gmail), and an address is accepted only when it is plain
// ASCII in RFC 5322 dot-atom form, not of this app or the SES mailbox simulator (INVALID_EMAIL), and
// not a reserved or test domain, not a disposable mailbox (public list and the repository's own), not
// a domain DNS says does not exist or has nowhere to receive mail, and with no MX host of a known
// temporary-mail provider (EMAIL_NOT_ACCEPTED: a fresh domain pointed at one is as disposable as the
// listed ones). DNS has a 2 s budget; when it does not answer, or fails for any other reason, the
// address goes on: nobody is refused for a network problem.
import { Resolver } from "node:dns/promises";
import { isDisposableDomain, isDisposableMailHost } from "./disposable-domains";

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

// The app's own domain and the SES mailbox simulator, and names no mailbox outside a network has.
const INVALID_SUFFIXES = ["local", "internal", "simulator.amazonses.com", "demo.craftech.io"];
// RFC 2606 / RFC 6761 reserved and test names: refused like a disposable mailbox.
const RESERVED_SUFFIXES = ["example", "test", "invalid", "localhost", "test.com", "example.com", "example.net", "example.org"];

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
  if (INVALID_SUFFIXES.some((suffix) => endsWithDomain(domain, suffix))) return { ok: false, reason: "INVALID_EMAIL" };
  if (RESERVED_SUFFIXES.some((suffix) => endsWithDomain(domain, suffix)) || isDisposableDomain(domain)) return { ok: false, reason: "EMAIL_NOT_ACCEPTED" };
  return { ok: true, email, domain };
}

/**
 * What DNS says of a domain's mail: it receives (with its MX hosts, lower case, no final dot; none for
 * an implicit MX), it has nowhere to receive (the domain does not exist, a null MX, or no MX and no
 * A/AAAA), or DNS did not answer in time or failed otherwise (`UNKNOWN`).
 */
export type MailDomain = { readonly status: "RECEIVES"; readonly exchangers: readonly string[] } | { readonly status: "NO_MAIL" } | { readonly status: "UNKNOWN" };

export interface MailDomainResolver {
  inspect(domain: string): Promise<MailDomain>;
}

/** The lookups the resolver makes; tests pass their own, so no test asks a real DNS server. */
export interface DnsLookups {
  resolveMx(domain: string): Promise<readonly { readonly exchange: string }[]>;
  resolve4(domain: string): Promise<readonly unknown[]>;
  resolve6(domain: string): Promise<readonly unknown[]>;
}

export const DNS_TIMEOUT_MS = 2_000;

const UNKNOWN: MailDomain = { status: "UNKNOWN" };
const NO_MAIL: MailDomain = { status: "NO_MAIL" };

type Lookup<T> = { readonly found: T } | { readonly absent: true } | { readonly failed: true };

// The domain does not exist (NXDOMAIN) or has no record of that type: an answer, not a failure.
const ABSENT_CODES = new Set(["ENOTFOUND", "ENODATA"]);

async function lookup<T>(run: () => Promise<T>): Promise<Lookup<T>> {
  try {
    return { found: await run() };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && ABSENT_CODES.has(code) ? { absent: true } : { failed: true };
  }
}

async function classify(domain: string, dns: DnsLookups): Promise<MailDomain> {
  const mx = await lookup(() => dns.resolveMx(domain));
  if ("failed" in mx) return UNKNOWN;
  if ("found" in mx && mx.found.length > 0) {
    const exchangers = mx.found.map((record) => record.exchange.toLowerCase().replace(/\.$/, "")).filter((host) => host.length > 0);
    return exchangers.length > 0 ? { status: "RECEIVES", exchangers } : NO_MAIL;
  }
  for (const address of [() => dns.resolve4(domain), () => dns.resolve6(domain)]) {
    const answer = await lookup(address);
    if ("failed" in answer) return UNKNOWN;
    if ("found" in answer && answer.found.length > 0) return { status: "RECEIVES", exchangers: [] };
  }
  return NO_MAIL;
}

/** MX first, then A/AAAA (RFC 5321 implicit MX), all within `timeoutMs`; past it, `UNKNOWN`. */
export function dnsMailDomainResolver(options: { readonly timeoutMs?: number; readonly lookups?: DnsLookups } = {}): MailDomainResolver {
  const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;
  const dns = options.lookups ?? new Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    async inspect(domain) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<MailDomain>((resolve) => {
        timer = setTimeout(() => resolve(UNKNOWN), timeoutMs);
      });
      try {
        return await Promise.race([classify(domain, dns), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Shape, then DNS: a domain with nowhere to receive mail is refused, one DNS cannot tell about goes on. */
export async function checkEmail(raw: string, resolver: MailDomainResolver): Promise<EmailVerdict> {
  const shape = checkEmailShape(raw);
  if (!shape.ok) return shape;
  const mail = await resolver.inspect(shape.domain);
  if (mail.status === "NO_MAIL") return { ok: false, reason: "EMAIL_NOT_ACCEPTED" };
  if (mail.status === "RECEIVES" && mail.exchangers.some(isDisposableMailHost)) return { ok: false, reason: "EMAIL_NOT_ACCEPTED" };
  return shape;
}

/** A self-signup username has an `@`; staff, `guest-NN` and `qa-*` users never do. */
export function isEmailUsername(username: string): boolean {
  return username.includes("@");
}
