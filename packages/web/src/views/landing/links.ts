// Where the landing's calls to action go (ADR-0021 §2, docs/landing-spec.md §2). "Probar Reclamo en
// regla" opens `/signup` with a full page load (a plain `<a href>` the router never intercepts, so the
// edge firewall can challenge the document, docs/architecture-guests.md §8) and keeps the visit's
// campaign parameters; "Ingresar" opens `/login`; "Hablemos" opens Craftech's public contact form in a
// new tab with fixed UTM parameters that only say which button was used: never a `mailto:` and never
// a datum of the visitor.
import { LOGIN_PATH, SIGNUP_PATH } from "../../routes";
import { UTM_KEYS, utmFromSearch } from "./attribution";
import type { LandingLang } from "./copy";

export { SIGNUP_PATH };
export const CRAFTECH_CONTACT_URL = "https://craftech.io/contact/";

/** Every place a "Hablemos" button lives, sent as `utm_content` (ADR-0021 §2); the last one is /signup's closed notice. */
export const CONTACT_PLACEMENTS = ["header", "drawer", "hero", "closing", "footer", "signup-unavailable"] as const;
export type ContactPlacement = (typeof CONTACT_PLACEMENTS)[number];

const CONTACT_UTM = { utm_source: "reclamo-en-regla", utm_medium: "demo", utm_campaign: "poc-landing" } as const;

/** Craftech's contact form for the button at `placement`. */
export function contactHref(placement: ContactPlacement): string {
  return `${CRAFTECH_CONTACT_URL}?${new URLSearchParams({ ...CONTACT_UTM, utm_content: placement }).toString()}`;
}

/**
 * `/signup`, carrying the visit's valid `utm_*` parameters (and nothing else) from the current address,
 * and `lang=en` when the landing is read in English (the access screens open in the same language).
 */
export function signupHref(search: URLSearchParams, lang: LandingLang = "es"): string {
  const utm = utmFromSearch(search);
  const kept = new URLSearchParams();
  if (lang === "en") kept.set("lang", "en");
  for (const key of UTM_KEYS) {
    const value = utm?.[key];
    if (value !== undefined) kept.set(`utm_${key}`, value);
  }
  const query = kept.toString();
  return query === "" ? SIGNUP_PATH : `${SIGNUP_PATH}?${query}`;
}

/** `/login`, in English when the landing is (`?lang=en`). */
export function loginHref(lang: LandingLang = "es"): string {
  return lang === "en" ? `${LOGIN_PATH}?lang=en` : LOGIN_PATH;
}

/** Attributes of every link that leaves for Craftech's site. */
export const EXTERNAL_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;
