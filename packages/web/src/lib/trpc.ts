// tRPC client of the console: same origin, `/api` behind the Router, id token in the
// Authorization header, read from sessionStorage on every call (lib/session.ts). The BFF resolves
// the principal from that token (WP-12). Every answer passes one link that spots `WORLD_RESETTING`,
// so whichever view asked, the shell switches to the fixed reset screen (docs/architecture.md §10).
import { createTRPCClient, httpBatchLink, type TRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { apiErrorOf } from "./api-error";
import { API_URL } from "./env";
import { fetchWithRetry } from "./http";
import type { AppRouter } from "./trpc-router";
import { RESET_STATUS_PATH, isWorldResetting } from "./world-clock";

export type ConsoleClient = TRPCClient<AppRouter>;

export interface ConsoleClientOptions {
  /** Called when the BFF answers `WORLD_RESETTING` to anything but `clock.resetStatus`. */
  readonly onWorldResetting?: () => void;
}

const REQUEST_TIMEOUT_MS = 20_000;

function worldResetLink(onWorldResetting: () => void): TRPCLink<AppRouter> {
  return () =>
    ({ next, op }) =>
      observable((observer) =>
        next(op).subscribe({
          next: (value) => observer.next(value),
          error: (error) => {
            if (op.path !== RESET_STATUS_PATH && isWorldResetting(apiErrorOf(error))) onWorldResetting();
            observer.error(error);
          },
          complete: () => observer.complete(),
        }),
      );
}

export function createConsoleClient(getIdToken: () => string | undefined, options: ConsoleClientOptions = {}): ConsoleClient {
  return createTRPCClient<AppRouter>({
    links: [
      ...(options.onWorldResetting ? [worldResetLink(options.onWorldResetting)] : []),
      httpBatchLink({
        url: API_URL,
        fetch: (input, init) => fetchWithRetry(input, init, { timeoutMs: REQUEST_TIMEOUT_MS }),
        headers: () => {
          const token = getIdToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
      }),
    ],
  });
}
