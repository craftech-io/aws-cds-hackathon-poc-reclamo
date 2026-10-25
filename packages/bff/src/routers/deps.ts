// What a console request needs besides its input. Procedures reach the domain through `ctx.deps`
// so tests swap every adapter; the defaults are built once per Lambda container and read the
// linked resources lazily, on the first request that needs them. `defaultDeps` takes no argument
// and nothing in a request reaches it: the verifier always fetches the pool's own JWKS
// (auth/no-jwks-override.test.ts).
import type { AuditSink } from "../auth/audit";
import { authConfig } from "../auth/config";
import { connectorAuditSink, connectorWorldDirectory } from "../auth/directory";
import { type IdTokenVerifier, createCognitoIdTokenVerifier } from "../auth/jwt";
import type { GuestWorldOf } from "../auth/principal";
import { type WorldDirectory, withStaffCache } from "../auth/staff";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { GuestWorldService } from "../guests/world-status";
import { type LeadHashes, leadHashes } from "../leads/keys";
import { stageGuestWorld } from "../guests/runtime";
import { type Logger, createLogger } from "../lib/log";
import { keySecret } from "../lib/secrets";

export interface ContextDeps {
  readonly verifier: IdTokenVerifier;
  /** Staff rows and `META` of `Worlds` (re-read on every request; staff rows cached for a minute). */
  readonly directory: WorldDirectory;
  /** `AuditLog` of the denials (cross-world, role, audience, inactive staff). */
  readonly audit: AuditSink;
  /** Real time: `auth_time` comes from Cognito's clock, never from a world clock. */
  readonly wallClock: () => Date;
  /** One logger per request, bound to its correlation id. */
  readonly loggerFor: (correlationId: string) => Logger;
  /** The world a self-signup account derives from its `sub`; absent, such accounts are refused. */
  readonly guestWorldOf?: GuestWorldOf;
  /** `guest.status` and `guest.requestWorld` (guests/world-status.ts), per request logger. */
  readonly guestWorld?: (log: Logger) => GuestWorldService;
}

let cached: ContextDeps | undefined;

// The verifier reads `Resource.Auth` on first use, so a request that needs no principal (the
// health probe) never touches the link.
function lazyVerifier(): IdTokenVerifier {
  let verifier: IdTokenVerifier | undefined;
  return {
    verify: (token) => {
      verifier ??= createCognitoIdTokenVerifier(authConfig());
      return verifier.verify(token);
    },
  };
}

// `PhoneHashKey` is read on the first self-signup token, never for staff requests.
function lazyGuestWorldOf(): GuestWorldOf {
  let hashes: LeadHashes | undefined;
  return (sub) => {
    hashes ??= leadHashes(keySecret("PhoneHashKey"));
    return hashes.guestWorldId(sub);
  };
}

export function defaultDeps(): ContextDeps {
  if (cached) return cached;
  const connector = dynamoConnector();
  const wallClock = () => new Date();
  cached = {
    verifier: lazyVerifier(),
    directory: withStaffCache(connectorWorldDirectory(connector.worlds), wallClock),
    audit: connectorAuditSink(connector.audit, wallClock),
    wallClock,
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "bff" } }),
    guestWorldOf: lazyGuestWorldOf(),
    guestWorld: stageGuestWorld,
  };
  return cached;
}

/** Test seam. */
export function resetDefaultDeps(): void {
  cached = undefined;
}
