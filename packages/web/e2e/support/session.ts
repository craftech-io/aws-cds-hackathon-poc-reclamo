// Sessions for the specs: an unsigned id token with the claims the console decodes (the ones the
// pre-token trigger stamps: worldId, staffId, role), planted in sessionStorage before the app boots.
// The console never verifies signatures (the BFF does), and no request with it leaves the local
// server. Tokens live in sessionStorage only, which Playwright's storage state does not carry.
import type { Page } from "@playwright/test";
import type { StaffRole } from "@reclamo/shared";
import { TOKENS_KEY } from "../../src/lib/auth/tokens.ts";

export { TOKENS_KEY };

export interface FakeClaims {
  readonly username: string;
  readonly role: StaffRole;
  readonly worldId: string;
  /** Seconds from now; negative = already expired. */
  readonly expiresIn?: number;
  /** Seconds ago of the interactive sign-in (`auth_time`). */
  readonly signedInAgo?: number;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function fakeIdToken(claims: FakeClaims): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: `00000000-0000-4000-8000-${Buffer.from(claims.username).toString("hex").slice(0, 12).padEnd(12, "0")}`,
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_e2e",
    aud: "e2e-client",
    iat: now,
    auth_time: now - (claims.signedInAgo ?? 0),
    exp: now + (claims.expiresIn ?? 900),
    token_use: "id",
    "cognito:username": claims.username,
    "cognito:groups": [claims.role],
    worldId: claims.worldId,
    staffId: `stf-${claims.username}`,
    role: claims.role,
  };
  return `${base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}.e2e`;
}

export function tokenSet(claims: FakeClaims, refreshToken?: string) {
  return {
    idToken: fakeIdToken(claims),
    accessToken: `e2e-access-${claims.username}`,
    expiresAt: Date.now() + (claims.expiresIn ?? 900) * 1_000,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

/** Plants a token set before any script of the page runs, only on the first load of the tab. */
export async function plantSession(page: Page, claims: FakeClaims, refreshToken?: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(tokenSet(claims, refreshToken)) },
  );
}

/** Replaces the stored tokens without a reload, as a refresh or an injected session would. */
export async function replaceSession(page: Page, claims: FakeClaims): Promise<void> {
  await page.evaluate(({ key, value }) => window.sessionStorage.setItem(key, value), { key: TOKENS_KEY, value: JSON.stringify(tokenSet(claims)) });
}
