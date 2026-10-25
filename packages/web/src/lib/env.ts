// Build-time configuration of the console, validated at the edge. Vite inlines `import.meta.env`
// at build time, so a missing variable surfaces here (as an "unconfigured" state on the login
// screen) instead of as a sign-in that can never work.
import { z } from "zod";
import { regionOfPool } from "./auth/cognito";

/** Where the tRPC BFF lives behind the Router (infra/web-spec.ts `API_PATH`). */
export const API_URL = "/api";

const AuthEnvSchema = z.object({
  userPoolId: z.string().min(1),
  clientId: z.string().min(1),
  /** Region of the Cognito API: the prefix of the pool id (`us-east-1_…`). */
  region: z.string().min(1),
});

export type AuthEnv = z.infer<typeof AuthEnvSchema>;

export type AuthEnvResult = { readonly ok: true; readonly env: AuthEnv } | { readonly ok: false; readonly missing: readonly string[] };

const ENV_NAMES: Readonly<Record<keyof AuthEnv, string>> = {
  userPoolId: "VITE_COGNITO_USER_POOL_ID",
  clientId: "VITE_COGNITO_CLIENT_ID",
  region: "VITE_COGNITO_USER_POOL_ID",
};

export function readAuthEnv(): AuthEnvResult {
  const env = import.meta.env;
  const userPoolId = env.VITE_COGNITO_USER_POOL_ID?.trim();
  const parsed = AuthEnvSchema.safeParse({
    userPoolId,
    clientId: env.VITE_COGNITO_CLIENT_ID?.trim(),
    region: userPoolId ? regionOfPool(userPoolId) : undefined,
  });
  if (parsed.success) return { ok: true, env: parsed.data };
  const missing = parsed.error.issues.map((issue) => {
    const key = issue.path[0];
    return typeof key === "string" && key in ENV_NAMES ? ENV_NAMES[key as keyof AuthEnv] : String(key);
  });
  return { ok: false, missing: [...new Set(missing)] };
}
