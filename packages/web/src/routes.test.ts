import { describe, expect, it } from "vitest";
import { routeOf } from "./route-match";
import { CONSOLE_HOME, ROUTES, routeAllows } from "./routes";

const byId = (id: string) => {
  const route = ROUTES.find((candidate) => candidate.id === id);
  if (!route) throw new Error(id);
  return route;
};

describe("console routes and the role matrix of docs/design-brief.md §9 [FL-094] [FL-095]", () => {
  it("lands on the inbox and resolves detail paths to their view", () => {
    expect(CONSOLE_HOME).toBe("/app/inbox");
    expect(routeOf("/app/complaints/cmp-0123")?.id).toBe("complaint");
    expect(routeOf("/app/customers/cus-0007")?.id).toBe("customer");
    expect(routeOf("/app/tapex")).toBeUndefined();
  });

  it("opens the read views to every role and keeps compliance out of the hands-on ones", () => {
    for (const id of ["inbox", "complaint", "tape", "register", "emails", "policy", "metrics"]) expect(routeAllows(byId(id), "COMPLIANCE"), id).toBe(true);
    for (const id of ["customer", "approvals", "simulator", "clock"]) expect(routeAllows(byId(id), "COMPLIANCE"), id).toBe(false);
    for (const id of ["simulator", "clock"]) expect(routeAllows(byId(id), "SUPERVISOR"), id).toBe(false);
    for (const route of ROUTES) expect(routeAllows(route, "GUEST"), route.id).toBe(true);
    expect(routeAllows(byId("inbox"), undefined)).toBe(false);
  });
});
