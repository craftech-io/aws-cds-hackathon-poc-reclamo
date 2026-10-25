// Session of the console: the principal decoded from the stored id token, the tRPC client that
// carries it, and the recent-login step-up. The tokens themselves are never React state: every BFF
// call and every tick of the watcher reads them from sessionStorage (lib/session.ts), so a token
// replaced without a reload is used from the next call. React Context + useState only (CLAUDE.md).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type CognitoApi, createCognitoApi } from "../lib/auth/cognito";
import { type SrpClient, createSrpClient } from "../lib/auth/srp";
import { type TokenSet, clearTokens, refreshTokens, revokeSession, saveTokens } from "../lib/auth/tokens";
import { principalFromIdToken, type Principal } from "../lib/auth-claims";
import { readAuthEnv, type AuthEnv } from "../lib/env";
import { useRouter } from "../lib/router";
import { currentIdToken, getSession, sessionTick } from "../lib/session";
import { createConsoleClient, type ConsoleClient } from "../lib/trpc";
import { LANDING_PATH } from "../routes";

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "unconfigured"; readonly missing: readonly string[] }
  | { readonly status: "anonymous"; readonly reason?: "expired" }
  | { readonly status: "authenticated"; readonly principal: Principal };

/** `stepUp`: sign in again (BFF `LOGIN_NOT_RECENT`) before approving money or answering in writing. */
export type SecurityPrompt = "stepUp";

export interface AuthServices {
  readonly cognito: CognitoApi;
  readonly srp: SrpClient;
}

export interface SessionValue {
  readonly state: SessionState;
  readonly env: AuthEnv | undefined;
  /** Cognito client and SRP of this build; undefined when the build has no Cognito variables. */
  readonly auth: AuthServices | undefined;
  readonly trpc: ConsoleClient;
  readonly prompt: SecurityPrompt | undefined;
  /** The BFF answered `WORLD_RESETTING`: the shell shows the fixed reset screen until `READY`. */
  readonly worldResetting: boolean;
  /** `clock.resetStatus` said `READY`: back to the views, which load again. */
  worldReady(): void;
  /** The stored tokens, read now (never cached in state). */
  getSession(): TokenSet | undefined;
  /** Stores the tokens of a finished sign-in (or step-up) and opens the session. */
  completeSignIn(tokens: TokenSet): void;
  /** Revokes the refresh token (RevokeToken), clears the session and goes to the landing (docs/landing-spec.md §9.7). */
  signOut(): void;
  /** The BFF refused the token: drop it and send the user through the login with a way back. */
  expireSession(): void;
  openPrompt(prompt: SecurityPrompt): void;
  closePrompt(): void;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

/** How often the watcher re-reads the stored tokens. */
const WATCH_INTERVAL_MS = 1_000;

function authenticated(tokens: TokenSet): SessionState {
  return { status: "authenticated", principal: principalFromIdToken(tokens.idToken) };
}

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const { navigate } = useRouter();
  const [envResult] = useState(readAuthEnv);
  const env = envResult.ok ? envResult.env : undefined;
  const auth = useMemo<AuthServices | undefined>(
    () => (env ? { cognito: createCognitoApi({ region: env.region, clientId: env.clientId }), srp: createSrpClient(env.userPoolId) } : undefined),
    [env],
  );
  const [state, setState] = useState<SessionState>(() => (envResult.ok ? { status: "loading" } : { status: "unconfigured", missing: envResult.missing }));
  const [prompt, setPrompt] = useState<SecurityPrompt | undefined>(undefined);
  const [worldResetting, setWorldResetting] = useState(false);
  const trpc = useMemo(() => createConsoleClient(currentIdToken, { onWorldResetting: () => setWorldResetting(true) }), []);
  const worldReady = useCallback(() => setWorldResetting(false), []);

  // The id token the principal was decoded from; the watcher compares it with what is stored now.
  const knownIdToken = useRef<string | undefined>(undefined);
  const refreshing = useRef(false);

  const follow = useCallback((tokens: TokenSet) => {
    knownIdToken.current = tokens.idToken;
    setState(authenticated(tokens));
  }, []);

  const expire = useCallback(() => {
    clearTokens();
    knownIdToken.current = undefined;
    setPrompt(undefined);
    setState({ status: "anonymous", reason: "expired" });
  }, []);

  useEffect(() => {
    if (!auth) return;
    const watch = (): void => {
      const tick = sessionTick(knownIdToken.current, getSession(), Date.now());
      if (tick.kind === "replaced") follow(tick.tokens);
      else if (tick.kind === "expired") expire();
      else if (tick.kind === "none") setState((current) => (current.status === "loading" ? { status: "anonymous" } : current));
      else if (tick.kind === "refresh" && !refreshing.current) {
        refreshing.current = true;
        void refreshTokens(auth.cognito, tick.tokens)
          .then(follow, expire)
          .finally(() => {
            refreshing.current = false;
          });
      }
    };
    watch();
    const timer = window.setInterval(watch, WATCH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [auth, follow, expire]);

  const completeSignIn = useCallback(
    (tokens: TokenSet) => {
      saveTokens(tokens);
      follow(tokens);
    },
    [follow],
  );

  const signOut = useCallback(() => {
    const tokens = getSession();
    knownIdToken.current = undefined;
    setPrompt(undefined);
    setState({ status: "anonymous" });
    if (auth) void revokeSession(auth.cognito, tokens);
    else clearTokens();
    navigate(LANDING_PATH, { replace: true });
  }, [auth, navigate]);

  const closePrompt = useCallback(() => setPrompt(undefined), []);

  const value = useMemo<SessionValue>(
    () => ({ state, env, auth, trpc, prompt, worldResetting, worldReady, getSession, completeSignIn, signOut, expireSession: expire, openPrompt: setPrompt, closePrompt }),
    [state, env, auth, trpc, prompt, worldResetting, worldReady, completeSignIn, signOut, expire, closePrompt],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** Principal of an authenticated session; throws if used outside the guarded area of app.tsx. */
export function usePrincipal(): Principal {
  const { state } = useSession();
  if (state.status !== "authenticated") throw new Error("usePrincipal requires an authenticated session");
  return state.principal;
}
