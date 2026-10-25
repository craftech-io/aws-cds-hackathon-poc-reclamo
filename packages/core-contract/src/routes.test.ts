import { describe, expect, it } from "vitest";
import { z } from "zod";
import { coreRoutes } from "./core-routes";
import { networksRoutes } from "./networks-routes";
import { type RouteSpec, type RouteTable, fillPath, findRoute, matchPath, pathParamNames } from "./routes";

const HASH = "a".repeat(64);

describe("path templates", () => {
  it("lists placeholders in order", () => {
    expect(pathParamNames("/v1/{worldId}/settlements/{network}/{businessDate}/publish")).toEqual(["worldId", "network", "businessDate"]);
    expect(pathParamNames("/v1/health")).toEqual([]);
  });

  it("fills and matches a path, encoding each value as one segment", () => {
    const path = fillPath("/v1/{worldId}/loans/{loanId}", { worldId: "demo", loanId: "L-0001" });
    expect(path).toBe("/v1/demo/loans/L-0001");
    expect(matchPath("/v1/{worldId}/loans/{loanId}", path)).toEqual({ worldId: "demo", loanId: "L-0001" });

    const odd = fillPath("/v1/{worldId}/loans/{loanId}", { worldId: "demo", loanId: "a/b c" });
    expect(odd).toBe("/v1/demo/loans/a%2Fb%20c");
    expect(matchPath("/v1/{worldId}/loans/{loanId}", odd)).toEqual({ worldId: "demo", loanId: "a/b c" });
  });

  it("refuses a missing or empty value", () => {
    expect(() => fillPath("/v1/{worldId}/loans/{loanId}", { worldId: "demo" })).toThrow('missing path parameter "loanId"');
    expect(() => fillPath("/v1/{worldId}/loans/{loanId}", { worldId: "demo", loanId: "" })).toThrow();
  });

  it("does not match another shape, an empty segment or a malformed escape", () => {
    expect(matchPath("/v1/{worldId}/loans/{loanId}", "/v1/demo/loans")).toBeUndefined();
    expect(matchPath("/v1/{worldId}/loans/{loanId}", "/v1/demo/charges/C-1")).toBeUndefined();
    expect(matchPath("/v1/{worldId}/loans/{loanId}", "/v1/demo/loans/")).toBeUndefined();
    expect(matchPath("/v1/{worldId}/loans/{loanId}", "/v1/demo/loans/%E0%A4%A")).toBeUndefined();
  });
});

// Two routes overlap when every segment could be the same: equal literals, or a placeholder whose
// schema accepts the other route's literal (or another placeholder).
function ambiguousPairs(routes: RouteTable): string[] {
  const segmentAccepts = (route: RouteSpec, segment: string, other: string): boolean => {
    const name = /^\{(.+)\}$/.exec(segment)?.[1];
    if (name === undefined) return segment === other || other.startsWith("{");
    if (other.startsWith("{")) return true;
    const schema = route.params.shape[name] as z.ZodType | undefined;
    return schema?.safeParse(other).success ?? false;
  };
  const entries = Object.entries(routes);
  const pairs: string[] = [];
  for (const [i, [nameA, a]] of entries.entries()) {
    for (const [nameB, b] of entries.slice(i + 1)) {
      const sa = a.path.split("/");
      const sb = b.path.split("/");
      if (a.method !== b.method || sa.length !== sb.length) continue;
      const overlap = sa.every((segment, index) => {
        const other = sb[index] ?? "";
        return segmentAccepts(a, segment, other) && segmentAccepts(b, other, segment);
      });
      if (overlap) pairs.push(`${nameA} ~ ${nameB}`);
    }
  }
  return pairs;
}

describe("route tables", () => {
  it("have no two routes that could answer the same request", () => {
    // customers/by-phone/{phoneHash} and customers/{customerId}/operations have the same shape, but
    // "by-phone" is not a customer id and "operations" is not a phone hash.
    expect(ambiguousPairs(coreRoutes)).toEqual([]);
    expect(ambiguousPairs(networksRoutes)).toEqual([]);
  });

  it("would notice two routes with the same shape", () => {
    const shape = { worldId: z.string(), thingId: z.string() };
    const probe = {
      one: { method: "get", path: "/v1/{worldId}/things/{thingId}", params: z.object(shape), ok: z.string(), errors: [] },
      two: { method: "get", path: "/v1/{worldId}/things/latest", params: z.object({ worldId: z.string() }), ok: z.string(), errors: [] },
    } satisfies RouteTable;
    expect(ambiguousPairs(probe)).toEqual(["one ~ two"]);
  });

  it("route every sample request to its operation", () => {
    const cases: Array<[RouteTable, string, string, string]> = [
      [coreRoutes, "GET", `/v1/demo/customers/by-phone/${HASH}`, "getCustomerByPhone"],
      [coreRoutes, "GET", "/v1/demo/customers/cus-0001", "getCustomer"],
      [coreRoutes, "GET", "/v1/demo/customers/cus-0001/operations", "listOperations"],
      [coreRoutes, "POST", "/v1/demo/customers/cus-0001/challenge-check", "checkChallenge"],
      [coreRoutes, "POST", "/v1/g01/loans/L-0001/payments", "applyPayment"],
      [coreRoutes, "POST", "/v1/qa-r1-sc02/refunds", "refundDuplicateDebit"],
      [coreRoutes, "POST", "/v1/demo/wallets/cus-0006/freeze", "setOutgoingFreeze"],
      [coreRoutes, "GET", "/v1/health", "getCoreHealth"],
      [networksRoutes, "POST", "/v1/demo/settlements/NORTE/2026-10-07/publish", "publishSettlement"],
      [networksRoutes, "GET", "/v1/demo/settlements/SUR", "listSettlements"],
      [networksRoutes, "POST", "/v1/demo/transfers/TRF-30/reversal-request", "requestTransferReversal"],
      [networksRoutes, "GET", "/v1/health", "getNetworksHealth"],
    ];
    for (const [routes, method, path, operationId] of cases) expect(findRoute(routes, method, path)?.operationId, path).toBe(operationId);
  });

  it("answers nothing for an unknown path or method", () => {
    expect(findRoute(coreRoutes, "DELETE", "/v1/demo/customers/cus-0001")).toBeUndefined();
    expect(findRoute(coreRoutes, "GET", "/v2/demo/customers/cus-0001")).toBeUndefined();
    expect(findRoute(networksRoutes, "GET", "/v1/demo/collections")).toBeUndefined();
  });

  it("parse the matched params with the route's schemas", () => {
    const match = findRoute(networksRoutes, "POST", "/v1/demo/settlements/NORTE/2026-10-07/publish");
    expect(match?.route.params.parse(match.params)).toEqual({ worldId: "demo", network: "NORTE", businessDate: "2026-10-07" });
    const wrong = findRoute(networksRoutes, "POST", "/v1/demo/settlements/OESTE/2026-10-07/publish");
    expect(wrong?.route.params.safeParse(wrong.params).success).toBe(false);
  });

  it("require the simulated instant on every world route and nowhere else", () => {
    for (const routes of [coreRoutes, networksRoutes] as RouteTable[]) {
      for (const [operationId, route] of Object.entries(routes)) {
        const world = route.path.startsWith("/v1/{worldId}/");
        expect(route.headers?.safeParse({}).success ?? true, operationId).toBe(!world);
        if (world) expect(route.headers?.safeParse({ "x-sim-now": "2026-10-07T10:10:00-03:00", host: "x" }).success, operationId).toBe(true);
      }
    }
  });
});
