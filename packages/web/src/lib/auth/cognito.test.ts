import { describe, expect, it } from "vitest";
import { CognitoError, createCognitoApi, regionOfPool } from "./cognito";
import type { FetchRetryOptions } from "../http";

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
  readonly options: FetchRetryOptions | undefined;
}

/** Answers every call with `body`, or with `body[<operation>]` when it is keyed by operation. */
function fakeFetch(status: number, body: unknown, byOperation = false) {
  const sent: Sent[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit, options?: FetchRetryOptions) => {
    const request = { url: String(input), init: init ?? {}, options };
    sent.push(request);
    const operation = (headersOf(request).get("x-amz-target") ?? "").split(".")[1] ?? "";
    const answer = byOperation ? (body as Record<string, unknown>)[operation] : body;
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/x-amz-json-1.1" } });
  };
  return { sent, fetch };
}

function bodyOf(sent: Sent): Record<string, unknown> {
  return JSON.parse(String(sent.init.body)) as Record<string, unknown>;
}

function headersOf(sent: Sent): Headers {
  return new Headers(sent.init.headers);
}

describe("Cognito API over fetch", () => {
  it("starts USER_SRP_AUTH with the public client id and no credentials", async () => {
    const { sent, fetch } = fakeFetch(200, { ChallengeName: "PASSWORD_VERIFIER", ChallengeParameters: { SRP_B: "ab" } });
    const api = createCognitoApi({ region: "us-east-1", clientId: "client-1", fetch });
    const response = await api.initiateSrp("operator-01", "AAAA");
    expect(response.ChallengeName).toBe("PASSWORD_VERIFIER");
    const [request] = sent;
    if (!request) throw new Error("no request");
    expect(request.url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(headersOf(request).get("x-amz-target")).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(headersOf(request).get("content-type")).toBe("application/x-amz-json-1.1");
    expect(request.init.credentials).toBe("omit");
    expect(bodyOf(request)).toEqual({ AuthFlow: "USER_SRP_AUTH", ClientId: "client-1", AuthParameters: { USERNAME: "operator-01", SRP_A: "AAAA" } });
    expect(request.options?.attempts).toBe(3);
  });

  it("sends a challenge answer once: a timeout must not replay a code or a password", async () => {
    const { sent, fetch } = fakeFetch(
      200,
      {
        RespondToAuthChallenge: { AuthenticationResult: { IdToken: "i", AccessToken: "a", RefreshToken: "r", ExpiresIn: 3600 } },
        VerifySoftwareToken: { Status: "SUCCESS" },
      },
      true,
    );
    const api = createCognitoApi({ region: "us-east-1", clientId: "client-1", fetch });
    await api.respondToChallenge("SOFTWARE_TOKEN_MFA", { USERNAME: "u", SOFTWARE_TOKEN_MFA_CODE: "123456" }, "s-1");
    await api.verifySoftwareToken("s-2", "123456");
    for (const request of sent) expect(request.options?.attempts).toBe(1);
    expect(bodyOf(sent[0] as Sent)).toMatchObject({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s-1" });
    expect(bodyOf(sent[1] as Sent)).toEqual({ Session: "s-2", UserCode: "123456", FriendlyDeviceName: "Reclamo en regla" });
  });

  it("turns an error body into a CognitoError by type, namespaced or not", async () => {
    for (const type of ["NotAuthorizedException", "com.amazonaws.cognito.identity.idp.model#NotAuthorizedException"]) {
      const { fetch } = fakeFetch(400, { __type: type, message: "Incorrect username or password." });
      const api = createCognitoApi({ region: "us-east-1", clientId: "c", fetch });
      await expect(api.initiateSrp("a", "b")).rejects.toMatchObject({ name: "CognitoError", type: "NotAuthorizedException" });
    }
  });

  it("rejects an answer that does not have the expected shape", async () => {
    const { fetch } = fakeFetch(200, { SecretCode: 42 });
    const api = createCognitoApi({ region: "us-east-1", clientId: "c", fetch });
    await expect(api.associateSoftwareToken("s")).rejects.toBeInstanceOf(CognitoError);
  });

  it("keeps the refresh token that REFRESH_TOKEN_AUTH does not return", async () => {
    const { sent, fetch } = fakeFetch(200, { AuthenticationResult: { IdToken: "i", AccessToken: "a", ExpiresIn: 3600 } });
    const api = createCognitoApi({ region: "us-east-1", clientId: "c", fetch });
    const result = await api.refresh("r-1");
    expect(result.RefreshToken).toBeUndefined();
    expect(bodyOf(sent[0] as Sent)).toEqual({ AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: "c", AuthParameters: { REFRESH_TOKEN: "r-1" } });
  });

  it("signs out with RevokeToken and never sends the access token anywhere", async () => {
    const { sent, fetch } = fakeFetch(200, { RevokeToken: {} }, true);
    const api = createCognitoApi({ region: "us-east-1", clientId: "c", fetch });
    await api.revoke("r");
    expect(sent.map((request) => headersOf(request).get("x-amz-target"))).toEqual(["AWSCognitoIdentityProviderService.RevokeToken"]);
    expect(bodyOf(sent[0] as Sent)).toEqual({ ClientId: "c", Token: "r" });
    expect(Object.keys(api).sort()).toEqual(["associateSoftwareToken", "initiateSrp", "refresh", "respondToChallenge", "revoke", "verifySoftwareToken"]);
  });
});

describe("regionOfPool", () => {
  it("reads the region prefix of a user pool id", () => {
    expect(regionOfPool("us-east-1_AbC123xyz")).toBe("us-east-1");
    expect(regionOfPool("ap-southeast-2_x1")).toBe("ap-southeast-2");
    expect(regionOfPool("not-a-pool")).toBeUndefined();
  });
});
