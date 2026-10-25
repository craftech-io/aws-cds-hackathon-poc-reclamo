// Read-only probes of what a customer's turns decided (docs/tool-catalog.md, docs/test-plan.md §6):
//
//   turn.inspect    per turn of the customer (the turns its outbound messages name): the clause ids every
//                   tool result carried (`clauseId` / `clauseIds`, at any depth of `TURN#…/RESULT#`) and,
//                   per REPLY or FORMAL_ANSWER, whether it left and G2's verdict: the scores a sent message
//                   kept (outbound/persist.ts) or the `OUTBOUND_G2_REFUSED` audit of a refused one (EV-1)
//   intake.inspect  the customer's `INTAKE_CLASSIFIED` decisions, oldest first: kind, type, source, confidence
//                   and why the model gave nothing (EV-3)
// Neither returns a message body, a tool result's values or anything but ids, names and scores.
import { ToolError } from "@reclamo/shared";
import type { Message } from "../domain/conversation";
import type { AuditEntry } from "../domain/ledger";
import { GATE_AUDIT } from "../outbound/types";
import type { QaInput } from "./inputs";
import type { ActionContext } from "./ports";

const ANSWER_KINDS: ReadonlySet<string> = new Set(["REPLY", "FORMAL_ANSWER"]);
const LEFT: ReadonlySet<string> = new Set(["SENT", "DELIVERED", "READ"]);
/** Audit entries read per action: a QA world's conversations stay far below. */
const AUDIT_PAGE = 500;

function worldOf(ctx: ActionContext): string {
  if (ctx.worldId === undefined) throw new ToolError("INVALID", "this action needs its world");
  return ctx.worldId;
}

/** Every clause id a tool result carries, at any depth (`{clauseId}`, `{clauseIds: […]}`). */
export function clauseIdsOf(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const member of value) clauseIdsOf(member, found);
  } else if (value !== null && typeof value === "object") {
    for (const [name, member] of Object.entries(value)) {
      if (name === "clauseId" && typeof member === "string") {
        found.add(member);
      } else if (name === "clauseIds" && Array.isArray(member)) {
        for (const id of member) if (typeof id === "string") found.add(id);
      } else {
        clauseIdsOf(member, found);
      }
    }
  }
  return found;
}

function scoreOf(detail: unknown, name: "groundingScore" | "relevanceScore"): number | undefined {
  const value = (detail as Record<string, unknown> | undefined)?.[name];
  return typeof value === "number" ? value : undefined;
}

function verdictOf(message: Message, refusals: ReadonlyMap<string, AuditEntry>) {
  const refused = refusals.get(message.messageId);
  if (refused !== undefined) {
    const groundingScore = scoreOf(refused.detail, "groundingScore");
    const relevanceScore = scoreOf(refused.detail, "relevanceScore");
    return {
      action: "BLOCKED" as const,
      failure: refused.outcome ?? "BLOCKED",
      ...(groundingScore === undefined ? {} : { groundingScore }),
      ...(relevanceScore === undefined ? {} : { relevanceScore }),
    };
  }
  if (message.g2 === undefined) return null;
  return { action: "NONE" as const, ...message.g2 };
}

export async function turnInspect(input: QaInput<"turn.inspect">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const { data } = ctx.ports;
  const messages = (await data.conversations.listMessages(worldId, input.customerId)).filter((message) => message.direction === "OUT" && message.turnId !== undefined);
  const turnIds = [...new Set(messages.map((message) => message.turnId as string))];
  const refusals = new Map<string, AuditEntry>();
  if (messages.some((message) => message.status === "BLOCKED")) {
    for (const entry of await data.audit.listByAction(worldId, GATE_AUDIT.G2_REFUSED, AUDIT_PAGE)) {
      const messageId = entry.refs["messageId"];
      if (messageId !== undefined) refusals.set(messageId, entry);
    }
  }
  const turns = [];
  for (const turnId of turnIds) {
    const results = await data.sessions.listTurnResults(worldId, turnId);
    const tools = results.map((result) => ({ tool: result.tool, clauseIds: [...clauseIdsOf(result.result)].sort() }));
    const replies = messages
      .filter((message) => message.turnId === turnId && message.kind !== undefined && ANSWER_KINDS.has(message.kind))
      .map((message) => ({ kind: message.kind as string, sent: LEFT.has(message.status), g2: verdictOf(message, refusals) }));
    turns.push({ turnId, tools, replies });
  }
  return { turns };
}

export async function intakeInspect(input: QaInput<"intake.inspect">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const entries = await ctx.ports.data.audit.listByRef(worldId, `CUS#${input.customerId}`, AUDIT_PAGE);
  const classifications = entries
    .filter((entry) => entry.action === "INTAKE_CLASSIFIED")
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((entry) => {
      const detail = (entry.detail ?? {}) as Record<string, unknown>;
      const confidence = typeof detail["confidence"] === "number" ? detail["confidence"] : 0;
      const source = detail["source"] === "MODEL" || detail["source"] === "FALLBACK" ? detail["source"] : "RULE";
      return {
        kind: entry.outcome ?? "UNKNOWN",
        source,
        confidence,
        ...(typeof detail["type"] === "string" ? { type: detail["type"] } : {}),
        ...(typeof detail["fallback"] === "string" ? { fallback: detail["fallback"] } : {}),
        ...(typeof detail["modelMs"] === "number" ? { modelMs: detail["modelMs"] } : {}),
      };
    });
  return { classifications };
}
