// What an implementation receives from `createToolHandler` (handler.ts): its parsed input, the session
// of the turn, the principal, what the fences resolved (the complaint, the conversation), the connector,
// the real clock, a logger bound to the call and an audit writer that fills in the world, the epoch, the
// actor and the references of the call. Every tool with an effect records its decision through `audit`
// (docs/tool-catalog.md "Bitácora"); the wrapper records its own refusals the same way.
import type { ToolFailure, ToolOk } from "@reclamo/shared";
import { maskAuditRefs } from "../../auth/audit";
import type { Connector } from "../../connector/port";
import type { Complaint } from "../../domain/complaint";
import type { Actor, JsonObject } from "../../domain/common";
import type { ConversationMeta } from "../../domain/conversation";
import { ulid } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import type { ToolDefinition, ToolInput } from "./define";
import type { ToolPrincipal, ToolSession } from "./principal";
import type { ScopeFindings } from "./scope";
import type { GatewayToolName, ToolTarget } from "./targets";

/** What a tool answers: never thrown, always this envelope (docs/tool-catalog.md "Errores"). */
export type ToolResponse = ToolOk<Record<string, unknown>> | ToolFailure;

export interface ToolAuditEntry {
  /** UPPER_SNAKE_CASE; `DENY` for a refusal, the tool's name (`APPLY_PAYMENT`) or the effect's otherwise. */
  readonly action?: string;
  readonly outcome?: string;
  readonly ruleIds?: readonly string[];
  /** Ids and codes only; every value goes through the masker before it is written. */
  readonly refs?: Readonly<Record<string, string>>;
  readonly detail?: JsonObject;
}

export interface ToolContext<I> {
  readonly target: ToolTarget;
  readonly tool: GatewayToolName;
  readonly input: I;
  readonly session: ToolSession;
  readonly principal: ToolPrincipal;
  /** The complaint `LAM-COMPLAINT-REQUIRED` resolved, for the tools marked **Rc**. */
  readonly complaint?: Complaint;
  /** The conversation the fences read (control, identification), when any fence read it. */
  readonly conversation?: ConversationMeta;
  readonly findings: ScopeFindings;
  readonly connector: Connector;
  /** Real time (audit stamps, identification); business rules use `session.eventAtSim`. */
  readonly wallClock: () => Date;
  readonly correlationId: string;
  readonly log: Logger;
  audit(entry: ToolAuditEntry): Promise<void>;
}

export type ToolImplementation<I> = (ctx: ToolContext<I>) => Promise<ToolResponse>;

/** One implementation per tool of a target, typed by its definition. */
export type Implementations<Tools extends Readonly<Record<string, ToolDefinition>>> = {
  readonly [K in keyof Tools]: ToolImplementation<ToolInput<Tools[K]>>;
};

/** `apply_payment` → `APPLY_PAYMENT`. */
export function toolAction(tool: string): string {
  return tool.toUpperCase();
}

/** The agent for a Gateway call; the deterministic code for an in-process caller. */
export function actorOf(principal: ToolPrincipal): Actor {
  return principal.kind === "HARNESS" ? "AGENT" : principal.caller.kind === "QA" ? "QA" : "SYSTEM";
}

export interface AuditTarget {
  readonly connector: Connector;
  readonly worldId: string;
  readonly actor: Actor;
  readonly wallClock: () => Date;
  readonly log: Logger;
  /** The simulated instant of the decision, when there is a session. */
  readonly atSim?: string;
  /** References every entry of the call carries (turn, session, caller). */
  readonly baseRefs?: Readonly<Record<string, string>>;
}

/**
 * Appends one `AuditLog` row in the world's current epoch (read from `META`; a world without `META`
 * records nothing and leaves a log line). A failure to audit is logged, never thrown at the caller.
 */
export async function writeAudit(target: AuditTarget, entry: ToolAuditEntry & { readonly action: string }): Promise<void> {
  try {
    const meta = await target.connector.worlds.getMeta(target.worldId);
    if (meta === undefined) {
      target.log.warn("tool.audit_skipped", { reason: "WORLD_UNKNOWN", action: entry.action });
      return;
    }
    const at = target.wallClock();
    const refs = maskAuditRefs({ ...(target.baseRefs ?? {}), ...(entry.refs ?? {}) }, target.log);
    const primary = refs["complaintId"] !== undefined ? `CMP#${refs["complaintId"]}` : refs["turnId"] !== undefined ? `TURN#${refs["turnId"]}` : undefined;
    await target.connector.audit.append({
      worldId: target.worldId,
      epoch: meta.epoch,
      auditId: ulid(at.getTime()),
      ts: at.toISOString(),
      ...(target.atSim === undefined ? {} : { atSim: target.atSim }),
      action: entry.action,
      actor: target.actor,
      ...(entry.ruleIds === undefined ? {} : { ruleIds: [...entry.ruleIds] }),
      refs,
      ...(primary === undefined ? {} : { primaryRef: primary }),
      ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    });
  } catch (error) {
    target.log.error("tool.audit_failed", { error });
  }
}

/** The references of a call: the turn and the session, plus the caller's event for an in-process call. */
export function callRefs(session: ToolSession, principal: ToolPrincipal, tool: string): Record<string, string> {
  return {
    tool,
    turnId: session.turnId,
    sessionId: session.sessionId,
    customerId: session.customerId,
    ...(principal.kind === "CALLER" ? { caller: principal.caller.kind, callerEventId: principal.caller.eventId } : {}),
  };
}
