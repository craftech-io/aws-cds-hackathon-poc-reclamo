// Secure Remote Password for Cognito's USER_SRP_AUTH: the password never leaves the browser, only
// the proof that we know it. The math is `cognito-srp-helper` (Cognito's SRP-6a variant and
// nothing else: no network, no storage, no token handling); this file adapts it to the flow and
// loads it lazily, so the console bundle only pays for it on the login screen.

/** One SRP exchange: `srpA` goes in InitiateAuth, `sign` answers the PASSWORD_VERIFIER challenge. */
export interface SrpExchange {
  readonly srpA: string;
  /** PASSWORD_VERIFIER responses for the challenge parameters Cognito returned. */
  sign(challengeParameters: Readonly<Record<string, string>>): Promise<Record<string, string>>;
}

export interface SrpClient {
  start(username: string, password: string): Promise<SrpExchange>;
}

export class SrpError extends Error {
  override readonly name = "SrpError";
}

export function createSrpClient(userPoolId: string): SrpClient {
  return {
    async start(username, password) {
      const srp = await import("cognito-srp-helper");
      // `false`: the password is plain text; the helper hashes it with USER_ID_FOR_SRP when signing.
      const session = srp.createSrpSession(username, password, userPoolId, false);
      return {
        srpA: session.largeA,
        async sign(challengeParameters) {
          const userIdForSrp = challengeParameters.USER_ID_FOR_SRP;
          if (!userIdForSrp) throw new SrpError("the challenge names no user");
          let signed;
          try {
            signed = srp.signSrpSession(session, { ChallengeName: "PASSWORD_VERIFIER", ChallengeParameters: { ...challengeParameters } });
          } catch (error) {
            throw new SrpError(error instanceof Error ? error.message : "SRP signature failed");
          }
          return {
            USERNAME: userIdForSrp,
            PASSWORD_CLAIM_SECRET_BLOCK: signed.secret,
            PASSWORD_CLAIM_SIGNATURE: signed.passwordSignature,
            TIMESTAMP: signed.timestamp,
          };
        },
      };
    },
  };
}
