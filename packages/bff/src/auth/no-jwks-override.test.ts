// The Lambda verifies tokens against the JWKS of its own pool, and nothing a request carries (a header,
// a body, a query string) can change where the keys come from. The local UI server injects an
// ephemeral key set with the verifier's `cacheJwks`, but only by building its own verifier: the
// handler exposes no such seam (docs/test-plan.md §2, level UI).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_POOL, createTestIssuer } from "./testing";

// vi.mock factories are hoisted above the imports: the link is spelled out, not imported.
const TEST_POOL_LINK = vi.hoisted(() => ({
  userPoolId: "us-east-1_TESTPOOL1",
  consoleClientId: "test-console-client",
  serverClientId: "test-server-client",
  region: "us-east-1",
}));

const jwksRequests = vi.hoisted(() => ({ uris: [] as string[], body: new ArrayBuffer(0) }));

// The edge key only lets the request reach the handler (routers/edge-guard.ts); it is not a JWKS seam.
const EDGE_KEY = vi.hoisted(() => "edge-key-of-the-test-0123456789abcdef");
vi.mock("sst", () => ({ Resource: { App: { name: "reclamo", stage: "poc" }, Auth: { ...TEST_POOL_LINK }, EdgeOriginKey: { value: EDGE_KEY } } }));
vi.mock("aws-jwt-verify/https", async (importOriginal) => {
  const original = await importOriginal<typeof import("aws-jwt-verify/https")>();
  return {
    ...original,
    fetch: async (uri: string) => {
      jwksRequests.uris.push(uri);
      return jwksRequests.body;
    },
  };
});

const lambdaContext = { awsRequestId: "req-jwks-0001", getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

function event(headers: Record<string, string>, body?: string, rawQueryString = ""): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/api/inbox.list",
    rawQueryString,
    headers,
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body }),
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method: "GET", path: "/api/inbox.list", protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
      requestId: "req-jwks-0001",
      routeKey: "$default",
      stage: "$default",
      time: "26/Sep/2026:12:00:00 +0000",
      timeEpoch: 1790424000000,
    },
  };
}

function bytesOf(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

afterEach(async () => {
  jwksRequests.uris.length = 0;
  (await import("../routers/deps")).resetDefaultDeps();
});

describe("no JWKS override from the Lambda handler [FL-094]", () => {
  it("exports only the handler, the factory over an explicit context and the path helper", async () => {
    const module = await import("../routers/handler");
    expect(Object.keys(module).sort()).toEqual(["API_PREFIX", "createHandler", "handler", "stripApiPrefix"]);
    const { defaultDeps } = await import("../routers/deps");
    expect(defaultDeps.length).toBe(0);
    expect(TEST_POOL_LINK).toEqual(TEST_POOL);
  });

  it("verifies against the pool's own JWKS and ignores keys a request carries", async () => {
    const pool = createTestIssuer();
    const forger = createTestIssuer({ kid: pool.kid });
    jwksRequests.body = bytesOf(pool.jwks);
    const { handler } = await import("../routers/handler");
    const forgedJwks = JSON.stringify(forger.jwks);
    const response = await handler(
      event(
        { authorization: `Bearer ${forger.idToken()}`, "x-reclamo-edge": EDGE_KEY, "x-jwks": forgedJwks, "x-jwks-uri": "https://attacker.test/jwks.json" },
        JSON.stringify({ jwks: forger.jwks }),
        `jwks=${encodeURIComponent(forgedJwks)}`,
      ),
      lambdaContext,
    );
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("TOKEN_INVALID");
    expect(jwksRequests.uris).toEqual([`https://cognito-idp.us-east-1.amazonaws.com/${TEST_POOL.userPoolId}/.well-known/jwks.json`]);
  });

  it("leaves only `verify` on the verifier the handler uses: no cacheJwks, no fetcher", async () => {
    const { defaultDeps } = await import("../routers/deps");
    expect(Object.keys(defaultDeps().verifier)).toEqual(["verify"]);
    const { createCognitoIdTokenVerifier } = await import("./jwt");
    expect(Object.keys(createCognitoIdTokenVerifier(TEST_POOL))).toEqual(["verify"]);
  });

  it("keeps the key-set seams out of every production module", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && entry !== "testing.ts") files.push(path);
      }
    };
    walk(root);
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const name = relative(root, file);
      const found: string[] = [];
      if (/from "[^"]*\/testing"/.test(source)) found.push(`${name}: imports a testing module`);
      if (name === join("auth", "jwt.ts")) return found;
      if (/cacheJwks|SimpleJwksCache|aws-jwt-verify\/https/.test(source)) found.push(`${name}: touches the JWKS cache`);
      if (/createCognitoIdTokenVerifier\((?:[^(),]|\([^()]*\))*,/.test(source)) found.push(`${name}: passes verifier options`);
      return found;
    });
    expect(offenders).toEqual([]);
  });
});
