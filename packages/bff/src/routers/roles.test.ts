import { TRPCError } from "@trpc/server";
import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { type StaffRole, worldKindOf } from "@reclamo/shared";
import { AUTH_REASON } from "../auth/errors";
import { claimsOf, createTestDeps, staffRow } from "../auth/testing";
import { createHandler } from "./handler";
import { appRouter, createCaller } from "./index";
import { ACCESS, type ProcedurePath, accessProcedure, capTierOf } from "./roles";
import { createContextFactory, router, worldProcedure } from "./trpc";

const AUTH_REASONS: ReadonlySet<string> = new Set(Object.values(AUTH_REASON));
const MINUTE = 60;

const { issuer, directory, audit, deps } = createTestDeps();
const PRINCIPALS: ReadonlyArray<{ role: StaffRole; worldId: string; staffId: string; username: string }> = [
  { role: "OPERATOR", worldId: "demo", staffId: "stf-operator-01", username: "operator-01" },
  { role: "SUPERVISOR", worldId: "demo", staffId: "stf-supervisor-01", username: "supervisor-01" },
  { role: "COMPLIANCE", worldId: "demo", staffId: "stf-compliance-01", username: "compliance-01" },
  { role: "GUEST", worldId: "g03", staffId: "stf-guest-03", username: "guest-03" },
  { role: "SUPERVISOR", worldId: "g03", staffId: "stf-supervisor-g03", username: "supervisor-g03" },
];
directory.setWorld("demo", "READY");
directory.setWorld("g03", "READY");
for (const principal of PRINCIPALS) directory.putStaff(staffRow(principal.worldId, principal.staffId, principal.role));

const contextFor = createContextFactory(() => deps);

function tokenOf(principal: (typeof PRINCIPALS)[number], signedInSecondsAgo = 0): string {
  const now = Math.floor(Date.now() / 1000);
  return issuer.idToken({ ...claimsOf(principal, principal.username), auth_time: now - signedInSecondsAgo, iat: now, exp: now + 15 * MINUTE });
}

/** Calls `path` on the real root router; `null` when it answered, else the tRPC error's reason. */
async function reasonOf(path: string, token: string): Promise<string | null> {
  const caller = createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}` } } }));
  const procedure: unknown = path.split(".").reduce<unknown>((node, key) => Reflect.get(node as object, key), caller);
  try {
    if (typeof procedure !== "function") throw new Error(`no procedure at ${path}`);
    await procedure(undefined);
    return null;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    const cause = error.cause;
    const reason: unknown = cause && typeof cause === "object" ? Reflect.get(cause, "reason") : undefined;
    return typeof reason === "string" ? reason : error.code;
  }
}

function expectedRefusal(path: ProcedurePath, principal: (typeof PRINCIPALS)[number]): string | undefined {
  const rule = ACCESS[path];
  if (rule.type === "mutation" && principal.role === "COMPLIANCE") return AUTH_REASON.READ_ONLY_ROLE;
  if (!rule.roles.includes(principal.role)) return AUTH_REASON.ROLE_NOT_ALLOWED;
  const kinds: readonly string[] | undefined = "worldKinds" in rule ? rule.worldKinds : undefined;
  if (kinds && !kinds.includes(worldKindOf(principal.worldId) ?? "")) return AUTH_REASON.WORLD_NOT_ALLOWED;
  return undefined;
}

const PATHS = Object.keys(ACCESS) as ProcedurePath[];

describe("role matrix of the console [FL-094]", () => {
  it("covers every procedure of the root router, with its declared type; health is the only public one", () => {
    // At runtime the root router keeps its procedures flattened by dotted path.
    const procedures = new Map<string, unknown>(Object.entries(appRouter._def.procedures));
    expect([...procedures.keys()].filter((path) => path !== "health").sort()).toEqual([...PATHS].sort());
    const typeOf = (path: string): unknown => Reflect.get(Reflect.get(procedures.get(path) as object, "_def") as object, "type");
    for (const path of PATHS) expect(typeOf(path), path).toBe(ACCESS[path].type);
    expect(typeOf("health")).toBe("query");
  });

  it("never lists COMPLIANCE among the roles of a mutation", () => {
    for (const path of PATHS) if (ACCESS[path].type === "mutation") expect(ACCESS[path].roles, path).not.toContain("COMPLIANCE");
  });

  it.each(PRINCIPALS.map((principal) => [`${principal.role} in ${principal.worldId}`, principal] as const))("enforces each row for %s", async (_label, principal) => {
    const token = tokenOf(principal);
    for (const path of PATHS) {
      const reason = await reasonOf(path, token);
      const expected = expectedRefusal(path, principal);
      if (expected) expect(reason, path).toBe(expected);
      else expect(AUTH_REASONS.has(reason ?? ""), `${path} answered ${reason}`).toBe(false);
    }
  });

  it("asks for a sign-in of at most 15 minutes exactly where the matrix says", async () => {
    const operator = PRINCIPALS[0]!;
    const supervisor = PRINCIPALS[1]!;
    for (const path of PATHS) {
      const rule = ACCESS[path];
      const principal = rule.roles.includes("OPERATOR") ? operator : supervisor;
      if (expectedRefusal(path, principal)) continue;
      const stale = await reasonOf(path, tokenOf(principal, 20 * MINUTE));
      if ("recentLogin" in rule && rule.recentLogin) expect(stale, path).toBe(AUTH_REASON.LOGIN_NOT_RECENT);
      else expect(stale, path).not.toBe(AUTH_REASON.LOGIN_NOT_RECENT);
    }
    const recentOnly = PATHS.filter((path) => "recentLogin" in ACCESS[path]).sort();
    expect(recentOnly).toEqual(["account.changePassword", "approvals.decide", "clock.reset", "complaints.answer", "policy.setAgentKill"]);
  });

  it("keeps the agent kill switch to a SUPERVISOR of demo, and the password change away from guests", async () => {
    expect(await reasonOf("policy.setAgentKill", tokenOf(PRINCIPALS[1]!))).not.toBe(AUTH_REASON.WORLD_NOT_ALLOWED);
    expect(await reasonOf("policy.setAgentKill", tokenOf(PRINCIPALS[4]!))).toBe(AUTH_REASON.WORLD_NOT_ALLOWED);
    expect(await reasonOf("policy.setAgentKill", tokenOf(PRINCIPALS[0]!))).toBe(AUTH_REASON.ROLE_NOT_ALLOWED);
    expect(await reasonOf("account.changePassword", tokenOf(PRINCIPALS[3]!))).toBe(AUTH_REASON.ROLE_NOT_ALLOWED);
  });

  it("gives the cap tier by role: operator, supervisor above it, a guest as a supervisor of their world", () => {
    expect(capTierOf("OPERATOR")).toBe("OPERATOR");
    expect(capTierOf("SUPERVISOR")).toBe("SUPERVISOR");
    expect(capTierOf("GUEST")).toBe("SUPERVISOR");
    expect(capTierOf("COMPLIANCE")).toBeUndefined();
  });
});

describe("compliance is read-only [FL-095]", () => {
  const compliance = PRINCIPALS[2]!;

  it("refuses every mutation with 403 READ_ONLY_ROLE and audits DENY ROLE, before the procedure runs", async () => {
    audit.entries.length = 0;
    const mutations = PATHS.filter((path) => ACCESS[path].type === "mutation");
    for (const path of mutations) expect(await reasonOf(path, tokenOf(compliance)), path).toBe(AUTH_REASON.READ_ONLY_ROLE);
    expect(audit.entries).toHaveLength(mutations.length);
    for (const entry of audit.entries) {
      expect(entry).toMatchObject({ worldId: "demo", action: "DENY", outcome: "ROLE", actor: "OPERATOR:stf-compliance-01", refs: { staffId: "stf-compliance-01", reason: AUTH_REASON.READ_ONLY_ROLE } });
    }
    expect(audit.entries.map((entry) => entry.refs.path).sort()).toEqual([...mutations].sort());
  });

  it("reads every view it is given: tape, register, emails, metrics, policy and the case", async () => {
    for (const path of ["tape.list", "tape.export", "register.list", "register.verify", "register.export", "emails.get", "metrics.summary", "policy.rules", "complaints.timeline", "clock.get"] as const) {
      expect(AUTH_REASONS.has((await reasonOf(path, tokenOf(compliance))) ?? ""), path).toBe(false);
    }
  });

  it("changes nothing: the resolver of a refused mutation never runs", async () => {
    const effect = vi.fn(() => "written");
    // Also a router that skipped the matrix and used the bare world builder.
    const probe = router({ complaints: router({ note: accessProcedure("complaints.note").mutation(effect), bare: worldProcedure.mutation(effect) }) });
    const callerFor = async (principal: (typeof PRINCIPALS)[number]) => probe.createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${tokenOf(principal)}` } } }));
    const call = async (principal: (typeof PRINCIPALS)[number]) => (await callerFor(principal)).complaints.note();
    await expect(call(compliance)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await callerFor(compliance)).complaints.bare()).rejects.toMatchObject({ code: "FORBIDDEN", cause: { reason: AUTH_REASON.READ_ONLY_ROLE } });
    expect(effect).not.toHaveBeenCalled();
    await expect(call(PRINCIPALS[0]!)).resolves.toBe("written");
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("answers HTTP 403 with the reason over the Function URL", async () => {
    const handler = createHandler(appRouter, contextFor);
    const event: APIGatewayProxyEventV2 = {
      version: "2.0",
      routeKey: "$default",
      rawPath: "/api/complaints.note",
      rawQueryString: "",
      headers: { authorization: `Bearer ${tokenOf(compliance)}`, "content-type": "application/json" },
      body: "{}",
      isBase64Encoded: false,
      requestContext: {
        accountId: "anonymous",
        apiId: "bff-url",
        domainName: "bff-url.lambda-url.us-east-1.on.aws",
        domainPrefix: "bff-url",
        http: { method: "POST", path: "/api/complaints.note", protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
        requestId: "req-roles-0001",
        routeKey: "$default",
        stage: "$default",
        time: "26/Sep/2026:12:00:00 +0000",
        timeEpoch: 1790424000000,
      },
    };
    const response = await handler(event, { awsRequestId: "req-roles-0001" } as LambdaContext);
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain(AUTH_REASON.READ_ONLY_ROLE);
  });
});
