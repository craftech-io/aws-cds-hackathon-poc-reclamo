// Disposable-mailbox domains refused by `signup.start` (EMAIL_NOT_ACCEPTED, docs/architecture-guests.md
// §4): a code sent to a throwaway inbox makes a confirmed account nobody will ever come back to, and
// takes one of the 40 self-signup worlds. Versioned here, lower case, no subdomains (a subdomain of a
// listed domain is refused too). Adding a domain is a pull request. The MX hosts of a domain are checked
// too (`isDisposableMailHost`): a host under a listed domain, or of a provider that only serves
// temporary inboxes on domains of its customers' choosing, refuses the address whatever its domain.
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com",
  "20minutemail.com",
  "33mail.com",
  "anonaddy.me",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "euploading.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "inboxkitten.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mailpoof.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spambox.us",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.dev",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

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
