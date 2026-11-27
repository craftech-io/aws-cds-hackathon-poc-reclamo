// Disposable-mailbox domains refused by `signup.start` (EMAIL_NOT_ACCEPTED, docs/architecture-guests.md
// §4): a code sent to a throwaway inbox makes a confirmed account nobody will ever come back to, and
// takes one of the 40 self-signup worlds. Two lists together: the maintained public one (the data-only
// package `disposable-email-domains`, pinned, server side only) and this repository's own, for the
// domains seen here first. Lower case, no subdomains (a subdomain of a listed domain is refused too).
// Adding a domain is a pull request. The MX hosts of a domain are checked too (`isDisposableMailHost`):
// a host under a listed domain, or of a provider that only serves temporary inboxes on domains of its
// customers' choosing, refuses the address whatever its domain.
import publicDisposableDomains from "disposable-email-domains";

/** This repository's own list. */
export const OWN_DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10mail.org",
  "10minutemail.com",
  "1secmail.com",
  "20minutemail.com",
  "33mail.com",
  "anonaddy.me",
  "blondmail.com",
  "burnermail.io",
  "bwmyga.com",
  "discard.email",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "emlpro.com",
  "emltmp.com",
  "euploading.com",
  "fakeinbox.com",
  "freeml.net",
  "getairmail.com",
  "getnada.com",
  "gmeenramy.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "inboxkitten.com",
  "lnovic.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mailpoof.com",
  "mailpwr.com",
  "mailtowin.com",
  "maximail.vip",
  "mimimail.me",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "olipii.com",
  "ooynib.com",
  "pickmail.org",
  "ruutukf.com",
  "sharklasers.com",
  "spambox.us",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.dev",
  "tempmail.lol",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "vomoto.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

/** Both lists, built once per container. */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([...publicDisposableDomains.map((domain) => domain.toLowerCase()), ...OWN_DISPOSABLE_DOMAINS]);

/**
 * Addresses of the mail servers of temporary-mail services: a domain whose MX host (or, without MX, the
 * domain itself) resolves to one of them is as disposable as a listed one, whatever its name. Names
 * change every day; the servers do not.
 */
export const DISPOSABLE_MAIL_SERVER_ADDRESSES: ReadonlyMap<string, string> = new Map([
  ["78.47.124.133", "the family of 10mail.org, emltmp.com, emlpro.com, mailpwr.com, mimimail.me, pickmail.org, freeml.net, mailtowin.com and maximail.vip"],
  ["94.130.108.80", "the family of 10mail.org, emltmp.com, emlpro.com, mailpwr.com, mimimail.me, pickmail.org, freeml.net, mailtowin.com and maximail.vip"],
  ["49.12.18.190", "smtp.is (euploading.com)"],
  ["15.204.213.223", "vomoto.com and blondmail.com"],
  ["178.162.170.166", "Guerrilla Mail"],
  ["178.32.61.35", "1secmail.com"],
  ["95.216.191.158", "the mail.<domain> family at Hetzner: olipii.com, gmeenramy.com, lnovic.com, ooynib.com, bwmyga.com and ruutukf.com"],
]);

/** True for an address of a temporary-mail server (IPv4 as written, IPv6 in lower case). */
export function isDisposableMailServerAddress(address: string): boolean {
  return DISPOSABLE_MAIL_SERVER_ADDRESSES.has(address.trim().toLowerCase());
}

/** Providers whose MX hosts serve temporary inboxes on any domain pointed at them (e.g. `mx.smtp.is`). */
export const DISPOSABLE_MAIL_HOST_DOMAINS: ReadonlySet<string> = new Set(["smtp.is"]);

function underAny(set: ReadonlySet<string>, host: string): boolean {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  for (let start = 0; start < labels.length - 1; start += 1) if (set.has(labels.slice(start).join("."))) return true;
  return false;
}

/** True for an MX host of a temporary-mail provider, or under a listed disposable domain. */
export function isDisposableMailHost(host: string): boolean {
  return underAny(DISPOSABLE_MAIL_HOST_DOMAINS, host) || underAny(DISPOSABLE_DOMAINS, host);
}

/** True for a listed domain or any subdomain of one. */
export function isDisposableDomain(domain: string): boolean {
  return underAny(DISPOSABLE_DOMAINS, domain);
}
