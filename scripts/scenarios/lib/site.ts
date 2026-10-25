// The public site as SC-00 reads it from outside (SMK/1-3): the landing and the legal pages with the
// security headers of the bootstrap policy, the BFF's health probe, and one real call to the BFF with the
// tokens of `auth.session` checked by the deployed verifier. CloudFront may still serve the previous
// version right after a deploy, so every read retries for 30 seconds. The header and health rules are
// the interim smoke's (scripts/smoke/interim.ts). Tokens are sent, never printed.
import { DEFAULT_BASE_URL, healthVerdict, rootProblems } from "../../smoke/interim";
import { realSleep } from "./eventually";

export const SITE = DEFAULT_BASE_URL;
const RETRY_FOR_MS = 30_000;
const RETRY_EVERY_MS = 5_000;
const TIMEOUT_MS = 10_000;

export interface Page {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FetchOptions {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "POST";
  readonly body?: string;
}

/** One request to the site, retried for 30 s while CloudFront answers 5xx or the network fails. */
export async function fetchPage(path: string, options: FetchOptions = {}): Promise<Page> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const deadline = Date.now() + RETRY_FOR_MS;
  for (;;) {
    try {
      const response = await doFetch(`${SITE}${path}`, {
        method: options.method ?? "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(options.headers ? { headers: { ...options.headers } } : {}),
        ...(options.body === undefined ? {} : { body: options.body }),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const page = { status: response.status, headers, body: await response.text() };
      // A POST is sent once: only a GET is repeated on a 5xx.
      if (page.status < 500 || options.method === "POST" || Date.now() >= deadline) return page;
    } catch (error) {
      if (options.method === "POST" || Date.now() >= deadline) throw error;
    }
    await sleep(RETRY_EVERY_MS);
  }
}

/** Problems of a public HTML page: status and the security headers of the bootstrap policy (FL-102). */
export const pageProblems = (path: string, page: Page): string[] => rootProblems(page.status, page.headers).map((problem) => problem.replace("GET /", `GET ${path}`));

export const healthOf = (page: Page) => healthVerdict(page.status, page.headers["content-type"] ?? "", page.body);

/** `data` of a tRPC answer (`{ result: { data } }`), or `undefined` when the body is not one. */
export function trpcData(page: Page): unknown {
  if (!(page.headers["content-type"] ?? "").includes("json")) return undefined;
  try {
    return (JSON.parse(page.body) as { result?: { data?: unknown } }).result?.data;
  } catch {
    return undefined;
  }
}

/** A console query through CloudFront with the id token, as the console sends it (lib/trpc.ts). */
export function consoleQuery(procedure: string, idToken: string): Promise<Page> {
  return fetchPage(`/api/${procedure}`, { headers: { authorization: `Bearer ${idToken}`, accept: "application/json" } });
}
