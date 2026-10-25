// `/signup/verify` (docs/landing-spec.md §9.3, FL-113 to FL-115): the code with the `signupId` the tab
// kept (never in the URL), "Resend code" disabled for 30 s after every code, and the answers of the
// spec: a wrong or expired code says so; `SIGNUP_RESTART` goes back to `/signup` with its notice.
// `CONFIRMED` signs the person in silently with the password still in memory and opens
// `/signup/provisioning`; without it (a reload, another tab) it opens `/login` with the email
// pre-filled and "your account is confirmed".
import { type FormEvent, useEffect, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { normalizeTotpCode } from "../../lib/auth/credentials";
import { flowDeps } from "../../lib/auth/deps";
import { silentSignIn } from "../../lib/auth/flow";
import { clearPendingSignup, forgetPassword, heldPassword, markSignupConfirmed, readPendingSignup, savePendingSignup } from "../../lib/auth/handoff";
import { PublicApiError, publicApi } from "../../lib/auth/public-api";
import { Redirect, useRouter } from "../../lib/router";
import { LOGIN_NOTICE, LOGIN_PATH, PROVISIONING_PATH, SIGNUP_PATH, SIGNUP_RESTART_PARAM } from "../../routes";
import { AuthLayout } from "../login/AuthLayout";
import { useAuthLang, withLang } from "../login/auth-lang";
import { CodeField, ErrorNote, NoticeNote, SubmitButton } from "../login/form-parts";
import { afterResend, confirmOutcome, secondsUntilResend } from "./verify-model";

type VerifyProblem = "mismatch" | "expired" | "rateLimited" | "failed" | "network";

/** Seconds left until `target`, re-read every second while there are any. */
function useSecondsUntil(target: number): number {
  const [now, setNow] = useState(() => Date.now());
  const left = secondsUntilResend(target, now);
  useEffect(() => {
    if (left === 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1_000);
    return () => window.clearTimeout(timer);
  }, [left, now]);
  return left;
}

export function VerifyView() {
  const { auth, completeSignIn } = useSession();
  const { navigate } = useRouter();
  const { lang, copy } = useAuthLang();
  const [pending, setPending] = useState(readPendingSignup);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<VerifyProblem | undefined>(undefined);
  const [resent, setResent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const seconds = useSecondsUntil(pending?.resendAvailableAt ?? 0);

  if (!pending?.signupId) {
    return <Redirect to={pending?.confirmed ? withLang(`${LOGIN_PATH}?${LOGIN_NOTICE.param}=${LOGIN_NOTICE.confirmed}`, lang) : withLang(SIGNUP_PATH, lang)} />;
  }
  const { signupId, email } = pending;
  const text = copy.verify;

  const confirmed = async (): Promise<void> => {
    markSignupConfirmed(email);
    const password = heldPassword();
    forgetPassword();
    if (password && auth) {
      setSigningIn(true);
      const tokens = await silentSignIn(email, password, flowDeps(auth.cognito, auth.srp, { kind: "signIn" })).catch(() => undefined);
      if (tokens) {
        clearPendingSignup();
        completeSignIn(tokens);
        navigate(withLang(PROVISIONING_PATH, lang), { replace: true });
        return;
      }
    }
    navigate(withLang(`${LOGIN_PATH}?${LOGIN_NOTICE.param}=${LOGIN_NOTICE.confirmed}`, lang), { replace: true });
  };

  const confirm = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setResent(false);
    const digits = normalizeTotpCode(code);
    if (!digits) {
      setProblem("mismatch");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const outcome = confirmOutcome(await publicApi.confirm({ signupId, code: digits }));
      if (outcome.kind === "confirmed") return await confirmed();
      if (outcome.kind === "restart") {
        clearPendingSignup();
        forgetPassword();
        // A full page load: `/signup` is where the edge challenges the browser.
        window.location.assign(withLang(`${SIGNUP_PATH}?${SIGNUP_RESTART_PARAM}=1`, lang));
        return;
      }
      setCode("");
      setProblem(outcome.kind);
    } catch (error) {
      setProblem(error instanceof PublicApiError && error.kind === "network" ? "network" : "failed");
    } finally {
      setBusy(false);
    }
  };

  const resend = async (): Promise<void> => {
    if (seconds > 0 || busy) return;
    setBusy(true);
    setProblem(undefined);
    setResent(false);
    try {
      const next = afterResend(await publicApi.resend(signupId), Date.now());
      if (next.sent && next.resendAvailableAt !== undefined) {
        const updated = { ...pending, resendAvailableAt: next.resendAvailableAt };
        savePendingSignup(updated);
        setPending(updated);
        setResent(true);
      } else setProblem("rateLimited");
    } catch (error) {
      setProblem(error instanceof PublicApiError && error.kind === "network" ? "network" : "failed");
    } finally {
      setBusy(false);
    }
  };

  const problemText = problem && { mismatch: text.mismatch, expired: text.expired, rateLimited: copy.common.rateLimited, failed: text.failed, network: copy.common.network }[problem];
  return (
    <AuthLayout>
      <form className="space-y-4" onSubmit={(event) => void confirm(event)} noValidate>
        <h1 className="text-2xl font-semibold text-pine">{text.title}</h1>
        <p className="text-sm text-slate">
          {text.lead.before}
          <strong className="break-all text-ink">{email}</strong>
          {text.lead.after}
        </p>
        {signingIn ? <NoticeNote>{text.signingIn}</NoticeNote> : null}
        {resent ? <NoticeNote>{text.resent}</NoticeNote> : null}
        {problemText ? <ErrorNote>{problemText}</ErrorNote> : null}
        <CodeField label={text.code} value={code} onChange={setCode} />
        <SubmitButton busy={busy || signingIn} working={copy.common.working}>
          {text.submit}
        </SubmitButton>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <button type="button" onClick={() => void resend()} disabled={seconds > 0 || busy || signingIn} className="inline-flex min-h-11 items-center font-semibold text-seal-deep underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-slate disabled:no-underline">
            {seconds > 0 ? text.resendIn(seconds) : text.resend}
          </button>
          <a href={withLang(SIGNUP_PATH, lang)} onClick={() => clearPendingSignup()} className="inline-flex min-h-11 items-center text-slate underline-offset-2 hover:text-pine hover:underline">
            {text.otherEmail}
          </a>
        </div>
      </form>
    </AuthLayout>
  );
}
