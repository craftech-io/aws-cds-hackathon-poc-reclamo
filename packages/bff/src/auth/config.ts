// What the BFF needs to know about the Cognito pool, read from the `Auth` link of infra/auth.ts
// (`Resource.Auth`, never `process.env`). Token verification needs no IAM permission: the JWKS is
// public. Two app clients (docs/architecture.md §11): `ConsoleClient` (SRP from the browser) and
// `ServerClient` (ADMIN_USER_PASSWORD_AUTH only, for `auth.session` of the QaDriver).
import { z } from "zod";
import { readLinked } from "../lib/resource";

const AuthResource = z.object({
  userPoolId: z.string().min(1),
  consoleClientId: z.string().min(1),
  serverClientId: z.string().min(1),
  region: z.string().min(1),
});
export type AuthConfig = z.infer<typeof AuthResource>;

export function authConfig(): AuthConfig {
  return readLinked("Auth", AuthResource);
}
