// `createToolHandler`: the one wrapper every Gateway target runs its tools through (docs/tool-catalog.md
// "Convenciones", docs/design-brief.md §8.6). For every call, in order:
//
//   1. Lambda entry only: an event that names a `caller`, or brings no `sessionToken`, is `INVALID` and
//      audited `DENY DIRECT_INVOKE` (`LAM-CALLER`) before anything is read; the Gateway must name a tool
//      of this target;
//   2. the session is verified (signature, 15 minutes, turn still open) and everything else is read from
//      it; an in-process caller must be one the tool admits and must be in the session's world;
//   3. the input is parsed strict (`LAM-STRICT`): an undeclared key, a value out of the real enum, a field
//      a Cedar forbid reads (`decision`, `capOverride`) → `INVALID`;
//   4. the fences run (fences.ts): `LAM-SCOPE`, `LAM-CONTROL`, `LAM-COMPLAINT-REQUIRED`,
//      `LAM-IDENTIFIED`, `LAM-ONCE-PER-EVENT`;
//   5. the implementation runs; whatever it throws becomes the `{ok: false, error}` envelope;
//   6. the declared free-text paths of the output are escaped, and a successful output is written to
//      `Runtime/W#<w>#TURN#<turnId>/RESULT#<tool>#<seq>`, the grounding source of G2 and of the verifier.
//
// Every refusal with an authentic session is audited `DENY` with its rule. Nothing here throws.
import { type Caller, ToolError, type ToolFailure, ToolFailureSchema, carriesCaller, fail, toToolFailure } from "@reclamo/shared";
import type { Connector } from "../../connector/port";
import type { JsonObject } from "../../domain/common";
import type { SecretKey } from "../../lib/crypto";
import { type Logger, correlationIdFrom, redactText } from "../../lib/log";
import { type Implementations, type ToolAuditEntry, type ToolContext, type ToolResponse, actorOf, callRefs, toolAction, writeAudit } from "./context";
import type { ToolDefinition } from "./define";
import { type FenceCall, type FenceState, type Refusal, recordOncePerEvent, runFences } from "./fences";
import { type LambdaContextLike, PRINCIPAL_REASON, type ToolPrincipal, type ToolSession, gatewayMarksOf, parseCaller, resolveToolSession, signedWorldOf } from "./principal";
import { type CoreOwnership, connectorLookups } from "./scope";
import { GATEWAY_TOOLS, GATEWAY_TOOL_SEPARATOR, type GatewayToolName, LAM_RULE, type ToolTarget } from "./targets";
import { escapeUntrustedPaths } from "./untrusted";

export interface ToolDeps {
  readonly connector: Connector;
  /** `SessionKey` (its `session` subkey signs the tokens); read per call so a missing secret fails the call. */
  readonly sessionKey: () => SecretKey;
  /** Real time: token expiry, identification, audit stamps. */
  readonly wallClock: () => Date;
  readonly loggerFor: (correlationId: string) => Logger;
  /** What the simulated core says is the customer's (`LAM-SCOPE` of loans, charges, transfers, movements). */
  readonly ownership: CoreOwnership;
}

/** The definitions of a target: exactly its tools of `GATEWAY_TOOLS`, each under its own name. */
export type TargetTools<T extends ToolTarget> = { readonly [K in (typeof GATEWAY_TOOLS)[T][number]]: ToolDefinition<K> };

export interface TargetSpec<T extends ToolTarget, Tools extends TargetTools<T>> {
  readonly target: T;
  readonly tools: Tools;
  readonly implementations: Implementations<Tools>;
}

export interface GatewayTargetRuntime {
  readonly target: ToolTarget;
  /** The deployed Lambda entry: a Gateway call (the arguments as the event, the tool in the client context). */
  handle(event: unknown, context?: LambdaContextLike): Promise<ToolResponse>;
  /** The in-process signature (worker, console, QA): the turn's token in the input, the caller apart. */
  invoke(tool: string, input: unknown, caller: Caller): Promise<ToolResponse>;
}

/** Bounds of the field names a refusal for invalid input reports. */
const MAX_PATH = 64;
const MAX_PATHS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResponse(value: unknown): value is ToolResponse {
  if (!isRecord(value)) return false;
  return value["ok"] === true || (value["ok"] === false && ToolFailureSchema.safeParse(value).success);
}

/** Paths of the issues only: the values the model wrote never go back to it, to the log or to the audit. */
function issuePaths(issues: readonly { readonly code: string; readonly path: readonly PropertyKey[]; readonly keys?: readonly string[] }[]): string[] {
  const paths = issues.flatMap((issue) => (issue.code === "unrecognized_keys" && issue.keys ? issue.keys.map((key) => [...issue.path, key].join(".")) : [issue.path.map(String).join(".") || "(input)"]));
  return [...new Set(paths.map((path) => redactText(path.slice(0, MAX_PATH))))].slice(0, MAX_PATHS);
}

function assertTargetShape(target: ToolTarget, tools: Readonly<Record<string, ToolDefinition>>, implementations: Readonly<Record<string, unknown>>): void {
  const expected = [...GATEWAY_TOOLS[target]].sort().join(",");
  if (Object.keys(tools).sort().join(",") !== expected || Object.keys(implementations).sort().join(",") !== expected) {
    throw new Error(`target ${target} must declare and implement exactly ${expected}`);
  }
  for (const [name, definition] of Object.entries(tools)) if (definition.name !== name) throw new Error(`target ${target}: ${name} holds the definition of ${definition.name}`);
}

interface Resolved {
  readonly session: ToolSession;
  readonly principal: ToolPrincipal;
  readonly correlationId: string;
  readonly log: Logger;
}

export function createToolHandler<T extends ToolTarget, Tools extends TargetTools<T>>(spec: TargetSpec<T, Tools>, deps: ToolDeps): GatewayTargetRuntime {
  const tools: Readonly<Record<string, ToolDefinition>> = spec.tools;
  const implementations = spec.implementations as unknown as Readonly<Record<string, (ctx: ToolContext<unknown>) => Promise<ToolResponse>>>;
  assertTargetShape(spec.target, tools, implementations);
  const lookups = connectorLookups(deps.connector, deps.ownership);

  const logFor = (correlationId: string, tool: string, principal?: ToolPrincipal): Logger =>
    deps.loggerFor(correlationId).child({ service: "agent-tools", target: spec.target, tool, ...(principal === undefined ? {} : { principal: principal.kind }) });

  function auditFor(resolved: Resolved, tool: string) {
    return (entry: ToolAuditEntry & { readonly action: string }) =>
      writeAudit(
        { connector: deps.connector, worldId: resolved.session.worldId, actor: actorOf(resolved.principal), wallClock: deps.wallClock, log: resolved.log, atSim: resolved.session.eventAtSim, baseRefs: callRefs(resolved.session, resolved.principal, tool) },
        entry,
      );
  }

  async function refuse(resolved: Resolved, tool: string, refusal: Refusal, extraRefs: Readonly<Record<string, string>> = {}): Promise<ToolFailure> {
    await auditFor(resolved, tool)({ action: "DENY", outcome: refusal.failure.error.reason ?? refusal.failure.error.code, ruleIds: refusal.ruleIds, refs: { ...extraRefs, deniedTool: toolAction(tool) }, ...(refusal.detail === undefined ? {} : { detail: refusal.detail }) });
    resolved.log.warn("tool.denied", { rule: refusal.ruleIds[0], code: refusal.failure.error.code, reason: refusal.failure.error.reason });
    return refusal.failure;
  }

  /** Step 1: a direct invocation of the deployed entry; audited where an authentic token or the named world says. */
  async function refuseDirectInvoke(event: Readonly<Record<string, unknown>>, requestId: string | undefined, toolName: string | undefined): Promise<ToolResponse> {
    const correlationId = correlationIdFrom(requestId);
    const log = logFor(correlationId, toolName ?? "(unknown)");
    const failure = fail("INVALID", "this entry accepts only a Gateway call with the sessionToken of the turn", PRINCIPAL_REASON.DIRECT_INVOKE);
    let worldId: string | undefined;
    try {
      worldId = signedWorldOf(deps.sessionKey(), event["sessionToken"], deps.wallClock()) ?? parseCaller(event["caller"])?.worldId;
    } catch (error) {
      log.error("tool.session_key_unavailable", { error });
    }
    if (worldId !== undefined) {
      await writeAudit(
        { connector: deps.connector, worldId, actor: "SYSTEM", wallClock: deps.wallClock, log },
        { action: "DENY", outcome: PRINCIPAL_REASON.DIRECT_INVOKE, ruleIds: [LAM_RULE.CALLER], refs: { target: spec.target, ...(toolName === undefined ? {} : { tool: toolName }) } },
      );
    }
    log.warn("tool.direct_invoke_refused", { reason: PRINCIPAL_REASON.DIRECT_INVOKE, audited: worldId !== undefined });
    return failure;
  }

  async function resolve(tool: string, raw: Readonly<Record<string, unknown>>, principal: ToolPrincipal, requestId?: string): Promise<Resolved | ToolFailure> {
    const resolution = await resolveToolSession(deps.sessionKey(), raw["sessionToken"], deps.connector, deps.wallClock());
    if (!resolution.ok) {
      const failure = resolution.error.toFailure();
      const closed = resolution.closedSession;
      if (closed === undefined) {
        logFor(correlationIdFrom(requestId), tool, principal).warn("tool.session_refused", { code: failure.error.code, reason: failure.error.reason });
        return failure;
      }
      const correlationId = correlationIdFrom(closed.triggerEventId);
      return refuse({ session: closed, principal, correlationId, log: logFor(correlationId, tool, principal) }, tool, { failure, ruleIds: [], detail: { turnClosed: true } });
    }
    const { session } = resolution;
    const correlationId = correlationIdFrom(session.triggerEventId);
    const resolved: Resolved = { session, principal, correlationId, log: logFor(correlationId, tool, principal) };
    if (principal.kind === "HARNESS") return resolved;
    const { caller } = principal;
    if (caller.worldId !== session.worldId) {
      return refuse(resolved, tool, { failure: fail("FORBIDDEN", "the caller's world is not the session's", PRINCIPAL_REASON.CROSS_WORLD), ruleIds: [LAM_RULE.CALLER] });
    }
    if (!tools[tool]?.callers.includes(caller.kind)) {
      return refuse(resolved, tool, { failure: fail("FORBIDDEN", `a ${caller.kind} caller may not call ${tool}`, PRINCIPAL_REASON.CALLER_NOT_ALLOWED), ruleIds: [LAM_RULE.CALLER] });
    }
    return resolved;
  }

  async function run(definition: ToolDefinition, fenceCall: FenceCall, state: FenceState, resolved: Resolved): Promise<ToolResponse> {
    const tool = definition.name;
    const implementation = implementations[tool];
    const audit = auditFor(resolved, tool);
    const ctx: ToolContext<unknown> = {
      target: spec.target,
      tool,
      input: fenceCall.input,
      session: resolved.session,
      principal: resolved.principal,
      ...(state.complaint === undefined ? {} : { complaint: state.complaint }),
      ...(state.conversation === undefined ? {} : { conversation: state.conversation }),
      findings: state.findings,
      connector: deps.connector,
      wallClock: deps.wallClock,
      correlationId: resolved.correlationId,
      log: resolved.log,
      audit: (entry) => audit({ ...entry, action: entry.action ?? toolAction(tool), refs: { ...(state.complaint === undefined ? {} : { complaintId: state.complaint.complaintId }), ...(entry.refs ?? {}) } }),
    };
    let result: ToolResponse;
    try {
      const answer: unknown = implementation === undefined ? fail("UNAVAILABLE", "tool not available") : await implementation(ctx);
      result = isToolResponse(answer) ? answer : fail("UNAVAILABLE", "temporary failure, try again later");
    } catch (error) {
      result = toToolFailure(error);
      if (!(error instanceof ToolError)) resolved.log.error("tool.failed", { error });
    }
    if (!result.ok) return result;
    result = escapeUntrustedPaths(result, definition.untrustedOutput);
    try {
      await recordOncePerEvent(fenceCall);
    } catch (error) {
      resolved.log.error("tool.once_claim_failed", { error });
    }
    try {
      await deps.connector.sessions.putTurnResult(resolved.session.worldId, resolved.session.turnId, tool, { ...result } as JsonObject);
    } catch (error) {
      // Without its TURN# row the result cannot ground a message: a later send fails closed (GROUNDING_FAIL).
      resolved.log.error("tool.turn_result_failed", { error });
    }
    return result;
  }

  async function call(toolName: string, raw: unknown, principal: ToolPrincipal, requestId?: string): Promise<ToolResponse> {
    const started = deps.wallClock().getTime();
    const definition = tools[toolName];
    if (definition === undefined) return fail("INVALID", `unknown tool of the ${spec.target} target`);
    if (!isRecord(raw)) return fail("INVALID", "the input must be an object");
    if (carriesCaller(raw)) return fail("INVALID", "a caller never travels in the input", PRINCIPAL_REASON.CALLER_INVALID);
    const resolved = await resolve(definition.name, raw, principal, requestId);
    if ("ok" in resolved) return resolved;
    const tool: GatewayToolName = definition.name;
    const parsed = definition.gatewayInput.safeParse(raw);
    if (!parsed.success) {
      const denied = definition.deniedFields.filter((field) => raw[field] !== undefined);
      const fields = issuePaths(parsed.error.issues as never);
      const message = denied.length > 0 ? `${denied.join(", ")} is never accepted (denied by policy)` : `invalid input: ${fields.join(", ")}`;
      return refuse(resolved, tool, { failure: fail("INVALID", message, "VALIDATION"), ruleIds: [LAM_RULE.STRICT], detail: { fields, deniedFields: denied } });
    }
    const input = Object.fromEntries(Object.entries(parsed.data).filter(([key]) => key !== "sessionToken"));
    const fenceCall: FenceCall = { definition, input, session: resolved.session, connector: deps.connector, lookups, wallClock: deps.wallClock };
    const fenced = await runFences(fenceCall);
    if (!fenced.ok) return refuse(resolved, tool, fenced.refusal);
    const result = await run(definition, fenceCall, fenced.state, resolved);
    resolved.log.info("tool.call", { ok: result.ok, code: result.ok ? undefined : result.error.code, durationMs: deps.wallClock().getTime() - started });
    return result;
  }

  async function safely(work: () => Promise<ToolResponse>): Promise<ToolResponse> {
    try {
      return await work();
    } catch (error) {
      return toToolFailure(error);
    }
  }

  return {
    target: spec.target,
    handle: (event, context) =>
      safely(async () => {
        if (!isRecord(event)) return fail("INVALID", "the input must be an object");
        const marks = gatewayMarksOf(context);
        const requestId = marks.requestId ?? context?.awsRequestId;
        if (carriesCaller(event) || typeof event["sessionToken"] !== "string" || !marks.present) return refuseDirectInvoke(event, requestId, marks.toolName);
        const name = marks.toolName ?? "";
        const separator = name.indexOf(GATEWAY_TOOL_SEPARATOR);
        if (separator < 0 || name.slice(0, separator) !== spec.target) return fail("FORBIDDEN", `the Gateway named a tool outside the ${spec.target} target`);
        return call(name.slice(separator + GATEWAY_TOOL_SEPARATOR.length), event, { kind: "HARNESS" }, requestId);
      }),
    invoke: (tool, input, caller) =>
      safely(async () => {
        const parsed = parseCaller(caller);
        if (parsed === undefined) return fail("INVALID", "invalid caller", PRINCIPAL_REASON.CALLER_INVALID);
        return call(tool, input, { kind: "CALLER", caller: parsed }, parsed.eventId);
      }),
  };
}
