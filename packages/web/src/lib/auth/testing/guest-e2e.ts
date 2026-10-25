// Test-only helpers of the access-screen specs (packages/web/e2e/{signup,recover,provisioning,guest-session}.spec.ts):
// the public procedures answered from the page itself (`/api/public/<procedure>`, one per request,
// tRPC v11's plain shape, never a batch), and the id token of a self-signup guest as the pre-token
// trigger stamps it (username = the email, role GUEST, NO group, `worldStatus`). Typed structurally
// so the console's program does not load the browser runner's types. Never real credentials: the
// addresses are the SES mailbox simulator's, the tokens are unsigned and only reach page.route.

/** What a spec needs of Playwright's route (a structural subset of `Route`). */
export interface RouteHandle {
  request(): { method(): string; url(): string; postData(): string | null };
  fulfill(response: { status?: number; headers?: Record<string, string>; body?: string }): Promise<void>;
}

export interface RoutablePage {
  route(url: string, handler: (route: RouteHandle) => Promise<void>): Promise<unknown>;
}

export type PublicProcedure = "signup.availability" | "signup.start" | "signup.confirm" | "signup.resend" | "password.forgot" | "password.reset";

export interface PublicCall {
  readonly procedure: string;
  readonly method: string;
  readonly input: unknown;
  /** The raw query: a spec asserts nothing personal ever travels in a URL. */
  readonly search: string;
}

/** The BFF's answer (`{ status: … }` data), or what the edge says before it (a WAF challenge, a 429). */
export type PublicAnswer = { readonly data: unknown } | { readonly http: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: string };

export const WAF_CHALLENGE: PublicAnswer = { http: 202, headers: { "x-amzn-waf-action": "challenge" }, body: "" };
export const EDGE_RATE_LIMITED: PublicAnswer = { http: 429, headers: { "content-type": "application/json" }, body: '{"error":"RATE_LIMITED"}' };

/** A synthetic sign-up address of a spec: the SES mailbox simulator, never a person's (`key` = `su<n>`). */
export function simulatorEmail(key: string): string {
  return `success+qa-e2e-${key}@simulator.amazonses.com`;
}

/** The only world that address may hold under the identity invariant (docs/architecture-guests.md §3). */
export function simulatorWorld(key: string): string {
  return `qa-e2e-${key}`;
}

/** Routes `/api/public/**` to `script`; every call is kept with its input. Register after any `/api/**` route. */
export async function routePublicApi(page: RoutablePage, script: (call: PublicCall) => PublicAnswer): Promise<PublicCall[]> {
  const calls: PublicCall[] = [];
  await page.route("**/api/public/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw = request.postData();
    const call: PublicCall = { procedure: decodeURIComponent(url.pathname.replace(/^\/api\/public\//, "")), method: request.method(), input: raw ? (JSON.parse(raw) as unknown) : undefined, search: url.search };
    calls.push(call);
    const answer = script(call);
    if ("data" in answer) {
      await route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ result: { data: answer.data } }) });
      return;
    }
    await route.fulfill({ status: answer.http, headers: { ...(answer.headers ?? {}) }, body: answer.body ?? "" });
  });
  return calls;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SelfSignupClaims {
  readonly email: string;
  /** `gs-<10 base32>`. */
  readonly worldId: string;
  readonly worldStatus?: string;
  /** Seconds from now. */
  readonly expiresIn?: number;
}

export const SELF_SIGNUP_SUB = "00000000-0000-4000-8000-0000000055e2";

/** The id token of a self-signup guest: the email as username, role GUEST, no `cognito:groups`. */
export function selfSignupIdToken(claims: SelfSignupClaims, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const payload = {
    sub: SELF_SIGNUP_SUB,
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_e2e",
    aud: "e2e-client",
    iat: now,
    auth_time: now,
    exp: now + (claims.expiresIn ?? 900),
    token_use: "id",
    "cognito:username": claims.email,
    worldId: claims.worldId,
    staffId: `stf-${claims.worldId}`,
    role: "GUEST",
    worldStatus: claims.worldStatus ?? "READY",
  };
  return `${base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}.e2e`;
}

/** What the console keeps in sessionStorage for that guest (lib/auth/tokens.ts). */
export function selfSignupTokens(claims: SelfSignupClaims, refreshToken?: string) {
  return {
    idToken: selfSignupIdToken(claims),
    accessToken: "e2e-access-self-signup",
    expiresAt: Date.now() + (claims.expiresIn ?? 900) * 1_000,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

/** Cognito's answer to the SRP proof for that guest (InitiateAuth gets support/cognito-route.ts's PASSWORD_VERIFIER). */
export function selfSignupAuthResult(claims: SelfSignupClaims) {
  return { body: { AuthenticationResult: { IdToken: selfSignupIdToken(claims), AccessToken: "e2e-access-self-signup", RefreshToken: "e2e-refresh-self-signup", ExpiresIn: 900 } } };
}
