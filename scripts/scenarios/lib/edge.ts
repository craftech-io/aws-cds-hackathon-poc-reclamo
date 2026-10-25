// The sign-up surface as a visitor's browser and a script outside it reach it (SMK/10, docs/test-plan.md §5,
// docs/architecture-guests.md §8): Playwright with the installed Chrome (`E2E_BROWSER_CHANNEL`, never a
// downloaded browser) against https://reclamo.demo.craftech.io, so the documents load through the edge
// web ACL with the bootstrap's CSP enforced; the public procedures called from inside the page and from
// outside it; and Cognito's own API with the console's client, which the regional web ACL must
// refuse for every sign-up and recovery operation. The console's client id is read from the console's
// own call to Cognito, which is aborted before it leaves the browser: nothing reaches the pool. The only
// addresses used are of reserved domains (RFC 2606) or `qa-` usernames; nothing is created anywhere.
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CognitoIdentityProviderClient, ForgotPasswordCommand } from "@aws-sdk/client-cognito-identity-provider";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { type Browser, type Page, chromium } from "@playwright/test";
import { REGION } from "./driver-client";
import { SITE, type Page as SitePage, fetchPage } from "./site";

export const WAF_ACTION_HEADER = "x-amzn-waf-action";
/** infra/waf.ts: `webAclName(app, stage, "auth")` and the metric of rule 1 (`ReclamoAuth` + rule name). */
export const AUTH_WEB_ACL = "aws-cds-hackathon-poc-reclamo-poc-auth";
export const SIGNUP_OPS_RULE_METRIC = "ReclamoAuthSignupOpsOnlyFromGuestClient";

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome" });
}

/** CSP violations the page reports in its console while `run` goes. */
export async function cspViolations(page: Page, run: () => Promise<void>): Promise<string[]> {
  const violations: string[] = [];
  const listener = (message: { text(): string }) => {
    if (/Content Security Policy|Refused to (?:load|execute|connect|apply)/i.test(message.text())) violations.push(message.text().slice(0, 160));
  };
  page.on("console", listener);
  try {
    await run();
  } finally {
    page.off("console", listener);
  }
  return violations;
}

/** The documents a visitor opens to sign up or to recover a password: each must show its form. */
export const SIGNUP_DOCUMENTS = ["/signup", "/login/recover"] as const;

/**
 * A full navigation to `path` (`Accept: text/html`, as a browser asks) through the edge, with the CSP
 * enforced: the status the edge answered the document with and whether the form's email field showed
 * within 45 s. A WAF interstitial (202 `x-amzn-waf-action: challenge`) that the CSP blocks never shows it.
 */
export async function openForm(page: Page, path: string): Promise<{ readonly status: number; readonly wafAction: string | undefined; readonly shown: boolean }> {
  const response = await page.goto(`${SITE}${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const shown = await page
    .locator('form input[type="email"]')
    .first()
    .waitFor({ state: "visible", timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  return { status: response?.status() ?? 0, wafAction: (await response?.headerValue(WAF_ACTION_HEADER)) ?? undefined, shown };
}

export interface PublicAnswer {
  readonly status: number;
  /** `data.status` of the procedure's answer, when the Bff answered. */
  readonly result?: string;
  /** The edge refused before the Bff: 403 not JSON, or 202 with the challenge header. */
  readonly edgeRefused: boolean;
}

export function publicAnswerOf(status: number, contentType: string, wafAction: string | undefined, body: string): PublicAnswer {
  const json = contentType.toLowerCase().includes("json");
  const edgeRefused = (status === 403 && !json) || (status === 202 && (wafAction ?? "").trim().toLowerCase() === "challenge");
  let result: string | undefined;
  if (json) {
    try {
      const data = (JSON.parse(body) as { result?: { data?: { status?: unknown } } }).result?.data?.status;
      if (typeof data === "string") result = data;
    } catch {
      result = undefined;
    }
  }
  return { status, edgeRefused, ...(result === undefined ? {} : { result }) };
}

/** A public mutation from inside the page (same origin, the page's cookies), sent once. */
export async function publicPostInPage(page: Page, procedure: string, input: unknown): Promise<PublicAnswer> {
  const raw = await page.evaluate(
    async ({ path, body, header }) => {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, contentType: response.headers.get("content-type") ?? "", wafAction: response.headers.get(header) ?? undefined, text: await response.text() };
    },
    { path: `/api/public/${procedure}`, body: input, header: WAF_ACTION_HEADER },
  );
  return publicAnswerOf(raw.status, raw.contentType, raw.wafAction, raw.text);
}

/** The same mutation from the runner, outside any browser. */
export async function publicPostOutside(procedure: string, input: unknown): Promise<PublicAnswer> {
  const page: SitePage = await fetchPage(`/api/public/${procedure}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(input) });
  return publicAnswerOf(page.status, page.headers["content-type"] ?? "", page.headers[WAF_ACTION_HEADER], page.body);
}

/** The console's Cognito client id, read from its own sign-in call, which never leaves the browser. */
const COGNITO_API = /cognito-idp\.[a-z0-9-]+\.amazonaws\.com/;

export async function consoleClientId(page: Page, username: string): Promise<string | undefined> {
  let clientId: string | undefined;
  await page.route(COGNITO_API, async (route) => {
    try {
      const body = JSON.parse(route.request().postData() ?? "{}") as { ClientId?: unknown };
      if (typeof body.ClientId === "string") clientId = body.ClientId;
    } catch {
      // Not a JSON call.
    }
    await route.abort();
  });
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[type="text"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill("Not-a-real-password-1");
  await page.locator('button[type="submit"]').first().click();
  for (let waited = 0; clientId === undefined && waited < 15_000; waited += 500) await page.waitForTimeout(500);
  await page.unroute(COGNITO_API);
  return clientId;
}

const cognito = (): CognitoIdentityProviderClient => new CognitoIdentityProviderClient({ region: REGION, maxAttempts: 2, requestHandler: new NodeHttpHandler({ requestTimeout: 15_000, connectionTimeout: 3_000 }) });

/** `ForgotPassword` straight to Cognito: the error name it answers, or `OK`. */
export async function directForgotPassword(clientId: string, username: string): Promise<string> {
  try {
    await cognito().send(new ForgotPasswordCommand({ ClientId: clientId, Username: username }));
    return "OK";
  } catch (error) {
    return error instanceof Error ? error.name : "Error";
  }
}

/** Requests blocked by rule 1 of the Cognito web ACL since `sinceMs` (`AWS/WAFV2`, 1-minute periods). */
export async function signupOpsBlocked(sinceMs: number, client = new CloudWatchClient({ region: REGION, maxAttempts: 3 })): Promise<number> {
  const answer = await client.send(
    new GetMetricDataCommand({
      StartTime: new Date(sinceMs - 60_000),
      EndTime: new Date(Date.now() + 60_000),
      MetricDataQueries: [
        {
          Id: "blocked",
          MetricStat: {
            Metric: { Namespace: "AWS/WAFV2", MetricName: "BlockedRequests", Dimensions: [{ Name: "WebACL", Value: AUTH_WEB_ACL }, { Name: "Region", Value: REGION }, { Name: "Rule", Value: SIGNUP_OPS_RULE_METRIC }] },
            Period: 60,
            Stat: "Sum",
          },
        },
      ],
    }),
  );
  return (answer.MetricDataResults?.[0]?.Values ?? []).reduce((sum, value) => sum + value, 0);
}
