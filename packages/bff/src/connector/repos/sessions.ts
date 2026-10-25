// Turn sessions (docs/architecture.md §9.1): `SESSION#<sessionId>` is what a `sessionToken` resolves
// to (customer, complaints, identification, trigger), `TURN#<turnId>` says whether the turn is still
// open (a tool refuses a token of a closed turn) and holds the redacted results of its tools
// (`RESULT#<tool>#<seq>`), the grounding source of G2 and of the outbound verifier.
import { ConnectorError } from "@reclamo/shared";
import type { JsonObject } from "../../domain/common";
import { Session, Turn, TurnResult } from "../../domain/runtime-claims";
import { type NewOf, type RepoContext, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { isConflict } from "../errors";
import { keys, segment } from "../keys";
import { type StoredItem, cond } from "../store";

const TABLE = "Runtime" as const;

export function sessionsRepo(ctx: RepoContext) {
  const sessionKey = (worldId: string, sessionId: string) => keys.runtime(worldId, "SESSION", segment(sessionId, "session id"));
  const turnKey = (worldId: string, turnId: string) => keys.runtime(worldId, "TURN", segment(turnId, "turn id"));

  return {
    async putSession(session: NewOf<typeof Session>): Promise<void> {
      const value = validInput(Session, session, TABLE);
      const item = encode(value, { entity: "Session", key: sessionKey(value.worldId, value.sessionId), worldId: value.worldId, retention: "session", now: ctx.now() });
      await ctx.store.write({ kind: "put", table: TABLE, item, condition: cond.absent() });
    },
    async getSession(worldId: string, sessionId: string): Promise<Session | undefined> {
      return decodeOptional(Session, await ctx.store.get(TABLE, sessionKey(worldId, sessionId), { consistent: true }), TABLE);
    },
    /** A complaint registered during the turn joins its session (`register_complaint`). */
    async addComplaintToSession(worldId: string, sessionId: string, complaintId: string): Promise<void> {
      await ctx.store.write({
        kind: "update",
        table: TABLE,
        key: sessionKey(worldId, sessionId),
        condition: cond.and(cond.present(), cond.not(cond.contains("complaintIds", complaintId))),
        update: { append: { complaintIds: [complaintId] }, set: { updatedAt: ctx.now().toISOString() } },
      }).catch((error: unknown) => {
        if (!isConflict(error)) throw error;
      });
    },

    async openTurn(turn: Omit<NewOf<typeof Turn>, "status" | "resultSeq" | "closedAtReal">): Promise<void> {
      const value = validInput(Turn, { ...turn, status: "OPEN", resultSeq: 0 }, TABLE);
      const item = encode(value, { entity: "Turn", key: turnKey(value.worldId, value.turnId), worldId: value.worldId, retention: "session", now: ctx.now() });
      await ctx.store.write({ kind: "put", table: TABLE, item, condition: cond.absent() });
    },
    async getTurn(worldId: string, turnId: string): Promise<Turn | undefined> {
      return decodeOptional(Turn, await ctx.store.get(TABLE, turnKey(worldId, turnId), { consistent: true }), TABLE);
    },
    /** Closes the turn once; its tokens are refused afterwards. */
    async closeTurn(worldId: string, turnId: string): Promise<void> {
      await ctx.store.write({
        kind: "update",
        table: TABLE,
        key: turnKey(worldId, turnId),
        condition: cond.eq("status", "OPEN"),
        update: { set: { status: "CLOSED", closedAtReal: ctx.now().toISOString(), updatedAt: ctx.now().toISOString() } },
      });
    },

    /** Stores a tool result under the next sequence number of an open turn. */
    async putTurnResult(worldId: string, turnId: string, tool: string, result: JsonObject): Promise<TurnResult> {
      let after: StoredItem | undefined;
      try {
        after = await ctx.store.write({ kind: "update", table: TABLE, key: turnKey(worldId, turnId), condition: cond.eq("status", "OPEN"), update: { add: { resultSeq: 1 } } });
      } catch (error) {
        if (isConflict(error)) throw new ConnectorError("CONFLICT", "the turn is closed", TABLE, { cause: error });
        throw error;
      }
      const seq = decode(Turn, after as StoredItem, TABLE).resultSeq;
      const value = validInput(TurnResult, { worldId, turnId, tool, seq, atReal: ctx.now().toISOString(), result }, TABLE);
      const item = encode(value, { entity: "TurnResult", key: keys.turnResult(worldId, turnId, tool, seq), worldId, retention: "session", now: ctx.now() });
      await ctx.store.write({ kind: "put", table: TABLE, item, condition: cond.absent() });
      return value;
    },
    /** Every result of a turn, in the order the tools wrote them. */
    async listTurnResults(worldId: string, turnId: string): Promise<TurnResult[]> {
      const items = await queryAll(ctx.store, { table: TABLE, partition: turnKey(worldId, turnId).pk, sort: { op: "beginsWith", value: "RESULT#" }, consistent: true });
      return items.map((item) => decode(TurnResult, item, TABLE)).sort((a, b) => a.seq - b.seq);
    },
  };
}

export type SessionsRepo = ReturnType<typeof sessionsRepo>;
