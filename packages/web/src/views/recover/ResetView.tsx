// `/login/recover/reset` (docs/landing-spec.md §9.6, FL-122): the code that may have arrived, the new
// password twice (the pool's policy as a checklist) and `password.reset`. It opens with the neutral
// answer ("for privacy we don't confirm whether an email has an account"); the email comes from the
// previous step in memory, and is asked again after a reload. A changed password goes to `/login`
// with the email pre-filled and "your password has changed".
import { type FormEvent, useState } from "react";
import { hasOuterSpaces, looksLikeEmail, missingPasswordRules, normalizeTotpCode } from "../../lib/auth/credentials";
import { holdLoginEmail, loginEmailHint } from "../../lib/auth/handoff";
import { PublicApiError, publicApi } from "../../lib/auth/public-api";
import { useRouter } from "../../lib/router";
import { LOGIN_NOTICE, LOGIN_PATH, RECOVER_PATH } from "../../routes";
import { AuthLayout } from "../login/AuthLayout";
import { useAuthLang, withLang } from "../login/auth-lang";
import { CodeField, ErrorNote, NoticeNote, PasswordField, PasswordRules, StepHeading, SubmitButton } from "../login/form-parts";
import { BackToLogin, EmailField } from "./parts";

type ResetProblem = "mismatch" | "expired" | "weakPassword" | "rateLimited" | "failed" | "network";

const LINK = "font-semibold text-seal-deep underline underline-offset-2";

export function ResetView() {
  const { navigate } = useRouter();
  const { lang, copy } = useAuthLang();
  const [knownEmail] = useState(loginEmailHint);
  const [email, setEmail] = useState(knownEmail ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<ResetProblem | undefined>(undefined);
  const [invalidEmail, setInvalidEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const text = copy.recover;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setProblem(undefined);
    const digits = normalizeTotpCode(code);
    setInvalidEmail(!looksLikeEmail(email));
    if (!looksLikeEmail(email)) return;
    if (!digits) {
      setProblem("mismatch");
      return;
    }
    if (missingPasswordRules(password).length > 0 || hasOuterSpaces(password)) {
      setProblem("weakPassword");
      return;
    }
    if (password !== confirm) return;
    setBusy(true);
    try {
      const answer = await publicApi.reset({ email: email.trim(), code: digits, newPassword: password, locale: lang });
      switch (answer.status) {
        case "PASSWORD_CHANGED":
          holdLoginEmail(email.trim().toLowerCase());
          navigate(withLang(`${LOGIN_PATH}?${LOGIN_NOTICE.param}=${LOGIN_NOTICE.passwordChanged}`, lang), { replace: true });
          return;
        case "CODE_MISMATCH":
          setProblem("mismatch");
          break;
        case "CODE_EXPIRED":
          setProblem("expired");
          break;
        case "WEAK_PASSWORD":
          setProblem("weakPassword");
          break;
        case "RATE_LIMITED":
          setProblem("rateLimited");
          break;
      }
    } catch (error) {
      setProblem(error instanceof PublicApiError && error.kind === "network" ? "network" : "failed");
    } finally {
      setBusy(false);
    }
  };

  const problemText = problem && {
    mismatch: text.mismatch,
    expired: text.expired,
    weakPassword: copy.signup.errors.weakPassword,
    rateLimited: copy.common.rateLimited,
    failed: text.saveFailed,
    network: copy.common.network,
  }[problem];
  return (
    <AuthLayout>
      <form className="space-y-4" onSubmit={(event) => void submit(event)} noValidate>
        <StepHeading title={text.resetTitle} lead={text.resetLead} />
        <NoticeNote>{text.neutral}</NoticeNote>
        {problemText ? (
          <ErrorNote>
            {problemText}
            {problem === "expired" ? (
              <>
                {" "}
                <a className={LINK} href={withLang(RECOVER_PATH, lang)}>
                  {text.requestAgain}
                </a>
              </>
            ) : null}
          </ErrorNote>
        ) : null}
        {knownEmail === undefined ? (
          <EmailField value={email} onChange={setEmail} invalid={invalidEmail} />
        ) : null}
        <CodeField label={text.code} value={code} onChange={setCode} />
        <PasswordField label={text.newPassword} toggle={copy.password} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <PasswordRules password={password} text={copy.password} />
        <PasswordField label={text.confirmPassword} toggle={copy.password} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} error={mismatch ? copy.password.mismatch : undefined} required />
        <SubmitButton busy={busy} working={copy.common.working}>
          {text.save}
        </SubmitButton>
        <BackToLogin />
      </form>
    </AuthLayout>
  );
}
