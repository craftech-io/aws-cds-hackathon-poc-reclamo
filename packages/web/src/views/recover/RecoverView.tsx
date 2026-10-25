// `/login/recover` (docs/landing-spec.md §9.6, FL-122): the email, and `password.forgot`, whose answer
// is the same whether the address has an account or not (the BFF only calls Cognito for a self-signup
// guest; staff recover through an administrator). The page reached by a full load (the edge challenges
// it); the next step, `/login/recover/reset`, is a SPA navigation that keeps the email in memory.
import { type FormEvent, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { looksLikeEmail, normalizeUsername } from "../../lib/auth/credentials";
import { holdLoginEmail } from "../../lib/auth/handoff";
import { PublicApiError, publicApi } from "../../lib/auth/public-api";
import { Redirect, useRouter } from "../../lib/router";
import { CONSOLE_HOME, RECOVER_PATH, RECOVER_RESET_PATH } from "../../routes";
import { AuthLayout } from "../login/AuthLayout";
import { useAuthLang, withLang } from "../login/auth-lang";
import { ErrorNote, StepHeading, SubmitButton } from "../login/form-parts";
import { handleChallenge, isChallengeRetry, takeChallengeDraft } from "../signup/challenge";
import { BackToLogin, EmailField } from "./parts";

type RecoverProblem = "rateLimited" | "failed" | "network" | "challengeFailed";

function draftEmail(search: URLSearchParams): string {
  if (!isChallengeRetry(search)) return "";
  const email = takeChallengeDraft()?.email;
  return typeof email === "string" ? email : "";
}

export function RecoverView() {
  const { state } = useSession();
  const { search, navigate } = useRouter();
  const { lang, copy } = useAuthLang();
  const [email, setEmail] = useState(() => draftEmail(search));
  const [invalid, setInvalid] = useState(false);
  const [problem, setProblem] = useState<RecoverProblem | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  if (state.status === "authenticated") return <Redirect to={CONSOLE_HOME} />;
  const text = copy.recover;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setProblem(undefined);
    if (!looksLikeEmail(email)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setBusy(true);
    try {
      const answer = await publicApi.forgot({ email: email.trim(), locale: lang });
      if (answer.status === "RATE_LIMITED") {
        setProblem("rateLimited");
        return;
      }
      holdLoginEmail(normalizeUsername(email));
      navigate(withLang(RECOVER_RESET_PATH, lang));
    } catch (error) {
      if (error instanceof PublicApiError && error.kind === "challenge") {
        if (handleChallenge(RECOVER_PATH, search, { email }, (url) => window.location.assign(url)) === "reloading") return;
        setProblem("challengeFailed");
      } else setProblem(error instanceof PublicApiError && error.kind === "network" ? "network" : "failed");
    } finally {
      setBusy(false);
    }
  };

  const problemText = problem && { rateLimited: copy.common.rateLimited, failed: text.sendFailed, network: copy.common.network, challengeFailed: copy.common.challengeFailed }[problem];
  return (
    <AuthLayout>
      <form className="space-y-4" onSubmit={(event) => void submit(event)} noValidate>
        <StepHeading title={text.title} lead={text.lead} />
        {problemText ? <ErrorNote>{problemText}</ErrorNote> : null}
        <EmailField value={email} onChange={setEmail} invalid={invalid} />
        <SubmitButton busy={busy} working={copy.common.working}>
          {text.submit}
        </SubmitButton>
        <BackToLogin />
      </form>
    </AuthLayout>
  );
}
