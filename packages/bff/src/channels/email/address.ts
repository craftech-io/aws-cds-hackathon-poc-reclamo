// Strict addresses and header values for everything this app hands to SES
// (docs/architecture-integrations.md §1, "Cerco" and "Asunto"; docs/architecture.md §13).
//
// An address is a strict subset of RFC 5322's dot-atom: ASCII only, already lower case (a recipient
// is never rewritten: an upper-case one is refused, not fixed), no display name, quotes, comments,
// whitespace or control characters, exactly one `@`, a local part of letters, digits and `._%+-`
// without leading, trailing or doubled dots, and a domain of LDH labels with an alphabetic TLD, no
// trailing dot and no IDN (`xn--`) label. Reserved domains (RFC 2606, RFC 6761, RFC 6762) never
// receive anything. A parsed address compares by string equality, so a look-alike suffix
// (`success@simulator.amazonses.com.example.net`) is just another domain.
import { ChannelError } from "@reclamo/shared";

export type AddressProblem =
  | "EMPTY"
  | "TOO_LONG"
  | "CONTROL_CHARACTERS"
  | "NON_ASCII"
  | "WHITESPACE"
  | "SPECIAL_CHARACTERS"
  | "AT_COUNT"
  | "UPPER_CASE"
  | "LOCAL_PART"
  | "TRAILING_DOT"
  | "IDN"
  | "DOMAIN";

export interface ParsedAddress {
  /** `local@domain`, exactly as given. */
  readonly address: string;
  readonly local: string;
  readonly domain: string;
}

export type AddressParse = { readonly ok: true; readonly value: ParsedAddress } | { readonly ok: false; readonly problem: AddressProblem };

const MAX_ADDRESS = 254;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;
const LOCAL_PART = /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,63}$/;

function shapeProblem(raw: string): AddressProblem | undefined {
  if (raw.length === 0) return "EMPTY";
  if (raw.length > MAX_ADDRESS) return "TOO_LONG";
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "CONTROL_CHARACTERS";
  if (/[^\u0020-\u007e]/.test(raw)) return "NON_ASCII";
  if (/\s/.test(raw)) return "WHITESPACE";
  if (/["\\()<>,;:[\]]/.test(raw)) return "SPECIAL_CHARACTERS";
  if (raw.split("@").length !== 2) return "AT_COUNT";
  if (raw !== raw.toLowerCase()) return "UPPER_CASE";
  return undefined;
}

function domainProblem(domain: string): AddressProblem | undefined {
  if (domain.endsWith(".")) return "TRAILING_DOT";
  if (domain.length === 0 || domain.length > MAX_DOMAIN) return "DOMAIN";
  const labels = domain.split(".");
  if (labels.some((label) => label.startsWith("xn--"))) return "IDN";
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return "DOMAIN";
  return TLD.test(labels.at(-1) ?? "") ? undefined : "DOMAIN";
}

export function parseAddress(raw: string): AddressParse {
  const problem = shapeProblem(raw);
  if (problem !== undefined) return { ok: false, problem };
  const at = raw.indexOf("@");
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (local.length === 0 || local.length > MAX_LOCAL || !LOCAL_PART.test(local)) return { ok: false, problem: "LOCAL_PART" };
  const bad = domainProblem(domain);
  return bad === undefined ? { ok: true, value: { address: raw, local, domain } } : { ok: false, problem: bad };
}

/** Top-level names reserved for testing, documentation and local use (RFC 2606, 6761, 6762, 7686). */
const RESERVED_TLDS: ReadonlySet<string> = new Set(["test", "example", "invalid", "localhost", "local", "onion"]);
/** Second-level names reserved for documentation (RFC 2606 §3) and for home networks (RFC 8375). */
const RESERVED_NAMES: readonly string[] = ["example.com", "example.net", "example.org", "home.arpa"];

/** True for a reserved domain or any subdomain of one: nobody may receive mail there. */
export function isReservedDomain(domain: string): boolean {
  if (RESERVED_TLDS.has(domain.split(".").at(-1) ?? "")) return true;
  return RESERVED_NAMES.some((name) => domain === name || domain.endsWith(`.${name}`));
}

// ---- Header values -------------------------------------------------------------------------------

/** SES rejects a header line over 998 characters; the name counts too. */
const MAX_HEADER_VALUE = 900;
const HEADER_NAME = /^[!-9;-~]{1,126}$/;

/**
 * A header value built from data (subject, display name, ids): no CR, LF or other control character,
 * not empty, bounded. A value that fails refuses the send with `INVALID`.
 */
export function assertHeaderValue(name: string, value: string): string {
  if (!HEADER_NAME.test(name)) throw new ChannelError("INVALID", "EMAIL", `invalid header name "${name}"`);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) throw new ChannelError("INVALID", "EMAIL", `header ${name} carries a control character`);
  if (value.trim().length === 0) throw new ChannelError("INVALID", "EMAIL", `header ${name} is empty`);
  if (value.length > MAX_HEADER_VALUE) throw new ChannelError("INVALID", "EMAIL", `header ${name} is longer than ${MAX_HEADER_VALUE} characters`);
  return value;
}

const PRINTABLE_ASCII = /^[\u0020-\u007e]*$/;

/**
 * An unstructured header value (`Subject`) as it goes on the wire: ASCII as is, anything else as
 * RFC 2047 base64 encoded words of at most 75 characters, folded with CRLF + space.
 */
export function encodeHeaderText(value: string): string {
  if (PRINTABLE_ASCII.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    const next = chunk + char;
    // 45 bytes of UTF-8 are 60 base64 characters: with `=?UTF-8?B?` and `?=` the word stays under 75.
    if (Buffer.byteLength(next, "utf8") > 45) {
      words.push(chunk);
      chunk = char;
    } else chunk = next;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** `"Display Name" <address>` (quoted ASCII) or `=?UTF-8?B?…?= <address>` for any other display name. */
export function formatMailbox(displayName: string, address: ParsedAddress): string {
  const name = assertHeaderValue("From", displayName.trim());
  const rendered = PRINTABLE_ASCII.test(name) ? `"${name.replace(/["\\]/g, (char) => `\\${char}`)}"` : encodeHeaderText(name);
  return `${rendered} <${address.address}>`;
}
