// The edge firewall's silent challenge on `/signup` and `/login/recover`, without its SDK
// (docs/architecture-guests.md §8). The browser solves it on the full page load of the document and
// keeps WAF's token cookie; a `signup.start` or `password.forgot` sent after that token expired comes
// back as a challenge (lib/auth/public-api.ts). Then the page keeps the fields that are not secret
// in sessionStorage, reloads itself once with `retry=1` (a full navigation, so the document is
// challenged again), restores them and asks only for the password. A second challenge right after
// that reload means the browser cannot pass it (a content blocker): the page says so, no puzzle.

export const RETRY_PARAM = "retry";

const DRAFT_KEY = "reclamo.access.draft";
/** Never kept across the reload, whatever the caller passes. */
const SECRET_FIELD = /pass|code|token/i;

export type DraftValue = string | boolean;

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function isChallengeRetry(search: URLSearchParams): boolean {
  return search.get(RETRY_PARAM) === "1";
}

/** `path` with the same query (language, campaign) plus the retry mark. */
export function challengeRetryUrl(path: string, search: URLSearchParams): string {
  const next = new URLSearchParams(search);
  next.set(RETRY_PARAM, "1");
  return `${path}?${next.toString()}`;
}

/** Keeps the non-secret fields for the reload; anything that looks secret is dropped. */
export function saveChallengeDraft(fields: Readonly<Record<string, DraftValue>>): void {
  const kept = Object.fromEntries(Object.entries(fields).filter(([name, value]) => !SECRET_FIELD.test(name) && (typeof value === "string" || typeof value === "boolean")));
  try {
    storage()?.setItem(DRAFT_KEY, JSON.stringify(kept));
  } catch {
    // Storage disabled: the person types the fields again.
  }
}

/** The kept fields, once: reading removes them. */
export function takeChallengeDraft(): Readonly<Record<string, DraftValue>> | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(DRAFT_KEY);
    store.removeItem(DRAFT_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, DraftValue] => !SECRET_FIELD.test(entry[0]) && (typeof entry[1] === "string" || typeof entry[1] === "boolean")));
  } catch {
    return undefined;
  }
}

/**
 * A challenge came back: reload once (keeping `fields`), or report that the browser cannot pass it.
 * `navigate` is the full navigation (`window.location.assign` in the browser).
 */
export function handleChallenge(path: string, search: URLSearchParams, fields: Readonly<Record<string, DraftValue>>, navigate: (url: string) => void): "reloading" | "failed" {
  if (isChallengeRetry(search)) return "failed";
  saveChallengeDraft(fields);
  navigate(challengeRetryUrl(path, search));
  return "reloading";
}
