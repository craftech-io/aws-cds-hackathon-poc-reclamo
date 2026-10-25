// FL-102 · where a visit came from (docs/landing-spec.md §9.2): the landing keeps only `utm_*` values
// the BFF accepts and the referrer's origin, in sessionStorage, last touch wins, and never breaks when
// storage is blocked. No personal data travels.
import { describe, expect, it } from "vitest";
import { ATTRIBUTION_KEY, captureAttribution, parseAttribution, readAttribution, sanitizeReferrer, utmFromSearch, type AttributionStorage } from "./attribution";

function memoryStorage(initial: Record<string, string> = {}): AttributionStorage & { readonly data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const blocked: AttributionStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("visit attribution [FL-102]", () => {
  it("keeps only utm values the sign-up accepts: no dots, links, markup or overlong values", () => {
    expect(utmFromSearch(new URLSearchParams("utm_source=linkedin&utm_campaign=q4 launch&utm_medium=email"))).toEqual({ source: "linkedin", campaign: "q4 launch", medium: "email" });
    expect(utmFromSearch(new URLSearchParams("utm_source=news.example.com&utm_term=<b>&utm_content=https x"))).toBeUndefined();
    expect(utmFromSearch(new URLSearchParams(`utm_source=${"a".repeat(101)}`))).toBeUndefined();
    expect(utmFromSearch(new URLSearchParams("ref=x&lang=en"))).toBeUndefined();
  });

  it("reduces the referrer to its origin and drops our own host and other schemes", () => {
    expect(sanitizeReferrer("https://News.Example.com/path?q=secret", "reclamo.example")).toBe("https://news.example.com");
    expect(sanitizeReferrer("https://reclamo.example/app", "reclamo.example")).toBeUndefined();
    expect(sanitizeReferrer("android-app://x", "reclamo.example")).toBeUndefined();
    expect(sanitizeReferrer("not a url", "reclamo.example")).toBeUndefined();
  });

  it("replaces what was kept on a visit with campaign data and keeps it on one without", () => {
    const storage = memoryStorage();
    captureAttribution({ search: new URLSearchParams("utm_source=news"), referrer: "https://blog.example.org/post", host: "reclamo.example", storage });
    expect(readAttribution(storage)).toEqual({ utm: { source: "news" }, referrer: "https://blog.example.org" });
    captureAttribution({ search: new URLSearchParams(""), referrer: "", host: "reclamo.example", storage });
    expect(readAttribution(storage)).toEqual({ utm: { source: "news" }, referrer: "https://blog.example.org" });
    captureAttribution({ search: new URLSearchParams("utm_campaign=q4"), referrer: "", host: "reclamo.example", storage });
    expect(readAttribution(storage)).toEqual({ utm: { campaign: "q4" } });
  });

  it("re-checks what comes back from storage and works with storage blocked", () => {
    expect(parseAttribution(JSON.stringify({ utm: { source: "ok", medium: "evil.com" }, referrer: "https://x.example/path" }))).toEqual({ utm: { source: "ok" } });
    expect(parseAttribution("{not json")).toEqual({});
    expect(readAttribution(memoryStorage({ [ATTRIBUTION_KEY]: JSON.stringify({ referrer: "https://ok.example" }) }))).toEqual({ referrer: "https://ok.example" });
    expect(captureAttribution({ search: new URLSearchParams("utm_source=news"), referrer: "", host: "h", storage: blocked })).toEqual({ utm: { source: "news" } });
    expect(readAttribution(blocked)).toEqual({});
    expect(readAttribution(undefined)).toEqual({});
  });
});
