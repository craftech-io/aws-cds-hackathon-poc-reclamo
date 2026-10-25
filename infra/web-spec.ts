// Route layout, budgets and static-asset policy of the web edge as plain data and pure functions.
// No SST or Pulumi dependency: infra/web.ts and infra/bff.ts build the resources from this file, and
// infra/web-spec.test.ts checks every value against the constraints below without an AWS account.
//
// Constraints, verified against SST 4.17.1 (platform/src/components/aws/router.ts):
//   - The Router matches routes by path prefix on segment boundaries and the longest prefix wins, so
//     `/api` never captures `/apix`.
//   - A route's `readTimeout` (CloudFront origin response timeout) must be 1..60 seconds without a
//     CloudFront quota increase.
//   - The Router forwards the full path: nothing is rewritten, each handler owns its prefix
//     (routers/handler.ts strips `/api`). There is no public token surface: `/api/*` is the only
//     Lambda route (docs/reuse-map.md, infra row of web.ts).

// ---- Routes ------------------------------------------------------------------------------------

/** Path prefix of the tRPC BFF (Function `Bff`); the console calls `/api/<procedure>`. */
export const API_PATH = "/api";

/** Static legal pages served by the console bucket (packages/web/public/legal). */
export const LEGAL_PATH = "/legal";

export const LEGAL_PAGES = {
  privacy: `${LEGAL_PATH}/privacy.html`,
  terms: `${LEGAL_PATH}/terms.html`,
} as const;

export type LegalPage = keyof typeof LEGAL_PAGES;

/** Every Lambda route of the Router, by function. The StaticSite owns `/` and everything else. */
export const LAMBDA_ROUTES = {
  bff: API_PATH,
} as const;

export type EdgeFunction = keyof typeof LAMBDA_ROUTES;

/** Absolute URL of a legal page on the app domain. */
export function legalUrl(domain: string, page: LegalPage): string {
  return `https://${domain}${LEGAL_PAGES[page]}`;
}

/** Same matching rule as the Router's CloudFront function: prefix on a segment boundary. */
export function routeMatches(prefix: string, uri: string): boolean {
  if (prefix === "/") return true;
  return uri.startsWith(prefix) && (uri.length === prefix.length || prefix.endsWith("/") || uri[prefix.length] === "/");
}

/** The Lambda route that serves a URI, longest prefix first; `undefined` → the console bucket. */
export function lambdaRouteFor(uri: string): EdgeFunction | undefined {
  const candidates = (Object.entries(LAMBDA_ROUTES) as Array<[EdgeFunction, string]>)
    .filter(([, prefix]) => routeMatches(prefix, uri))
    .sort(([, a], [, b]) => b.length - a.length);
  return candidates[0]?.[0];
}

// ---- Edge header (docs/architecture-guests.md §4) ------------------------------------------------

/** Prefix of every header the edge owns; whatever a client sends under it is dropped first. */
export const EDGE_HEADER_PREFIX = "x-reclamo-";
/** `EdgeOriginKey`, read by the viewer-request function from the Router's key-value store. */
export const EDGE_HEADER = "x-reclamo-edge";
/** The address CloudFront saw (`event.viewer.ip`); the Bff hashes it before anything stores it. */
export const VIEWER_IP_HEADER = "x-reclamo-viewer-ip";
/** Key of the bootstrap key-value store that holds the `EdgeOriginKey` value (written by infra/web.ts). */
export const EDGE_KVS_KEY = "edge-origin-key";

/**
 * Code injected at the top of the Router's viewer-request function (`edge.viewerRequest.injection`).
 * It runs inside SST's `async function handler(event)`, where `cf` is the CloudFront runtime module
 * already imported for the routing table, and before the routing itself:
 *   1. drops every `x-reclamo-*` header of the viewer (CloudFront hands header names lower-cased);
 *   2. on `/api` and `/api/*` only, adds `x-reclamo-edge` from the store and `x-reclamo-viewer-ip`.
 * A missing key adds no edge header, so the Bff answers `EDGE_REQUIRED` (fail closed) and the site
 * keeps working. Wrapped in a block so its names never clash with SST's own. cloudfront-js-2.0 only:
 * no `for…of`, no optional chaining.
 */
export function edgeHeaderInjection(): string {
  return [
    "{",
    "  var reclamoHeaders = event.request.headers;",
    "  Object.keys(reclamoHeaders).forEach(function (name) {",
    `    if (name.toLowerCase().indexOf("${EDGE_HEADER_PREFIX}") === 0) delete reclamoHeaders[name];`,
    "  });",
    "  var reclamoUri = event.request.uri;",
    `  if (reclamoUri === "${API_PATH}" || reclamoUri.indexOf("${API_PATH}/") === 0) {`,
    "    try {",
    `      reclamoHeaders["${EDGE_HEADER}"] = { value: await cf.kvs().get("${EDGE_KVS_KEY}") };`,
    "    } catch (e) {}",
    `    reclamoHeaders["${VIEWER_IP_HEADER}"] = { value: event.viewer.ip };`,
    "  }",
    "}",
  ].join("\n");
}

// ---- Budgets -----------------------------------------------------------------------------------

/** CloudFront's ceiling for the origin response timeout without a quota increase. */
export const ROUTER_READ_TIMEOUT_MAX_SECONDS = 60;

export interface EdgeFunctionBudget {
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  /** CloudFront origin response timeout of the route. */
  readonly routerReadTimeoutSeconds: number;
  /** Reserved concurrency (docs/architecture.md §12). */
  readonly reservedConcurrency: number;
}

export const EDGE_BUDGETS: Readonly<Record<EdgeFunction, EdgeFunctionBudget>> = {
  // Console procedures read DynamoDB, enqueue work and presign URLs (10 s budget per procedure): the
  // Lambda timeout is declared, never the implicit default, and ends before CloudFront gives up
  // (docs/architecture.md §4).
  bff: { timeoutSeconds: 20, memoryMb: 1024, routerReadTimeoutSeconds: 30, reservedConcurrency: 10 },
};

// ---- Static assets -----------------------------------------------------------------------------

export interface StaticFileOption {
  readonly files: string;
  readonly cacheControl: string;
  readonly contentType?: string;
}

/**
 * Upload policy of the console bucket. SST applies the entries in reverse order and a file takes the
 * first entry that matches it, so the LAST matching entry wins:
 *   - `assets/**`: Vite's content-hashed bundles, immutable for a year;
 *   - any other file copied from packages/web/public (logos, landing captures): one hour;
 *   - HTML never cached, so a deploy is visible at once (index.html points at the new bundle);
 *   - the legal pages: public, five minutes, explicit UTF-8 so the Spanish text renders everywhere;
 *   - the landing's product video: one hour, with its explicit media type (the upload would otherwise
 *     label it a generic binary, which `nosniff` keeps a browser from treating as a video).
 */
export const STATIC_FILE_OPTIONS: readonly StaticFileOption[] = [
  { files: "**", cacheControl: "max-age=3600,public" },
  { files: "assets/**", cacheControl: "max-age=31536000,public,immutable" },
  { files: "**/*.html", cacheControl: "max-age=0,no-cache,no-store,must-revalidate" },
  { files: `${LEGAL_PATH.slice(1)}/*.html`, cacheControl: "max-age=300,public", contentType: "text/html; charset=utf-8" },
  { files: "landing/video/*.mp4", cacheControl: "max-age=3600,public", contentType: "video/mp4" },
];
