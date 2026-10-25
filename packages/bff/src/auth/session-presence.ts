// "Another session" warning of shared guest accounts (docs/architecture.md §11): the world's clock
// keeps `lastSession = {sessionId, lastActiveAtReal}`, where `sessionId` is the principal's (the
// token's `origin_jti`, kept across refreshes; the `sub` for `qa-*` users, so a token re-issued by
// `auth.session` is the same session). A different session active within 2 real hours only warns:
// it never blocks and never offers a reset. `account.session` (routers/account.ts) stores `next`.
import { z } from "zod";
import { IsoInstant } from "@reclamo/shared";
import type { Principal } from "./principal";

export const LastSession = z.object({ sessionId: z.string().min(1), lastActiveAtReal: IsoInstant });
export type LastSession = z.infer<typeof LastSession>;

/** Real time during which another session's activity still warns. */
export const OTHER_SESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface SessionPresence {
  /** Another session of this account was active less than 2 real hours ago. */
  readonly otherSessionActive: boolean;
  /** What to store as `lastSession` after this request. */
  readonly next: LastSession;
}

export function sessionPresence(last: LastSession | undefined, principal: Pick<Principal, "sessionId">, realNow: Date): SessionPresence {
  const next = { sessionId: principal.sessionId, lastActiveAtReal: realNow.toISOString() };
  if (!last || last.sessionId === principal.sessionId) return { otherSessionActive: false, next };
  const idleMs = realNow.getTime() - Date.parse(last.lastActiveAtReal);
  return { otherSessionActive: idleMs >= 0 && idleMs < OTHER_SESSION_WINDOW_MS, next };
}
