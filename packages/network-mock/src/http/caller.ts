// Who may call the network mock, for which world and which operation (docs/architecture.md §14,
// "Autorización por mundo en los mocks"). The role comes ONLY from the Function URL's IAM
// authorizer (`requestContext.authorizer.iam.userArn`, `assumed-role/<role>/<session>`), compared
// with the role ARNs linked into the mock (`MockCallers`); never from a header or the body.
//
//   unknown role                      403 CALLER_NOT_ALLOWED
//   known role, world of another class 403 CALLER_WORLD_DENIED (logged as an audit line)
//   known role, operation not its own  403 CALLER_NOT_ALLOWED
//
// IAM already lets only these roles in, and only through the Function URL
// (`lambda:InvokedViaFunctionUrl = true`); this is the second fence, per world class.
import { guestOriginOf, worldKindOf } from "@reclamo/shared";
import { z } from "zod";

export const CALLER_ROLES = ["EventWorker", "SignupEventWorker", "QaEventWorker", "ToolInvestigation", "ToolActions", "ScheduleDispatch", "Bff", "QaDriver"] as const;
export const CallerRole = z.enum(CALLER_ROLES);
export type CallerRole = z.infer<typeof CallerRole>;

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]{1,64})$/;
const ASSUMED_ROLE_ARN = /^arn:aws:sts::(\d{12}):assumed-role\/([\w+=,.@-]{1,64})\/[\w+=,.@-]{1,64}$/;

/**
 * The linked `MockCallers` (shared by both mocks): the IAM role ARN of each function that may invoke
 * a mock, by logical name. Only the roles of `CALLER_ROLES` count here; any other one is nobody to
 * the networks.
 */
export const CallerRoleArns = z.object({ roles: z.record(z.string().min(1), z.string().regex(ROLE_ARN)) });
export type CallerRoleArns = z.infer<typeof CallerRoleArns>;

/** Operations of networks.openapi.yaml (`operationId`). */
export type NetworkOperation = "registerCollection" | "publishSettlement" | "listSettlements" | "getTransfer" | "requestTransferReversal" | "transitionTransfer" | "getNetworksHealth";

const READS: readonly NetworkOperation[] = ["getNetworksHealth", "listSettlements", "getTransfer"];
const REVERSAL: readonly NetworkOperation[] = [...READS, "requestTransferReversal"];

/** What each role does with the networks: reads, the reversal of an approved or in-cap action, the timers' changes. */
const OPERATIONS: Readonly<Record<CallerRole, readonly NetworkOperation[]>> = {
  EventWorker: REVERSAL,
  SignupEventWorker: REVERSAL,
  QaEventWorker: REVERSAL,
  ToolInvestigation: READS,
  ToolActions: REVERSAL,
  ScheduleDispatch: [...READS, "publishSettlement", "transitionTransfer"],
  // A console clock move fires the due timers in line, as ScheduleDispatch would (routers/clock.ts).
  Bff: [...READS, "publishSettlement", "transitionTransfer"],
  QaDriver: ["registerCollection", "publishSettlement", "listSettlements", "getTransfer", "requestTransferReversal", "transitionTransfer", "getNetworksHealth"],
};

/** World classes each role reaches; the inputs of the "any world" roles are already authenticated. */
function reaches(role: CallerRole, worldId: string): boolean {
  const kind = worldKindOf(worldId);
  if (kind === undefined) return false;
  switch (role) {
    case "QaDriver":
    case "QaEventWorker":
      return kind === "QA" || kind === "SIM";
    case "EventWorker":
      return kind === "DEMO" || guestOriginOf(worldId) === "INVITED";
    case "SignupEventWorker":
      return guestOriginOf(worldId) === "SIGNUP";
    case "Bff":
      // The worlds its console runs (the core mock's table): never gprobe, qamin or sim-*.
      return kind === "DEMO" || /^(g\d{2}|gtest)$/.test(worldId) || guestOriginOf(worldId) === "SIGNUP" || worldId.startsWith("qa-");
    case "ToolInvestigation":
    case "ToolActions":
    case "ScheduleDispatch":
      return true;
  }
}

/** The linked role a Function URL caller assumed, by account and role name; `undefined` for anyone else. */
export function callerRoleOf(userArn: string | undefined, linked: CallerRoleArns): CallerRole | undefined {
  const assumed = userArn === undefined ? null : ASSUMED_ROLE_ARN.exec(userArn) ?? ROLE_ARN.exec(userArn);
  if (assumed === null) return undefined;
  const [, account, roleName] = assumed;
  for (const role of CALLER_ROLES) {
    const arn = linked.roles[role];
    const match = arn === undefined ? null : ROLE_ARN.exec(arn);
    if (match !== null && match[1] === account && match[2] === roleName) return role;
  }
  return undefined;
}

export type CallerDecision =
  | { readonly allowed: true; readonly role: CallerRole }
  | { readonly allowed: false; readonly code: "CALLER_NOT_ALLOWED" | "CALLER_WORLD_DENIED"; readonly role?: CallerRole };

/** The decision for one request; `worldId` is absent only on `/v1/health`. */
export function authorizeCaller(input: { userArn: string | undefined; linked: CallerRoleArns; operation: NetworkOperation; worldId?: string }): CallerDecision {
  const role = callerRoleOf(input.userArn, input.linked);
  if (role === undefined) return { allowed: false, code: "CALLER_NOT_ALLOWED" };
  if (!OPERATIONS[role].includes(input.operation)) return { allowed: false, code: "CALLER_NOT_ALLOWED", role };
  if (input.worldId !== undefined && !reaches(role, input.worldId)) return { allowed: false, code: "CALLER_WORLD_DENIED", role };
  return { allowed: true, role };
}
