// Test-only stand-ins for Cognito and `Worlds`: a throwaway RSA key pair, the JWKS a pool would
// publish for it, a signer for id tokens, an in-memory staff directory and an in-memory audit sink.
// Nothing here ships in a Lambda bundle: only *.test.ts and the local UI server import it
// (`auth/no-jwks-override.test.ts` asserts no production module does).
import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import type { Fetcher } from "aws-jwt-verify/https";
import type { Jwk, Jwks } from "aws-jwt-verify/jwk";
import type { StaffRole } from "@reclamo/shared";
import { createLogger } from "../lib/log";
import type { ContextDeps } from "../routers/deps";
import type { AuditEntry, AuditSink } from "./audit";
import { type IdTokenVerifier, createCognitoIdTokenVerifier } from "./jwt";
import { type StaffBySubLookup, type StaffRow, type WorldDirectory, type WorldMeta, type WorldStatus, subKeyOf } from "./staff";

export const TEST_POOL = {
  userPoolId: "us-east-1_TESTPOOL1",
  consoleClientId: "test-console-client",
  serverClientId: "test-server-client",
  region: "us-east-1",
} as const;
export const TEST_ISSUER = `https://cognito-idp.${TEST_POOL.region}.amazonaws.com/${TEST_POOL.userPoolId}`;
export const TEST_SUB = "7f1c9d2e-0000-4000-8000-000000000001";

export type TestClaims = Record<string, unknown>;

export interface TestIssuer {
  readonly kid: string;
  readonly jwks: Jwks;
  /** Serves `jwks`; counts the requests so tests can assert the cache. */
  readonly fetcher: Fetcher & { requests: number };
  /** Signs an id token; `overrides` replace or (with `undefined`) remove default claims. */
  idToken(overrides?: TestClaims, header?: Record<string, unknown>): string;
  verifier(): IdTokenVerifier;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(header: Record<string, unknown>, payload: TestClaims, privateKey: KeyObject): string {
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function createTestIssuer(options: { kid?: string; now?: () => Date } = {}): TestIssuer {
  const kid = options.kid ?? "test-key-1";
  const now = options.now ?? (() => new Date());
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  const jwk: Jwk = { kty: "RSA", n: exported.n ?? "", e: exported.e ?? "", kid, alg: "RS256", use: "sig" };
  const jwks: Jwks = { keys: [jwk] };

  const fetcher: TestIssuer["fetcher"] = {
    requests: 0,
    async fetch() {
      fetcher.requests += 1;
      const bytes = new TextEncoder().encode(JSON.stringify(jwks));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };

  return {
    kid,
    jwks,
    fetcher,
    idToken(overrides = {}, header = {}) {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const payload: TestClaims = {
        sub: TEST_SUB,
        iss: TEST_ISSUER,
        aud: TEST_POOL.consoleClientId,
        token_use: "id",
        auth_time: issuedAt,
        iat: issuedAt,
        exp: issuedAt + 900,
        origin_jti: "0d1c2b3a-0000-4000-8000-00000000a001",
        "cognito:username": "operator-01",
        "cognito:groups": ["OPERATOR"],
        worldId: "demo",
        staffId: "stf-operator-01",
        role: "OPERATOR",
        ...overrides,
      };
      for (const [claim, value] of Object.entries(payload)) if (value === undefined) delete payload[claim];
      return signJwt({ alg: "RS256", typ: "JWT", kid, ...header }, payload, privateKey);
    },
    verifier: () => createCognitoIdTokenVerifier(TEST_POOL, { fetcher }),
  };
}

/** Claims of a token for `staff` as the pre-token trigger would stamp them. */
export function claimsOf(staff: Pick<StaffRow, "worldId" | "staffId" | "role">, username: string, extra: TestClaims = {}): TestClaims {
  return { worldId: staff.worldId, staffId: staff.staffId, role: staff.role, "cognito:username": username, "cognito:groups": [staff.role], ...extra };
}

export function staffRow(worldId: string, staffId: string, role: StaffRole, sub: string = TEST_SUB, extra: Partial<StaffRow> = {}): StaffRow {
  return { worldId, staffId, role, cognitoSubKey: subKeyOf(sub), ...extra };
}

export interface MemoryDirectory extends WorldDirectory, StaffBySubLookup {
  /** Adds or replaces a staff row. */
  putStaff(row: StaffRow): void;
  removeStaff(worldId: string, staffId: string): void;
  setWorld(worldId: string, status: WorldStatus, epoch?: number): void;
  removeWorld(worldId: string): void;
  /** Makes every read fail, as an outage of DynamoDB would. */
  failWith(error: Error | undefined): void;
  readonly reads: { staff: number; meta: number; bySub: number };
}

/** In-memory `Worlds` for tests: `demo` is `READY` with `stf-operator-01` unless told otherwise. */
export function createMemoryDirectory(): MemoryDirectory {
  const staff = new Map<string, StaffRow>();
  const worlds = new Map<string, WorldMeta>();
  const reads = { staff: 0, meta: 0, bySub: 0 };
  let failure: Error | undefined;
  const check = () => {
    if (failure) throw failure;
  };
  return {
    reads,
    putStaff: (row) => void staff.set(`${row.worldId}#${row.staffId}`, row),
    removeStaff: (worldId, staffId) => void staff.delete(`${worldId}#${staffId}`),
    setWorld: (worldId, status, epoch = 1) => void worlds.set(worldId, { worldId, status, epoch }),
    removeWorld: (worldId) => void worlds.delete(worldId),
    failWith: (error) => {
      failure = error;
    },
    async staff(worldId, staffId) {
      reads.staff += 1;
      check();
      return staff.get(`${worldId}#${staffId}`);
    },
    async meta(worldId) {
      reads.meta += 1;
      check();
      return worlds.get(worldId);
    },
    async staffBySub(sub) {
      reads.bySub += 1;
      check();
      return [...staff.values()].filter((row) => row.cognitoSubKey === subKeyOf(sub));
    },
  };
}

export interface MemoryAudit extends AuditSink {
  readonly entries: AuditEntry[];
  /** Makes every write fail. */
  failWith(error: Error | undefined): void;
}

export function createMemoryAudit(): MemoryAudit {
  const entries: AuditEntry[] = [];
  let failure: Error | undefined;
  return {
    entries,
    failWith: (error) => {
      failure = error;
    },
    async record(entry) {
      if (failure) throw failure;
      entries.push(entry);
    },
  };
}

export interface TestDeps {
  readonly issuer: TestIssuer;
  readonly directory: MemoryDirectory;
  readonly audit: MemoryAudit;
  readonly deps: ContextDeps;
  /** Every log line of the requests, as written. */
  readonly lines: string[];
}

/** Console dependencies over the test issuer, an in-memory `Worlds` and an in-memory `AuditLog`. */
export function createTestDeps(options: { now?: () => Date } = {}): TestDeps {
  const issuer = createTestIssuer(options.now ? { now: options.now } : {});
  const directory = createMemoryDirectory();
  const audit = createMemoryAudit();
  const lines: string[] = [];
  const deps: ContextDeps = {
    verifier: issuer.verifier(),
    directory,
    audit,
    wallClock: options.now ?? (() => new Date()),
    loggerFor: (correlationId) => createLogger({ correlationId, sink: (line) => void lines.push(line) }),
  };
  return { issuer, directory, audit, deps, lines };
}
