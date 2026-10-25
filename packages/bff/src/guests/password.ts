// Password recovery, only for self-signup guests (docs/architecture-guests.md §2, §4): staff and the
// shared `guest-NN` accounts recover through an administrator (ADR-0018). `password.forgot` always
// answers the same (`CODE_SENT_IF_EXISTS`) and calls Cognito only when the email belongs to a
// confirmed lead whose staff row is an active `GUEST` of that lead's own `gs-*` world; otherwise
// nothing leaves. `password.reset` runs the same check before `ConfirmForgotPassword`.
import { CognitoFailure } from "./cognito-port";
import { checkEmailShape } from "./email-domain";
import { leadsKeys } from "../leads/keys";
import { type PasswordForgotResult, type PasswordResetResult, passwordProblem } from "./schemas";
import { type SignupServiceDeps, auditEdge } from "./service-deps";

/** The self-signup account of an email (its `sub` and username), or `undefined` for any other address. */
export async function selfSignupAccount(deps: SignupServiceDeps, rawEmail: string): Promise<{ readonly sub: string; readonly email: string } | undefined> {
  const shape = checkEmailShape(rawEmail);
  if (!shape.ok) return undefined;
  const emailHashKey = leadsKeys.emailHashKey(deps.hashes.emailHash(shape.email));
  const page = await deps.ctx.store.query({ table: "Leads", index: "ByEmailHash", partition: emailHashKey, limit: 10 });
  const leadKeys = page.items.filter((item) => item.pk.startsWith("LEAD#"));
  if (leadKeys.length !== 1) return undefined;
  const sub = leadKeys[0]?.pk.slice("LEAD#".length) ?? "";
  const worldId = deps.hashes.guestWorldId(sub);
  const staff = await deps.connector.worlds.getStaff(worldId, `stf-${worldId}`);
  const owns = staff !== undefined && staff.active !== false && staff.role === "GUEST" && staff.cognitoSubKey === leadsKeys.subKey(sub);
  return owns ? { sub, email: shape.email } : undefined;
}

export function passwordService(deps: SignupServiceDeps) {
  return {
    async forgot(input: { readonly email: string; readonly locale: "es" | "en" }, viewerIp: string): Promise<PasswordForgotResult> {
      const ipHash = deps.hashes.ipHash(viewerIp);
      if (!(await deps.caps.recoveryFromIp(ipHash))) {
        await auditEdge(deps, { action: "SIGNUP_REJECTED", outcome: "RATE_LIMITED", refs: { step: "recovery", ipHash: ipHash.slice(0, 16) } });
        return { status: "RATE_LIMITED" };
      }
      const account = await selfSignupAccount(deps, input.email);
      if (!account) return { status: "CODE_SENT_IF_EXISTS" };
      // The global cap says nothing about the account; the per-account cap stays silent on purpose.
      if (!(await deps.caps.authMailOpen())) return { status: "RATE_LIMITED" };
      if (!(await deps.caps.recoveryOfAccount(account.sub))) return { status: "CODE_SENT_IF_EXISTS" };
      if (!(await deps.caps.spendAuthMail())) return { status: "RATE_LIMITED" };
      try {
        await deps.cognito.forgotPassword({ username: account.email, clientMetadata: { locale: input.locale } });
      } catch (error) {
        if (!(error instanceof CognitoFailure) || error.code === "UNAVAILABLE") throw error;
      }
      return { status: "CODE_SENT_IF_EXISTS" };
    },

    async reset(input: { readonly email: string; readonly code: string; readonly newPassword: string }): Promise<PasswordResetResult> {
      if (passwordProblem(input.newPassword)) return { status: "WEAK_PASSWORD" };
      const account = await selfSignupAccount(deps, input.email);
      if (!account) return { status: "CODE_MISMATCH" };
      try {
        await deps.cognito.confirmForgotPassword({ username: account.email, code: input.code, password: input.newPassword, clientMetadata: {} });
      } catch (error) {
        if (!(error instanceof CognitoFailure)) throw error;
        if (error.code === "CODE_MISMATCH" || error.code === "USER_NOT_FOUND") return { status: "CODE_MISMATCH" };
        if (error.code === "CODE_EXPIRED") return { status: "CODE_EXPIRED" };
        if (error.code === "WEAK_PASSWORD") return { status: "WEAK_PASSWORD" };
        if (error.code === "LIMIT_EXCEEDED") return { status: "RATE_LIMITED" };
        throw error;
      }
      return { status: "PASSWORD_CHANGED" };
    },
  };
}

export type PasswordService = ReturnType<typeof passwordService>;
