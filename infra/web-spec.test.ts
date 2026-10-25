import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_PREFIX } from "../packages/bff/src/routers/api-prefix";
import {
  API_PATH,
  EDGE_BUDGETS,
  LAMBDA_ROUTES,
  LEGAL_PAGES,
  ROUTER_READ_TIMEOUT_MAX_SECONDS,
  STATIC_FILE_OPTIONS,
  lambdaRouteFor,
  legalUrl,
  routeMatches,
  type EdgeFunction,
} from "./web-spec";

const EDGE_FUNCTIONS = Object.keys(LAMBDA_ROUTES) as EdgeFunction[];
const web = readFileSync(resolve(process.cwd(), "infra/web.ts"), "utf8");
const dns = readFileSync(resolve(process.cwd(), "infra/dns.ts"), "utf8");

/** Mirrors SST's upload: entries are applied in reverse and a file keeps the first one that matches. */
function optionFor(file: string) {
  const toRegex = (glob: string) =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*")}$`,
    );
  return [...STATIC_FILE_OPTIONS].reverse().find((option) => toRegex(option.files).test(file));
}

describe("domain", () => {
  it("serves the app on reclamo.demo.craftech.io inside the delegated demos zone", () => {
    expect(dns).toContain('export const ZONE_ID = "Z043097217S4W7QWXU5O0";');
    expect(dns).toContain('export const PRODUCT_SUBDOMAIN = "reclamo";');
    expect(dns).toContain("sst.aws.dns({ zone: ZONE_ID })");
    expect(web).toMatch(/domain: \{\n\s+name: appDomain,\n\s+dns,\n\s+\}/);
  });
});

describe("router layout", () => {
  it("uses the prefix the BFF handler strips", () => {
    expect(API_PATH).toBe(API_PREFIX);
  });

  it("reserves /api for the BFF, has no public token surface and sends everything else to the console", () => {
    expect(LAMBDA_ROUTES).toEqual({ bff: "/api" });
    expect(lambdaRouteFor("/api/inbox.list")).toBe("bff");
    expect(lambdaRouteFor("/api")).toBe("bff");
    for (const uri of ["/", "/app/inbox", "/u/abc123", "/users", "/apix", "/legal/privacy.html", "/login"]) {
      expect(lambdaRouteFor(uri)).toBeUndefined();
    }
  });

  it("matches on segment boundaries like the Router's CloudFront function", () => {
    expect(routeMatches(API_PATH, "/api")).toBe(true);
    expect(routeMatches(API_PATH, "/api/health")).toBe(true);
    expect(routeMatches(API_PATH, "/apix")).toBe(false);
    expect(routeMatches("/", "/anything")).toBe(true);
  });

  it("keeps the prefixes disjoint so no route shadows another", () => {
    const prefixes = Object.values(LAMBDA_ROUTES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const a of prefixes) for (const b of prefixes) if (a !== b) expect(routeMatches(a, b)).toBe(false);
    for (const prefix of prefixes) expect(prefix).toMatch(/^\/[a-z]+$/);
  });

  it("serves the legal pages from the console bucket, never from a Lambda", () => {
    expect(LEGAL_PAGES).toEqual({ privacy: "/legal/privacy.html", terms: "/legal/terms.html" });
    for (const page of Object.values(LEGAL_PAGES)) expect(lambdaRouteFor(page)).toBeUndefined();
    expect(legalUrl("reclamo.demo.craftech.io", "privacy")).toBe("https://reclamo.demo.craftech.io/legal/privacy.html");
  });

  it("declares no inline routes, so bff.ts can attach its functions with url.router", () => {
    expect(web).not.toMatch(/\broutes:/);
    expect(web).toContain('protection: "none"');
  });
});

describe("edge budgets", () => {
  it("keeps every route timeout inside CloudFront's limits", () => {
    for (const fn of EDGE_FUNCTIONS) {
      const { routerReadTimeoutSeconds } = EDGE_BUDGETS[fn];
      expect(routerReadTimeoutSeconds).toBeGreaterThanOrEqual(1);
      expect(routerReadTimeoutSeconds).toBeLessThanOrEqual(ROUTER_READ_TIMEOUT_MAX_SECONDS);
    }
  });

  it("ends buffered Lambdas before CloudFront stops waiting for them", () => {
    for (const fn of EDGE_FUNCTIONS) expect(EDGE_BUDGETS[fn].timeoutSeconds).toBeLessThan(EDGE_BUDGETS[fn].routerReadTimeoutSeconds);
  });

  it("stays within Lambda's memory range and reserves the concurrency of docs/architecture.md §12", () => {
    for (const fn of EDGE_FUNCTIONS) {
      expect(EDGE_BUDGETS[fn].memoryMb).toBeGreaterThanOrEqual(128);
      expect(EDGE_BUDGETS[fn].memoryMb).toBeLessThanOrEqual(10_240);
    }
    expect(EDGE_BUDGETS.bff).toEqual({ timeoutSeconds: 20, memoryMb: 1024, routerReadTimeoutSeconds: 30, reservedConcurrency: 10 });
  });
});

describe("static file options", () => {
  it("caches hashed bundles forever and HTML never", () => {
    expect(optionFor("assets/index-3f9a.js")?.cacheControl).toContain("immutable");
    expect(optionFor("index.html")?.cacheControl).toContain("no-store");
    expect(optionFor("brand/logo-craftech-color.svg")?.cacheControl).toBe("max-age=3600,public");
  });

  it("serves the legal pages publicly as UTF-8 HTML with a short cache", () => {
    for (const page of Object.values(LEGAL_PAGES)) {
      const option = optionFor(page.slice(1));
      expect(option?.contentType).toBe("text/html; charset=utf-8");
      expect(option?.cacheControl).toBe("max-age=300,public");
    }
  });
});
