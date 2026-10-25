// Sign-in and sign-up actions of the QaDriver (docs/tool-catalog.md, docs/architecture-guests.md §4):
//
//   auth.session    the user `qa-<runId>-<scenario>-<role>` of a QA world (created once, with its group and
//                   its `STAFF#` row bound to its `sub`), a NEW random password on every call (generated and
//                   used inside the Lambda), and a real login (`ADMIN` by `ServerClient`, `SRP` by
//                   `ConsoleClient`) through the deployed pre-token trigger; only the tokens come back
//   guest.signup    the real self-signup service in process (guests/signup.ts) with the run's own address
//                   `success+qa-<runId>-<key>@simulator.amazonses.com`, its QA buckets and `QASIGNUP#`
//   guest.confirm   `AdminConfirmSignUp` with `clientMetadata.signupId` (the real post-confirmation trigger),
//                   then the confirmation's repair path (also for an account Cognito confirmed already);
//                   or `signup.confirm`'s own path with a given code
//   guest.resend    `ResendConfirmationCode` through the same service
//   guest.session   only a CONFIRMED account (else FORBIDDEN `NOT_CONFIRMED`): a new password and an SRP
//                   login of that account; the tokens carry `worldStatus`
//   guest.lead      the run's QALEAD# as SC-24 checks it (campaign, consents, instants), never its address
//   probe.edge      the Bff's Function URL without the edge header must answer 403 `EDGE_REQUIRED`
//   notice.probe    the real lead notice of a synthetic QA lead through the real SES transport, to the SES
//                   mailbox simulator only, audited `LEAD_NOTICE_PROBE` (leads/probe.ts)
//   probe.cognitoClients  `SignUp`, `ForgotPassword` and `ConfirmForgotPassword` of the QA world's SUPERVISOR
//                   sent straight to Cognito with the `ServerClient` and the `ConsoleClient`: the pool's
//                   web ACL must refuse each (`ForbiddenException`, FL-119, FL-122)
//
// Never a password, a code or a refresh token in an answer or a log; never an address but the run's own.
// Every Cognito error comes back with an explicit reason (cognito-refusal.ts).
import { ToolError } from "@reclamo/shared";
import { keys } from "../connector/keys";
import { qaSignupEmail } from "../guests/signup";
import { probeLeadNotice } from "../leads/probe";
import { leadsRepo } from "../leads/repo";
import type { QaScope } from "../leads/keys";
import { QA_REASON, keyParts } from "./contract";
import { ensureQaUser, qaStaffId, qaUsername } from "./actions-world";
import type { QaInput } from "./inputs";
import type { ActionContext, SessionTokens } from "./ports";

/** A documentation address (RFC 5737): the runner has no viewer IP; only its hash is ever used. */
export const QA_VIEWER_IP = "192.0.2.10";

function worldOf(ctx: ActionContext): string {
  if (ctx.worldId === undefined) throw new ToolError("INVALID", "this action needs its world");
  return ctx.worldId;
}

function claimOf(token: string, name: string): unknown {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    return Reflect.get(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as object, name);
  } catch {
    return undefined;
  }
}

/** Only what the runner needs from a login. */
function tokensOf(tokens: SessionTokens): SessionTokens {
  return { idToken: tokens.idToken, accessToken: tokens.accessToken, exp: tokens.exp, authTime: tokens.authTime, loginMs: tokens.loginMs };
}

export async function authSession(input: QaInput<"auth.session">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const cognito = ctx.ports.cognito();
  const username = qaUsername(worldId, input.role);
  const sub = await ensureQaUser(ctx, worldId, input.role);
  const staffId = qaStaffId(input.role);
  const staff = await ctx.ports.data.worlds.getStaff(worldId, staffId);
  // A user the janitor deleted and this call recreated has a new `sub`: its row follows it.
  if (staff?.cognitoSubKey !== keys.subKey(sub) || staff.role !== input.role || !staff.active) {
    await ctx.ports.data.worlds.putStaff({ worldId, staffId, role: input.role, displayName: `QA ${input.role.toLowerCase()}`, cognitoSubKey: keys.subKey(sub), active: true }, { replace: true });
  }
  const password = ctx.ports.newPassword();
  await cognito.setPassword(username, password);
  const tokens = tokensOf(await cognito.login(input.flow, username, password));
  ctx.log.info("qa_driver.session", { role: input.role, flow: input.flow, loginMs: tokens.loginMs });
  if (input.probeCognito !== true) return tokens;
  return { ...tokens, probe: await cognito.probeSelfService(tokens.accessToken) };
}

function scopeOf(input: { readonly runId: string; readonly key: string }): QaScope {
  return { runId: input.runId, key: input.key };
}

export async function guestSignup(input: QaInput<"guest.signup">, ctx: ActionContext): Promise<unknown> {
  const qa = scopeOf(input);
  const result = await ctx.ports.signup(ctx.log).start(
    {
      email: qaSignupEmail(qa),
      password: ctx.ports.newPassword(),
      acceptTerms: true,
      acceptContact: input.acceptContact,
      locale: input.locale,
      ...(input.utm ? { utm: input.utm } : {}),
      ...(input.referrer ? { referrer: input.referrer } : {}),
    },
    QA_VIEWER_IP,
    qa,
  );
  return { ...result, worldId: worldOf(ctx) };
}

async function adminConfirm(ctx: ActionContext, username: string, signupId: string): Promise<void> {
  try {
    await ctx.ports.cognito().adminConfirmSignUp(username, { signupId });
  } catch (error) {
    // Confirmed already: like `signup.confirm` on its own, the repair path below registers it.
    if (!(error instanceof ToolError && error.reason === QA_REASON.ALREADY_CONFIRMED)) throw error;
    ctx.log.warn("qa_driver.already_confirmed", {});
  }
}

export async function guestConfirm(input: QaInput<"guest.confirm">, ctx: ActionContext): Promise<unknown> {
  const qa = scopeOf(input);
  const service = ctx.ports.signup(ctx.log);
  if (input.code === undefined) await adminConfirm(ctx, qaSignupEmail(qa), input.signupId);
  // After the admin confirmation `signup.confirm` takes its repair path (the trigger's registration, idempotent).
  const result = await service.confirm({ signupId: input.signupId, code: input.code ?? "000000" }, qa);
  // The answer never carries the address back.
  return result.status === "CONFIRMED" ? { status: result.status, worldStatus: result.worldStatus, worldId: worldOf(ctx) } : { status: result.status };
}

export async function guestResend(input: QaInput<"guest.resend">, ctx: ActionContext): Promise<unknown> {
  return ctx.ports.signup(ctx.log).resend({ signupId: input.signupId }, scopeOf(input));
}

/**
 * Only a CONFIRMED account signs in: a permanent password on an UNCONFIRMED one would confirm it in
 * Cognito without the post-confirmation trigger (no `PROVISIONREQ#`, no lead).
 */
async function assertConfirmed(ctx: ActionContext, username: string): Promise<void> {
  const status = await ctx.ports.cognito().accountStatus(username);
  if (status === "CONFIRMED") return;
  if (status === "MISSING") throw new ToolError("NOT_FOUND", "no such account", QA_REASON.USER_NOT_FOUND);
  if (status === "UNCONFIRMED") throw new ToolError("FORBIDDEN", "the account is not confirmed: guest.confirm first", QA_REASON.NOT_CONFIRMED);
  throw new ToolError("FORBIDDEN", "the account is in a state the driver never signs in", QA_REASON.ACCOUNT_STATE);
}

export async function guestSession(input: QaInput<"guest.session">, ctx: ActionContext): Promise<unknown> {
  const username = qaSignupEmail(scopeOf(input));
  const cognito = ctx.ports.cognito();
  await assertConfirmed(ctx, username);
  const password = ctx.ports.newPassword();
  await cognito.setPassword(username, password);
  const tokens = tokensOf(await cognito.login("SRP", username, password));
  const worldStatus = claimOf(tokens.idToken, "worldStatus");
  return { ...tokens, worldStatus: typeof worldStatus === "string" ? worldStatus : null };
}

/** The QA lead of `qa-<runId>-su<n>`, found by the `sub` its GUEST row is bound to; no email, no `sub`. */
export async function guestLead(input: QaInput<"guest.lead">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  const staff = await ctx.ports.data.worlds.getStaff(worldId, `stf-${worldId}`);
  const sub = staff?.cognitoSubKey.replace(/^SUB#/, "");
  const lead = sub ? await leadsRepo({ store: ctx.ports.store, now: ctx.ports.now }).getLead(sub, scopeOf(input)) : undefined;
  if (!lead) return { exists: false };
  return {
    exists: true,
    worldId: lead.worldId,
    locale: lead.locale,
    utm: lead.utm ?? null,
    referrer: lead.referrer ?? null,
    consents: { termsVersion: lead.consents.terms.textVersion, contactAccepted: lead.consents.contact.accepted },
    signupAtReal: lead.signupAtReal,
    confirmedAtReal: lead.confirmedAtReal,
    lastLoginAtReal: lead.lastLoginAtReal ?? null,
    notified: lead.notifiedAtReal !== undefined,
  };
}

export async function probeEdge(_input: QaInput<"probe.edge">, ctx: ActionContext): Promise<unknown> {
  const answer = await ctx.ports.edge();
  return { status: answer.status, reason: answer.reason, refused: answer.status === 403 && answer.reason === "EDGE_REQUIRED" };
}

export async function noticeProbe(_input: QaInput<"notice.probe">, ctx: ActionContext): Promise<unknown> {
  const { runId } = keyParts(ctx.key);
  return probeLeadNotice(runId, { ctx: { store: ctx.ports.store, now: ctx.ports.now }, connector: ctx.ports.data, transport: ctx.ports.noticeProbe(), log: ctx.log });
}

/** The answer of Cognito's REGIONAL web ACL to a client other than the `GuestSignupClient`. */
export const WAF_REFUSAL = "ForbiddenException";

export async function probeCognitoClients(_input: QaInput<"probe.cognitoClients">, ctx: ActionContext): Promise<unknown> {
  const worldId = worldOf(ctx);
  // An existing account, so even a pool without the ACL would neither create a user nor send a code: the
  // SUPERVISOR has no verified email, and a SignUp of its name collides.
  await ensureQaUser(ctx, worldId, "SUPERVISOR");
  const answers = await ctx.ports.cognito().probeClients(qaUsername(worldId, "SUPERVISOR"), ctx.ports.newPassword());
  const refused = Object.values(answers).every((calls) => Object.values(calls).every((name) => name === WAF_REFUSAL));
  ctx.log.info("qa_driver.cognito_clients", { refused });
  return { refused, answers };
}

/** A login that Cognito answered with a challenge the driver never answers (MFA). */
export function challengeRefusal(challenge: string): ToolError {
  return new ToolError("UNAVAILABLE", `Cognito asked for ${challenge}`, QA_REASON.AUTH_CHALLENGE);
}
