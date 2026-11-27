// The email of a self-signup (docs/architecture-guests.md §4): the username is the normalized
// literal address (one account per email, Cognito is case-insensitive), the caps count by the
// canonical address (no `+tag`, no dots in Gmail), and an address is accepted only when it is plain
// ASCII in RFC 5322 dot-atom form, not of this app or the SES mailbox simulator (INVALID_EMAIL), and
// not a reserved or test domain, not a disposable mailbox (public list and the repository's own), not
// a domain DNS says does not exist or has nowhere to receive mail, with no MX host of a known
// temporary-mail provider and no mail server at the address of one (EMAIL_NOT_ACCEPTED: a fresh domain
// pointed at one is as disposable as the listed ones). DNS has a 2 s budget; when it does not answer, or fails for any other reason, the
// address goes on: nobody is refused for a network problem.
import { Resolver } from "node:dns/promises";
import { isDisposableDomain, isDisposableMailHost, isDisposableMailServerAddress } from "./disposable-domains";

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

export type EmailVerdict =
  | { readonly ok: true; readonly email: string; readonly domain: string }
  | { readonly ok: false; readonly reason: "INVALID_EMAIL" | "EMAIL_NOT_ACCEPTED" }
  /** A domain whose mail server is a temporary-mail service's, by its address (`servidor_descartable`). */
  | { readonly ok: false; readonly reason: "EMAIL_NOT_ACCEPTED"; readonly cause: "DISPOSABLE_MAIL_SERVER" };

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
 * What DNS says of a domain's mail: it receives (with its MX hosts, lower case, no final dot, none for
 * an implicit MX; and the addresses of its mail servers, those of the MX hosts or, without MX, the
 * domain's own, as far as they resolved in time), it has nowhere to receive (the domain does not exist,
 * a null MX, or no MX and no A/AAAA), or DNS did not answer in time or failed otherwise (`UNKNOWN`).
 */
export type MailDomain =
  | { readonly status: "RECEIVES"; readonly exchangers: readonly string[]; readonly addresses?: readonly string[] }
  | { readonly status: "NO_MAIL" }
  | { readonly status: "UNKNOWN" };

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

/** The MX hosts looked at for their addresses: a domain rarely has more, and each costs two lookups. */
const MAX_EXCHANGERS = 4;

const asAddresses = (answer: Lookup<readonly unknown[]>): string[] => ("found" in answer ? answer.found.filter((item): item is string => typeof item === "string") : []);

/** A and AAAA of each host, until `cutoff`; what failed or came late is left out. */
async function addressesOf(hosts: readonly string[], dns: DnsLookups, cutoff: Promise<void>): Promise<string[]> {
  const found: string[] = [];
  const all = Promise.all(
    hosts.slice(0, MAX_EXCHANGERS).flatMap((host) => [dns.resolve4(host), dns.resolve6(host)].map(async (pending) => found.push(...asAddresses(await lookup(() => pending))))),
  );
  await Promise.race([all, cutoff]);
  return [...found];
}

async function classify(domain: string, dns: DnsLookups, cutoff: Promise<void>): Promise<MailDomain> {
  const mx = await lookup(() => dns.resolveMx(domain));
  if ("failed" in mx) return UNKNOWN;
  if ("found" in mx && mx.found.length > 0) {
    const exchangers = mx.found.map((record) => record.exchange.toLowerCase().replace(/\.$/, "")).filter((host) => host.length > 0);
    if (exchangers.length === 0) return NO_MAIL;
    return { status: "RECEIVES", exchangers, addresses: await addressesOf(exchangers, dns, cutoff) };
  }
  const [v4, v6] = [await lookup(() => dns.resolve4(domain)), await lookup(() => dns.resolve6(domain))];
  if ("failed" in v4 || "failed" in v6) {
    const addresses = [...asAddresses(v4), ...asAddresses(v6)];
    return addresses.length > 0 ? { status: "RECEIVES", exchangers: [], addresses } : UNKNOWN;
  }
  const addresses = [...asAddresses(v4), ...asAddresses(v6)];
  return addresses.length > 0 || ("found" in v4 && v4.found.length > 0) || ("found" in v6 && v6.found.length > 0) ? { status: "RECEIVES", exchangers: [], addresses } : NO_MAIL;
}

/** MX first and its hosts' A/AAAA, else the domain's A/AAAA (RFC 5321 implicit MX), within `timeoutMs`; past it, `UNKNOWN`. */
export function dnsMailDomainResolver(options: { readonly timeoutMs?: number; readonly lookups?: DnsLookups } = {}): MailDomainResolver {
  const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;
  const dns = options.lookups ?? new Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    async inspect(domain) {
      // The addresses stop a little before the whole budget, so an MX already read is not lost.
      const timers: ReturnType<typeof setTimeout>[] = [];
      const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => void timers.push(setTimeout(() => resolve(value), ms)));
      try {
        return await Promise.race([classify(domain, dns, after(Math.floor(timeoutMs * 0.9), undefined)), after(timeoutMs, UNKNOWN)]);
      } finally {
        for (const timer of timers) clearTimeout(timer);
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
  if (mail.status === "RECEIVES" && (mail.addresses ?? []).some(isDisposableMailServerAddress)) return { ok: false, reason: "EMAIL_NOT_ACCEPTED", cause: "DISPOSABLE_MAIL_SERVER" };
  return shape;
}

/** A self-signup username has an `@`; staff, `guest-NN` and `qa-*` users never do. */
export function isEmailUsername(username: string): boolean {
  return username.includes("@");
}
