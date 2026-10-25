// Route table of the console: one entry per view of docs/design-brief.md §9, with the roles that
// may open it. console-routes.tsx matches the path; the AppShell builds the navigation from the same
// table (entries with `nav: false` open from a link, e.g. a complaint of the inbox).
import type { StaffRole } from "@reclamo/shared";
import { copy } from "./copy/console";

export type RouteId = keyof typeof copy.views;

export type NavGroup = keyof typeof copy.nav.groups;

export interface ConsoleRoute {
  readonly id: RouteId;
  readonly path: string;
  readonly group: NavGroup;
  /** Roles allowed in; "ALL" means every console role (COMPLIANCE read-only). */
  readonly roles: readonly StaffRole[] | "ALL";
  /** False for detail views reached by a link (`/app/complaints/:id`). */
  readonly nav: boolean;
}

export const CONSOLE_PREFIX = "/app";

const HANDS_ON: readonly StaffRole[] = ["OPERATOR", "SUPERVISOR", "GUEST"];
const DEMO: readonly StaffRole[] = ["OPERATOR", "GUEST"];

export const ROUTES: readonly ConsoleRoute[] = [
  { id: "inbox", path: `${CONSOLE_PREFIX}/inbox`, group: "complaints", roles: "ALL", nav: true },
  { id: "complaint", path: `${CONSOLE_PREFIX}/complaints`, group: "complaints", roles: "ALL", nav: false },
  { id: "customer", path: `${CONSOLE_PREFIX}/customers`, group: "complaints", roles: HANDS_ON, nav: false },
  { id: "approvals", path: `${CONSOLE_PREFIX}/approvals`, group: "complaints", roles: HANDS_ON, nav: true },
  { id: "tape", path: `${CONSOLE_PREFIX}/tape`, group: "compliance", roles: "ALL", nav: true },
  { id: "register", path: `${CONSOLE_PREFIX}/register`, group: "compliance", roles: "ALL", nav: true },
  { id: "emails", path: `${CONSOLE_PREFIX}/emails`, group: "compliance", roles: "ALL", nav: true },
  { id: "policy", path: `${CONSOLE_PREFIX}/policy`, group: "compliance", roles: "ALL", nav: true },
  { id: "metrics", path: `${CONSOLE_PREFIX}/metrics`, group: "compliance", roles: "ALL", nav: true },
  { id: "simulator", path: `${CONSOLE_PREFIX}/simulator`, group: "demo", roles: DEMO, nav: true },
  { id: "clock", path: `${CONSOLE_PREFIX}/clock`, group: "demo", roles: DEMO, nav: true },
  { id: "tour", path: `${CONSOLE_PREFIX}/tour`, group: "demo", roles: "ALL", nav: true },
];

export const LOGIN_PATH = "/login";

/** The public welcome page of the demo (views/landing). */
export const LANDING_PATH = "/";

// The self-signup and the password recovery (docs/landing-spec.md §9.1). `/signup` and
// `/login/recover` are always reached by a full page load (a plain `<a href>`), never by the SPA's
// router: the edge firewall challenges only a real `GET` of those documents
// (docs/architecture-guests.md §8). The steps after them are SPA navigations, so what the person
// typed stays in memory.
export const SIGNUP_PATH = "/signup";
export const SIGNUP_VERIFY_PATH = "/signup/verify";
export const PROVISIONING_PATH = "/signup/provisioning";
export const RECOVER_PATH = "/login/recover";
export const RECOVER_RESET_PATH = "/login/recover/reset";

/** `/login?notice=…`: the account was just confirmed, or its password just changed (the email comes pre-filled). */
export const LOGIN_NOTICE = { param: "notice", confirmed: "confirmed", passwordChanged: "password-changed" } as const;

/** `/signup?restart=1`: the code of an earlier form no longer works (`SIGNUP_RESTART`). */
export const SIGNUP_RESTART_PARAM = "restart";

/** Where a sign-in lands when nothing asked for another view. */
export const CONSOLE_HOME = `${CONSOLE_PREFIX}/inbox`;

export function routeAllows(route: ConsoleRoute, role: StaffRole | undefined): boolean {
  if (route.roles === "ALL") return role !== undefined;
  return role !== undefined && route.roles.includes(role);
}

export function routeTitle(route: ConsoleRoute): string {
  return copy.views[route.id].title;
}
