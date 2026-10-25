// Answers the console's Cognito API calls from the page itself (page.route), so the sign-in screens
// run end to end without AWS. Each operation gets a scripted answer; every request body is kept so a
// spec can assert what left the browser (never the password, never the access token).
import type { Page } from "@playwright/test";
import { type FakeClaims, fakeIdToken } from "./session";

export const COGNITO_ENDPOINT = "https://cognito-idp.us-east-1.amazonaws.com/";

export interface CognitoCall {
  readonly operation: string;
  readonly body: string;
}

export type CognitoAnswer = { readonly status?: number; readonly body: unknown };
export type CognitoScript = Readonly<Record<string, CognitoAnswer | ((call: CognitoCall) => CognitoAnswer)>>;

/** A PASSWORD_VERIFIER challenge with well-formed SRP parameters (their values are irrelevant here). */
export const PASSWORD_VERIFIER: CognitoAnswer = {
  body: {
    ChallengeName: "PASSWORD_VERIFIER",
    ChallengeParameters: {
      SALT: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
      SECRET_BLOCK: "c2VjcmV0LWJsb2NrLW9mLXRoZS1lMmUtZmFrZQ==",
      SRP_B: "5a7c".repeat(96),
      USERNAME: "00000000-0000-4000-8000-000000000e2e",
      USER_ID_FOR_SRP: "00000000-0000-4000-8000-000000000e2e",
    },
  },
};

export function tokensAnswer(claims: FakeClaims): CognitoAnswer {
  return { body: { AuthenticationResult: { IdToken: fakeIdToken(claims), AccessToken: "e2e-access", RefreshToken: "e2e-refresh", ExpiresIn: 900 } } };
}

export function cognitoError(type: string, message = type): CognitoAnswer {
  return { status: 400, body: { __type: type, message } };
}

/** Routes the Cognito endpoint to `script`; unscripted operations answer 400, loudly. */
export async function routeCognito(page: Page, script: CognitoScript): Promise<CognitoCall[]> {
  const calls: CognitoCall[] = [];
  await page.route(COGNITO_ENDPOINT, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" } });
      return;
    }
    const operation = (request.headers()["x-amz-target"] ?? "").split(".")[1] ?? "";
    const call = { operation, body: request.postData() ?? "" };
    calls.push(call);
    const entry = script[operation];
    const answer = typeof entry === "function" ? entry(call) : (entry ?? cognitoError("UnscriptedOperation", operation));
    await route.fulfill({
      status: answer.status ?? 200,
      headers: { "content-type": "application/x-amz-json-1.1", "access-control-allow-origin": "*" },
      body: JSON.stringify(answer.body),
    });
  });
  return calls;
}
