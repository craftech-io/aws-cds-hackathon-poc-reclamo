// Who may ask the core about which world (docs/architecture.md §14). The invoking role comes only
// from `requestContext.authorizer.iam.userArn` of the Function URL event (`assumed-role/<role>/…`),
// compared with the role ARNs linked to the mock; never from a header or the body. A role outside
// the table is `CALLER_NOT_ALLOWED`; a world outside the role's classes is `CALLER_WORLD_DENIED`.
//
//   QaDriver, QaEventWorker            qa-*, qamin, sim-*
//   EventWorker                        demo, gNN, gtest, gprobe
//   SignupEventWorker                  gs-*
//   Bff                                demo, gNN, gtest, gs-*, qa-* (browser scenarios run the real Bff)
//   InboundWhatsApp, the 7 targets     any world: their input is already authenticated (signature
//   (ToolHandoff for its gate)         per world class, `sessionToken`)
//   PolicyAudit                        any world but sim-*: it re-reads the dated consent and the loans
//
// Some operations are narrower than the world: `getLiveRecipient` (the live WhatsApp number) answers
// only the functions that run the outbound gate and call the core (OPERATION_CALLERS).
import { guestOriginOf, worldKindOf } from "@reclamo/shared";
import { z } from "zod";

export const CoreCaller = z.enum([
  "InboundWhatsApp",
  "EventWorker",
  "SignupEventWorker",
  "QaEventWorker",
  "ToolIdentity",
  "ToolAccount",
  "ToolInvestigation",
  "ToolActions",
  "ToolComplaints",
  "ToolMessaging",
  "ToolHandoff",
  "Bff",
  "QaDriver",
  "PolicyAudit",
]);
export type CoreCaller = z.infer<typeof CoreCaller>;

const INVITED_GUEST = /^(g\d{2}|gtest|gprobe)$/;

const isQaOrSim = (worldId: string): boolean => worldId === "qamin" || worldId.startsWith("qa-") || worldKindOf(worldId) === "SIM";
const isInvitedOrDemo = (worldId: string): boolean => worldId === "demo" || INVITED_GUEST.test(worldId);
const isSignupGuest = (worldId: string): boolean => guestOriginOf(worldId) === "SIGNUP";
const anyWorld = (): boolean => true;

/** The classes of world each caller may reach. */
export const CALLER_WORLDS: Readonly<Record<CoreCaller, (worldId: string) => boolean>> = {
  QaDriver: isQaOrSim,
  QaEventWorker: isQaOrSim,
  EventWorker: isInvitedOrDemo,
  SignupEventWorker: isSignupGuest,
  Bff: (worldId) => worldId === "demo" || /^(g\d{2}|gtest)$/.test(worldId) || isSignupGuest(worldId) || worldId.startsWith("qa-"),
  InboundWhatsApp: anyWorld,
  ToolIdentity: anyWorld,
  ToolAccount: anyWorld,
  ToolInvestigation: anyWorld,
  ToolActions: anyWorld,
  ToolComplaints: anyWorld,
  ToolMessaging: anyWorld,
  ToolHandoff: anyWorld,
  PolicyAudit: (worldId) => worldKindOf(worldId) !== "SIM",
};

/** Shape of the `MockCallers` link: the role ARN of every function that may invoke a mock, by logical name. */
export const MockCallersLink = z.object({ roles: z.record(z.string().min(1), z.string().regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/)) });
export type MockCallersLink = z.infer<typeof MockCallersLink>;

interface RoleIdentity {
  readonly account: string;
  readonly roleName: string;
}

/** `arn:aws:iam::<acct>:role/<path>/<name>` → account and name. */
export function roleIdentity(roleArn: string): RoleIdentity | undefined {
  const match = /^arn:aws:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]+)$/.exec(roleArn);
  return match ? { account: match[1] ?? "", roleName: match[2] ?? "" } : undefined;
}

/** `arn:aws:sts::<acct>:assumed-role/<name>/<session>` → account and name. */
export function sessionIdentity(userArn: string): RoleIdentity | undefined {
  const match = /^arn:aws:sts::(\d{12}):assumed-role\/([\w+=,.@-]+)\/[\w+=,.@-]+$/.exec(userArn);
  return match ? { account: match[1] ?? "", roleName: match[2] ?? "" } : undefined;
}

export interface CallerDirectory {
  /** The caller a session ARN belongs to, or `undefined` for anyone outside the table. */
  resolve(userArn: string | undefined): CoreCaller | undefined;
}

/** A directory over the linked role ARNs; names the core does not know are ignored. */
export function callerDirectory(link: MockCallersLink): CallerDirectory {
  const byRole = new Map<string, CoreCaller>();
  for (const [name, arn] of Object.entries(link.roles)) {
    const caller = CoreCaller.safeParse(name);
    const identity = roleIdentity(arn);
    if (caller.success && identity !== undefined) byRole.set(`${identity.account}:${identity.roleName}`, caller.data);
  }
  return {
    resolve(userArn) {
      if (userArn === undefined) return undefined;
      const identity = sessionIdentity(userArn);
      return identity === undefined ? undefined : byRole.get(`${identity.account}:${identity.roleName}`);
    },
  };
}

/** Operations only some callers may ask for, whatever the world: anyone else is `CALLER_NOT_ALLOWED`. */
export const OPERATION_CALLERS: Readonly<Record<string, ReadonlySet<CoreCaller>>> = {
  getLiveRecipient: new Set<CoreCaller>(["InboundWhatsApp", "EventWorker", "QaEventWorker", "ToolComplaints", "ToolMessaging", "ToolHandoff"]),
};

/** Callers that only read, with the only operations they may ask for. */
export const CALLER_OPERATIONS: Readonly<Partial<Record<CoreCaller, ReadonlySet<string>>>> = {
  PolicyAudit: new Set(["getCustomer", "getCoreHealth"]),
};

/** Whether `caller` may ask for `operation` at all. */
export function authorizeOperation(caller: CoreCaller, operation: string): boolean {
  const only = CALLER_OPERATIONS[caller];
  if (only !== undefined && !only.has(operation)) return false;
  const allowed = OPERATION_CALLERS[operation];
  return allowed === undefined || allowed.has(caller);
}

export type WorldDecision = { readonly allowed: true } | { readonly allowed: false; readonly code: "CALLER_WORLD_DENIED" };

/** Whether `caller` may touch `worldId`; an id of no known class is denied to everyone. */
export function authorizeWorld(caller: CoreCaller, worldId: string): WorldDecision {
  if (worldKindOf(worldId) === undefined || !CALLER_WORLDS[caller](worldId)) return { allowed: false, code: "CALLER_WORLD_DENIED" };
  return { allowed: true };
}
