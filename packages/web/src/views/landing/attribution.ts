// Where a visit came from (docs/landing-spec.md §9.2, docs/architecture-guests.md §4): the landing
// reads `utm_source|medium|campaign|term|content` from its address and the referrer reduced to its
// origin, keeps them in sessionStorage, and the sign-up form sends them with `signup.start` as `utm`
// and `referrer`. No cookies, no analytics, no personal data. A value with any character outside
// letters, digits, `_`, `~`, space and `-`, or longer than 100 characters, is dropped whole (never cut
// or repaired): the BFF refuses a lead text that looks like a link (`guests/schemas.ts`), so a dotted
// value would cost the visitor the sign-up. Storage may be blocked (a private window): every read and
// write is guarded and the sign-up works without it.

export const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;

export const UTM_VALUE_PATTERN = /^[A-Za-z0-9_~ -]{1,100}$/;
const LINK_WORD = /\b(?:https?|www)\b/i;
export const REFERRER_MAX = 200;
export const ATTRIBUTION_KEY = "reclamo.attribution";

export interface Attribution {
  readonly utm?: Utm;
  readonly referrer?: string;
}

/** The storage the attribution lives in; `undefined` when the browser blocks it. */
export type AttributionStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function sanitizeValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return UTM_VALUE_PATTERN.test(trimmed) && !LINK_WORD.test(trimmed) ? trimmed : undefined;
}

function sanitizeUtm(read: (key: UtmKey) => unknown): Utm | undefined {
  const utm: Utm = {};
  for (const key of UTM_KEYS) {
    const value = sanitizeValue(read(key));
    if (value !== undefined) utm[key] = value;
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

/** The `utm_*` parameters of an address that pass the rules, or `undefined` when none does. */
export function utmFromSearch(search: URLSearchParams): Utm | undefined {
  return sanitizeUtm((key) => search.get(`utm_${key}`) ?? undefined);
}

const ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

/** `https://news.example.com` from a full referrer; nothing for our own host, another scheme or an overlong origin. */
export function sanitizeReferrer(referrer: string, ownHost: string): string | undefined {
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return undefined;
  }
  if (url.hostname === ownHost) return undefined;
  const origin = url.origin.toLowerCase();
  return origin.length <= REFERRER_MAX && ORIGIN_PATTERN.test(origin) ? origin : undefined;
}

/** A stored attribution, re-checked: what comes back from storage is never trusted as written. */
export function parseAttribution(raw: string | null): Attribution {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return {};
    const record = value as { readonly utm?: unknown; readonly referrer?: unknown };
    const stored = typeof record.utm === "object" && record.utm !== null ? (record.utm as Readonly<Record<string, unknown>>) : undefined;
    const utm = stored ? sanitizeUtm((key) => stored[key]) : undefined;
    const referrer = typeof record.referrer === "string" && record.referrer.length <= REFERRER_MAX && ORIGIN_PATTERN.test(record.referrer) ? record.referrer : undefined;
    return { ...(utm ? { utm } : {}), ...(referrer ? { referrer } : {}) };
  } catch {
    return {};
  }
}

function sessionStore(): AttributionStorage {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readStored(storage: AttributionStorage): Attribution {
  try {
    return parseAttribution(storage?.getItem(ATTRIBUTION_KEY) ?? null);
  } catch {
    return {};
  }
}

export interface VisitContext {
  readonly search: URLSearchParams;
  readonly referrer: string;
  /** Host of the page itself, so an internal navigation never counts as a referrer. */
  readonly host: string;
  readonly storage: AttributionStorage;
}

function currentVisit(): VisitContext {
  return { search: new URLSearchParams(window.location.search), referrer: document.referrer, host: window.location.hostname, storage: sessionStore() };
}

/**
 * Called once when the landing opens. A visit that brings campaign parameters or an outside referrer
 * replaces what was kept (the last touch wins, whole); one that brings neither keeps it. Returns what
 * is kept now.
 */
export function captureAttribution(visit: VisitContext = currentVisit()): Attribution {
  const kept = readStored(visit.storage);
  const utm = utmFromSearch(visit.search);
  const referrer = visit.referrer ? sanitizeReferrer(visit.referrer, visit.host) : undefined;
  if (utm === undefined && referrer === undefined) return kept;
  const next: Attribution = { ...(utm ? { utm } : {}), ...(referrer ? { referrer } : {}) };
  try {
    visit.storage?.setItem(ATTRIBUTION_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the sign-up goes on without attribution.
  }
  return next;
}

/** What the sign-up form sends in `signup.start` (`utm?`, `referrer?`); empty when nothing was kept. */
export function readAttribution(storage: AttributionStorage = sessionStore()): Attribution {
  return readStored(storage);
}
