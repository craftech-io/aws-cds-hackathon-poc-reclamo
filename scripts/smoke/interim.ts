// Interim smoke of a wave (docs/test-plan.md, docs/build-plan.md): what CI runs after a deploy
// until the scenario runner's SC-00 exists (WP-47).
//
//   1. GET /               200 with the security headers of the bootstrap policy (CSP, HSTS,
//                          X-Frame-Options DENY, nosniff).
//   2. GET /legal/privacy.html  200 HTML.
//   3. GET /api/health     the BFF's health probe. Before WP-37 deploys the BFF the Router serves
//                          the console's index.html there: reported, not failed, unless
//                          `--expect-api` says the BFF must be up.
//   4. MX of the domain    must be empty: email is outbound only (ADR-0003); another app of the
//                          account owns the inbound mail of us-east-1.
//
// No AWS call: nothing here lists or describes resources of the shared account.
//
//   npx tsx scripts/smoke/interim.ts [--base-url https://reclamo.demo.craftech.io] [--expect-api]
import { resolveMx } from "node:dns/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../channels/cli-args";

export const DEFAULT_BASE_URL = "https://reclamo.demo.craftech.io";
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const TIMEOUT_MS = 10_000;

export type HeaderMap = Readonly<Record<string, string | undefined>>;

/** Problems of the console root response; empty when it is served with every security header. */
export function rootProblems(status: number, headers: HeaderMap): string[] {
  const problems: string[] = [];
  if (status !== 200) problems.push(`GET / answered ${status}`);
  const csp = headers["content-security-policy"] ?? "";
  if (!csp.includes("default-src 'self'") || !csp.includes("frame-ancestors 'none'")) problems.push("GET / has no strict Content-Security-Policy");
  if (!(headers["strict-transport-security"] ?? "").includes("max-age=")) problems.push("GET / has no Strict-Transport-Security");
  if ((headers["x-frame-options"] ?? "").toUpperCase() !== "DENY") problems.push("GET / has no X-Frame-Options DENY");
  if ((headers["x-content-type-options"] ?? "").toLowerCase() !== "nosniff") problems.push("GET / has no X-Content-Type-Options nosniff");
  return problems;
}

export type HealthVerdict = "ok" | "not-deployed" | "failed";

/** The tRPC health probe answers JSON `{ result: { data: { ok: true } } }`; HTML means the SPA fallback. */
export function healthVerdict(status: number, contentType: string, body: string): HealthVerdict {
  if (contentType.includes("text/html")) return "not-deployed";
  if (status !== 200 || !contentType.includes("application/json")) return "failed";
  try {
    const parsed: unknown = JSON.parse(body);
    const ok = (parsed as { result?: { data?: { ok?: unknown } } }).result?.data?.ok;
    return ok === true ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

async function get(url: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await response.text();
      // CloudFront may still serve the previous version for a few seconds after a deploy.
      if (response.status < 500 || attempt === ATTEMPTS) return { status: response.status, headers, body };
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, RETRY_DELAY_MS));
  }
  throw new Error(`${url} did not answer after ${ATTEMPTS} attempts`, { cause: lastError });
}

/** Problems of the MX lookup of the app domain: any MX record is one (ADR-0003). */
export function mxProblems(records: ReadonlyArray<{ exchange: string }>): string[] {
  return records.length === 0 ? [] : [`MX of the app domain must be empty, found ${records.map((record) => record.exchange).join(", ")}`];
}

async function lookupMx(host: string): Promise<Array<{ exchange: string }>> {
  try {
    return await resolveMx(host);
  } catch (error) {
    // No MX at all is the expected answer.
    const code = (error as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw error;
  }
}

async function main(): Promise<void> {
  let baseUrl = DEFAULT_BASE_URL;
  let expectApi = false;
  parseFlags(process.argv.slice(2), {
    "--base-url": (value) => {
      baseUrl = value().replace(/\/$/, "");
    },
    "--expect-api": () => {
      expectApi = true;
    },
  });
  const problems: string[] = [];
  const root = await get(`${baseUrl}/`);
  problems.push(...rootProblems(root.status, root.headers));
  const legal = await get(`${baseUrl}/legal/privacy.html`);
  if (legal.status !== 200 || !(legal.headers["content-type"] ?? "").includes("text/html")) problems.push(`GET /legal/privacy.html answered ${legal.status}`);
  const health = await get(`${baseUrl}/api/health`);
  const verdict = healthVerdict(health.status, health.headers["content-type"] ?? "", health.body);
  if (verdict === "failed" || (verdict === "not-deployed" && expectApi)) problems.push(`GET /api/health: ${verdict} (${health.status})`);
  const mx = await lookupMx(new URL(baseUrl).hostname);
  problems.push(...mxProblems(mx));
  console.log(`smoke:interim: / ${root.status} · /legal/privacy.html ${legal.status} · /api/health ${verdict} · MX ${mx.length}`);
  if (problems.length > 0) {
    console.error(`smoke:interim: ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
