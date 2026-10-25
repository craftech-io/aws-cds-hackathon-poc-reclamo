// Who may call each console procedure: the role matrix of docs/design-brief.md §9 and the W/R marks
// of docs/tool-catalog.md ("Procedimientos de la consola") as data, in one place. Every feature
// router builds its procedures with `accessProcedure("<router>.<procedure>")`, and
// routers/roles.test.ts calls every procedure of the real `appRouter` with every role to prove the
// router enforces exactly its row (and that COMPLIANCE never reaches a mutation, FL-095).
//
//   type          query or mutation: every mutation refuses COMPLIANCE whatever `roles` says
//   roles         who may call it
//   recentLogin   interactive sign-in at most 15 minutes old (real clock): money, written answers,
//                 world reset, the agent kill switch and the password change (ADR-0005)
//   worldKinds    classes of world where the procedure exists (the kill switch only in `demo`)
import type { CapTier, StaffRole } from "@reclamo/shared";
import { ALL_ROLES, type AccessGuard, guardedProcedure } from "./trpc";

export type ProcedureType = "query" | "mutation";

export interface AccessRule extends AccessGuard {
  readonly type: ProcedureType;
}

/** Case work: the operator's actions, which a supervisor and a guest (in their own world) share. */
const CASE_WORK: readonly StaffRole[] = ["OPERATOR", "SUPERVISOR", "GUEST"];
/** Who drives a world: the phone simulator, the live clock, the reset and the guided tour. */
const WORLD_DRIVERS: readonly StaffRole[] = ["OPERATOR", "GUEST"];
/** Personal staff accounts: guest accounts are shared and keep their password. */
const PERSONAL_ACCOUNTS: readonly StaffRole[] = ["OPERATOR", "SUPERVISOR"];

const read = (roles: readonly StaffRole[] = ALL_ROLES): AccessRule => ({ type: "query", roles });
const write = (roles: readonly StaffRole[], extra: Omit<AccessGuard, "roles"> = {}): AccessRule => ({ type: "mutation", roles, ...extra });
const RECENT = { recentLogin: true } as const;

export const ACCESS = {
  "inbox.list": read(),

  "complaints.get": read(),
  "complaints.timeline": read(),
  "complaints.evidenceUrl": read(),
  "complaints.answer": write(CASE_WORK, RECENT),
  "complaints.escalate": write(CASE_WORK),
  "complaints.note": write(CASE_WORK),

  "conversation.take": write(CASE_WORK),
  "conversation.release": write(CASE_WORK),
  "conversation.send": write(CASE_WORK),
  "conversation.reroute": write(CASE_WORK),

  "customers.get": read(CASE_WORK),
  "customers.compose": write(CASE_WORK),
  "customers.unlockChallenge": write(CASE_WORK),

  "approvals.list": read(CASE_WORK),
  "approvals.decide": write(CASE_WORK, RECENT),

  "tape.list": read(),
  "tape.export": read(),

  "register.list": read(),
  "register.verify": read(),
  "register.export": read(),

  "emails.list": read(),
  "emails.get": read(),
  "emails.attachmentUrl": read(),

  "simulator.personas": read(WORLD_DRIVERS),
  "simulator.threads": read(WORLD_DRIVERS),
  "simulator.sendText": write(WORLD_DRIVERS),
  "simulator.tapButton": write(WORLD_DRIVERS),
  "simulator.attachReceipt": write(WORLD_DRIVERS),
  "simulator.presignReceipt": write(WORLD_DRIVERS),
  "simulator.markRead": write(WORLD_DRIVERS),

  "clock.get": read(),
  "clock.advance": write(CASE_WORK),
  "clock.advanceTo": write(CASE_WORK),
  "clock.advanceToNext": write(CASE_WORK),
  "clock.advanceBusinessDay": write(CASE_WORK),
  "clock.setRunning": write(WORLD_DRIVERS),
  "clock.pause": write(WORLD_DRIVERS),
  "clock.fireNow": write(WORLD_DRIVERS),
  "clock.reset": write(WORLD_DRIVERS, RECENT),
  "clock.resetStatus": read(),

  "metrics.summary": read(),
  "metrics.export": read(),

  "policy.rules": read(),
  "policy.modes": read(),
  "policy.setAgentKill": write(["SUPERVISOR"], { ...RECENT, worldKinds: ["DEMO"] }),

  "tour.steps": read(),
  "tour.run": write(WORLD_DRIVERS),

  "account.changePassword": write(PERSONAL_ACCOUNTS, RECENT),
  "account.session": read(),

  // The world of a guest account: answered in any status of a self-signup world (auth/guest-identity.ts).
  "guest.status": read(["GUEST"]),
  "guest.requestWorld": write(["GUEST"]),
} as const satisfies Readonly<Record<string, AccessRule>>;

export type ProcedurePath = keyof typeof ACCESS;

/** The procedure builder of one row of the matrix; the router adds `.input(…)` and `.query`/`.mutation`. */
export function accessProcedure(path: ProcedurePath) {
  return guardedProcedure(ACCESS[path]);
}

/**
 * Cap tier of a console principal when deciding an approval (docs/tool-catalog.md, "T"): an
 * operator up to the operator's cap; a supervisor, and a guest inside their own world, above it.
 */
export function capTierOf(role: StaffRole): Exclude<CapTier, "AGENT"> | undefined {
  switch (role) {
    case "OPERATOR":
      return "OPERATOR";
    case "SUPERVISOR":
    case "GUEST":
      return "SUPERVISOR";
    case "COMPLIANCE":
      return undefined;
  }
}
