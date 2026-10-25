// The console of an in-process world: the real `appRouter` behind the real context factory, with a
// session signed by the local issuer and verified by the BFF's real verifier, so `worldProcedure`
// (staff row and `META` re-read on every call), `roleProcedure`, `recentLoginProcedure`, the
// `COMPLIANCE` refusal of every mutation and the cross-world audit all run as in the `Bff` Lambda. The
// `QaDriver`'s server-built principal is not used here: it only acts in QA worlds.
import { connectorAuditSink, connectorWorldDirectory } from "@reclamo/bff/auth/directory";
import { leadHashes } from "@reclamo/bff/leads/keys";
import type { Connector } from "@reclamo/bff/connector/port";
import type { Logger } from "@reclamo/bff/lib/log";
import type { ContextDeps } from "@reclamo/bff/routers/deps";
import { createCaller } from "@reclamo/bff/routers/index";
import { createContextFactory } from "@reclamo/bff/routers/trpc";
import { LOCAL_KEYS } from "./keys";
import type { SeedStaff } from "./seed-world";
import type { SessionClaims, TokenIssuer } from "./issuer";

export type ConsoleCaller = ReturnType<typeof createCaller>;

export interface ConsoleSession {
  readonly worldId: string;
  readonly staff: SeedStaff;
  /** Seconds since the interactive sign-in (the recent-login gate reads it); 0 by default. */
  readonly signedInAgo?: number;
  readonly audience?: SessionClaims["audience"];
}

export interface LocalConsole {
  readonly deps: ContextDeps;
  /** The id token a session would carry. */
  token(session: ConsoleSession): string;
  /** The router as that session calls it over `/api`. */
  caller(session: ConsoleSession): Promise<ConsoleCaller>;
}

export interface LocalConsoleInput {
  readonly connector: Connector;
  readonly issuer: TokenIssuer;
  readonly now: () => Date;
  readonly loggerFor: (correlationId: string) => Logger;
  /** Binds the routers' services to the world (console-services.ts); the deps as they are otherwise. */
  readonly bind?: (deps: ContextDeps) => ContextDeps;
}

/** `ContextDeps` of the `Bff` over an in-process world: no staff cache, so a changed row counts at once. */
export function localContextDeps(input: LocalConsoleInput): ContextDeps {
  const hashes = leadHashes(LOCAL_KEYS.phoneHash);
  return {
    verifier: input.issuer.verifier(),
    directory: connectorWorldDirectory(input.connector.worlds),
    audit: connectorAuditSink(input.connector.audit, input.now),
    wallClock: input.now,
    loggerFor: input.loggerFor,
    guestWorldOf: (sub) => hashes.guestWorldId(sub),
  };
}

export function createLocalConsole(input: LocalConsoleInput): LocalConsole {
  const base = localContextDeps(input);
  const deps = input.bind === undefined ? base : input.bind(base);
  const contextOf = createContextFactory(() => deps);
  let requests = 0;
  const token = (session: ConsoleSession): string =>
    input.issuer.idToken({
      sub: session.staff.sub,
      username: session.staff.username,
      role: session.staff.role,
      worldId: session.worldId,
      staffId: session.staff.staffId,
      ...(session.audience === undefined ? {} : { audience: session.audience }),
      ...(session.signedInAgo === undefined ? {} : { signedInAgo: session.signedInAgo }),
    });
  return {
    deps,
    token,
    async caller(session) {
      requests += 1;
      const context = await contextOf({ event: { headers: { authorization: `Bearer ${token(session)}` }, requestContext: { requestId: `local-console-${requests}` } } });
      return createCaller(context);
    },
  };
}
