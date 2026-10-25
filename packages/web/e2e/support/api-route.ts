// Answers the console's tRPC calls (`/api/<path>[,<path>…]?batch=1`) from the page itself, so the
// shell runs end to end without the BFF. Each procedure path gets a scripted answer, in the wire
// shape of tRPC v11 without a transformer; every call is kept with its path and real instant.
import type { Page } from "@playwright/test";

export type ApiAnswer = { readonly data: unknown } | { readonly error: { readonly code: string; readonly httpStatus: number; readonly reason: string | null } };

export interface ApiCall {
  readonly path: string;
  readonly atMs: number;
}

export function refusal(code: string, httpStatus: number, reason: string | null): ApiAnswer {
  return { error: { code, httpStatus, reason } };
}

/** What every procedure but `clock.resetStatus` answers while the world is being reset. */
export const WORLD_RESETTING = refusal("CONFLICT", 409, "WORLD_RESETTING");

/** What a stub procedure answers (packages/bff/src/routers/errors.ts `notImplemented`). */
export const NOT_IMPLEMENTED = refusal("SERVICE_UNAVAILABLE", 503, "NOT_IMPLEMENTED");

function wire(answer: ApiAnswer): unknown {
  if ("data" in answer) return { result: { data: answer.data } };
  return { error: { message: answer.error.reason ?? answer.error.code, code: -32000, data: { ...answer.error, correlationId: "e2e" } } };
}

/** Routes `/api/**` to `script`; the answers of a batch keep the order of its paths. */
export async function routeApi(page: Page, script: (path: string) => ApiAnswer): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/api\//, "")).split(",");
    const answers = paths.map((path) => {
      calls.push({ path, atMs: Date.now() });
      return script(path);
    });
    const failed = answers.filter((answer) => "error" in answer).length;
    await route.fulfill({
      status: failed === 0 ? 200 : failed === answers.length ? 409 : 207,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answers.map(wire)),
    });
  });
  return calls;
}
