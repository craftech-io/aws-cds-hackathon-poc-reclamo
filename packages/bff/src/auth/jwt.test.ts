import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { FetchError } from "aws-jwt-verify/error";
import { describe, expect, it } from "vitest";
import { createLogger } from "../lib/log";
import { createCaller } from "../routers/index";
import { createContextFactory } from "../routers/trpc";
import { authenticateToken } from "./authenticate";
import { AUTH_REASON, AUTH_REFUSAL, AuthError } from "./errors";
import { bearerToken, createCognitoIdTokenVerifier } from "./jwt";
import { TEST_POOL, claimsOf, createMemoryAudit, createMemoryDirectory, createTestIssuer, staffRow } from "./testing";

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.reason;
    throw error;
  }
  throw new Error("expected the verification to fail");
}

describe("Cognito id token verification with an ephemeral key [FL-094]", () => {
  const issuer = createTestIssuer();
  const verifier = issuer.verifier();

  it("accepts a token signed by the pool for ConsoleClient and returns its claims and audience", async () => {
    const { claims, audience } = await verifier.verify(issuer.idToken());
    expect(claims.sub).toBe("7f1c9d2e-0000-4000-8000-000000000001");
    expect(claims.worldId).toBe("demo");
    expect(claims.role).toBe("OPERATOR");
    expect(claims.token_use).toBe("id");
    expect(audience).toBe("console");
  });

  it("accepts the ServerClient audience and says so, so the BFF can apply the qa-* rule", async () => {
    const { audience } = await verifier.verify(issuer.idToken({ aud: TEST_POOL.serverClientId, "cognito:username": "qa-r1-sc18-operator" }));
    expect(audience).toBe("server");
  });

  it("fetches the JWKS once and serves later tokens from the cache", async () => {
    const fresh = createTestIssuer();
    const cached = fresh.verifier();
    await cached.verify(fresh.idToken());
    await cached.verify(fresh.idToken({ sub: "another-user" }));
    expect(fresh.fetcher.requests).toBe(1);
  });

  it("verifies offline against a key set cached up front, without any fetch", async () => {
    const local = createTestIssuer();
    const offline = createCognitoIdTokenVerifier(TEST_POOL, {
      jwks: local.jwks,
      fetcher: { fetch: () => Promise.reject(new FetchError("https://cognito-idp.test/jwks.json", "no network")) },
    });
    expect((await offline.verify(local.idToken())).claims.worldId).toBe("demo");
  });

  it("rejects a token signed with another key under the same kid", async () => {
    const forger = createTestIssuer({ kid: issuer.kid });
    expect(await reasonOf(verifier.verify(forger.idToken()))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const [header, , signature] = issuer.idToken().split(".");
    const [, forgedPayload] = issuer.idToken({ worldId: "g01" }).split(".");
    expect(await reasonOf(verifier.verify(`${header}.${forgedPayload}.${signature}`))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects an unsigned token (alg none)", async () => {
    const [, payload] = issuer.idToken().split(".");
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: issuer.kid })).toString("base64url");
    expect(await reasonOf(verifier.verify(`${header}.${payload}.`))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects an expired token as TOKEN_EXPIRED", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    expect(await reasonOf(verifier.verify(issuer.idToken({ iat: past, auth_time: past, exp: past + 900 })))).toBe(AUTH_REASON.TOKEN_EXPIRED);
  });

  it("rejects an access token", async () => {
    const token = issuer.idToken({ token_use: "access", client_id: TEST_POOL.consoleClientId, aud: undefined });
    expect(await reasonOf(verifier.verify(token))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects a token of another user pool", async () => {
    const token = issuer.idToken({ iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHERPOOL" });
    expect(await reasonOf(verifier.verify(token))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects a token without auth_time: the recent-login window could not be evaluated", async () => {
    expect(await reasonOf(verifier.verify(issuer.idToken({ auth_time: undefined })))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects garbage", async () => {
    expect(await reasonOf(verifier.verify("not-a-jwt"))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("reports an outage, not a bad token, when the JWKS cannot be fetched", async () => {
    const offline = createCognitoIdTokenVerifier(TEST_POOL, {
      fetcher: { fetch: () => Promise.reject(new FetchError("https://cognito-idp.test/jwks.json", "socket hang up")) },
    });
    expect(await reasonOf(offline.verify(issuer.idToken()))).toBe(AUTH_REASON.AUTH_UNAVAILABLE);
  });
});

describe("audiences of the BFF: ConsoleClient, and ServerClient only for qa-* [FL-094]", () => {
  const issuer = createTestIssuer();
  const directory = createMemoryDirectory();
  const qaRow = staffRow("qa-r1-smk", "stf-qa-operator", "OPERATOR");
  const demoRow = staffRow("demo", "stf-operator-01", "OPERATOR");
  directory.putStaff(qaRow);
  directory.putStaff(demoRow);
  directory.setWorld("qa-r1-smk", "READY");
  directory.setWorld("demo", "READY");
  const deps = { verifier: issuer.verifier(), directory };
  const server = { aud: TEST_POOL.serverClientId };

  const authenticate = (claims: Record<string, unknown>) => authenticateToken(`Bearer ${issuer.idToken(claims)}`, deps);

  // HTTP status the console receives, through the real root router and its middlewares.
  async function httpStatusOf(claims: Record<string, unknown>): Promise<number> {
    const context = await createContextFactory(() => ({ ...deps, audit: createMemoryAudit(), wallClock: () => new Date(), loggerFor: (id) => createLogger({ correlationId: id, sink: () => undefined }) }))({
      event: { headers: { authorization: `Bearer ${issuer.idToken(claims)}` } },
    });
    try {
      await createCaller(context).inbox.list();
    } catch (error) {
      if (error instanceof TRPCError) return getHTTPStatusCodeFromError(error);
      throw error;
    }
    return 200;
  }

  it("accepts ConsoleClient for a staff row of the token's world", async () => {
    const outcome = await authenticate(claimsOf(demoRow, "operator-01"));
    expect(outcome).toMatchObject({ ok: true, principal: { audience: "console", worldId: "demo", staffId: "stf-operator-01" } });
  });

  it("accepts ServerClient for a qa-* user whose staff row is in a qa-* world", async () => {
    const outcome = await authenticate({ ...server, ...claimsOf(qaRow, "qa-r1-smk-operator") });
    expect(outcome).toMatchObject({ ok: true, principal: { audience: "server", worldId: "qa-r1-smk" } });
    // Past authentication the procedure answers whatever it answers, never 401 or 403.
    expect([401, 403]).not.toContain(await httpStatusOf({ ...server, ...claimsOf(qaRow, "qa-r1-smk-operator") }));
  });

  it("refuses with 401 a ServerClient token of a user that is not qa-*", async () => {
    const outcome = await authenticate({ ...server, ...claimsOf(qaRow, "operator-01") });
    expect(outcome).toMatchObject({ ok: false, error: { reason: AUTH_REASON.SERVER_CLIENT_AUDIENCE } });
    expect(AUTH_REFUSAL[AUTH_REASON.SERVER_CLIENT_AUDIENCE]).toBe("UNAUTHENTICATED");
    expect(await httpStatusOf({ ...server, ...claimsOf(qaRow, "operator-01") })).toBe(401);
  });

  it("refuses with 401 a ServerClient token of a qa-* user whose staff row points to a world that is not qa-*", async () => {
    const outcome = await authenticate({ ...server, ...claimsOf(demoRow, "qa-r1-smk-operator") });
    expect(outcome).toMatchObject({ ok: false, error: { reason: AUTH_REASON.SERVER_CLIENT_AUDIENCE } });
    expect(await httpStatusOf({ ...server, ...claimsOf(demoRow, "qa-r1-smk-operator") })).toBe(401);
  });

  it("refuses with 401 a ServerClient token of a qa-* user without a staff row for its sub", async () => {
    expect(await httpStatusOf({ ...server, ...claimsOf(qaRow, "qa-r1-smk-operator"), sub: "someone-else" })).toBe(401);
  });

  it("refuses with 401 a token of a foreign audience", async () => {
    const outcome = await authenticate({ ...claimsOf(demoRow, "operator-01"), aud: "some-other-client" });
    expect(outcome).toMatchObject({ ok: false, error: { reason: AUTH_REASON.TOKEN_INVALID } });
    expect(await httpStatusOf({ ...claimsOf(demoRow, "operator-01"), aud: "some-other-client" })).toBe(401);
  });
});

describe("bearerToken", () => {
  it("extracts the token, whatever the case of the scheme", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it.each([undefined, "", "Basic dXNlcjpwYXNz", "Bearer", "Bearer a b"])("refuses %j as TOKEN_MISSING", (value) => {
    expect(() => bearerToken(value)).toThrowError(expect.objectContaining({ reason: AUTH_REASON.TOKEN_MISSING }));
  });
});
