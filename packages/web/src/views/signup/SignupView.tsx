// `/signup` (docs/landing-spec.md §9.2, FL-112, FL-116, FL-118): asks `signup.availability` first and,
// with the sign-up closed (by the operator or `KILL#SIGNUP`), shows the fixed notice with "Hablemos"
// instead of the form; there is no other call to action. Otherwise the form, its field errors, and
// `signup.start` with the campaign and referrer kept from the visit. `CODE_SENT` keeps the `signupId`
// in sessionStorage and the password in memory, and goes on to `/signup/verify` without a reload.
import { useEffect, useState } from "react";
import { Callout } from "../../components/Callout";
import { useSession } from "../../context/SessionContext";
import { holdPassword, savePendingSignup } from "../../lib/auth/handoff";
import { normalizeUsername } from "../../lib/auth/credentials";
import { PublicApiError, publicApi } from "../../lib/auth/public-api";
import { Redirect, useRouter } from "../../lib/router";
import { CONSOLE_HOME, LOGIN_PATH, RECOVER_PATH, SIGNUP_PATH, SIGNUP_RESTART_PARAM, SIGNUP_VERIFY_PATH } from "../../routes";
import { captureAttribution, readAttribution } from "../landing/attribution";
import { EXTERNAL_LINK, contactHref } from "../landing/links";
import { AuthLayout } from "../login/AuthLayout";
import { useAuthLang, withLang } from "../login/auth-lang";
import { ErrorNote, StepHeading } from "../login/form-parts";
import { handleChallenge, isChallengeRetry, takeChallengeDraft } from "./challenge";
import { SignupFormFields } from "./SignupForm";
import { EMPTY_SIGNUP, type FieldErrors, type SignupForm, draftOf, formFromDraft, startInputOf, startOutcome, validateSignup } from "./signup-model";
import { RESEND_WAIT_MS } from "./verify-model";

type Availability = "checking" | "open" | "closed";
type FormProblem = "taken" | "rateLimited" | "failed" | "network" | "challengeFailed";

const LINK = "font-semibold text-seal-deep underline underline-offset-2";

function Closed() {
  const { copy } = useAuthLang();
  return (
    <div className="space-y-4">
      <StepHeading title={copy.signup.closed.title} />
      <a href={contactHref("signup-unavailable")} {...EXTERNAL_LINK} className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-seal px-4 text-sm font-semibold text-white hover:bg-seal-deep">
        {copy.signup.closed.talk}
      </a>
    </div>
  );
}

function Problem({ problem }: { readonly problem: FormProblem }) {
  const { lang, copy } = useAuthLang();
  if (problem === "taken") {
    const { errors } = copy.signup;
    return (
      <ErrorNote>
        {errors.taken}{" "}
        <a className={LINK} href={withLang(LOGIN_PATH, lang)}>
          {errors.takenSignIn}
        </a>{" "}
        {errors.takenOr}{" "}
        <a className={LINK} href={withLang(RECOVER_PATH, lang)}>
          {errors.takenRecover}
        </a>
        .
      </ErrorNote>
    );
  }
  const text = { rateLimited: copy.common.rateLimited, failed: copy.signup.errors.failed, network: copy.common.network, challengeFailed: copy.common.challengeFailed }[problem];
  return <ErrorNote>{text}</ErrorNote>;
}

export function SignupView() {
  const { state } = useSession();
  const { search, navigate } = useRouter();
  const { lang, copy } = useAuthLang();
  const [availability, setAvailability] = useState<Availability>("checking");
  const [form, setForm] = useState<SignupForm>(() => (isChallengeRetry(search) ? formFromDraft(takeChallengeDraft()) : EMPTY_SIGNUP));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [announced, setAnnounced] = useState(false);
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    captureAttribution();
    let live = true;
    publicApi.availability().then(
      (answer) => live && setAvailability(answer.status),
      // Unknown: offer the form; `signup.start` says SIGNUP_UNAVAILABLE if it is closed.
      () => live && setAvailability("open"),
    );
    return () => {
      live = false;
    };
  }, []);

  if (state.status === "authenticated") return <Redirect to={CONSOLE_HOME} />;

  const submit = async (): Promise<void> => {
    const found = validateSignup(form);
    setErrors(found);
    setAnnounced(true);
    setProblem(undefined);
    if (Object.keys(found).length > 0 || busy) return;
    setBusy(true);
    try {
      const outcome = startOutcome(await publicApi.start(startInputOf(form, lang, readAttribution())));
      if (outcome.kind === "codeSent") {
        savePendingSignup({ signupId: outcome.signupId, email: normalizeUsername(form.email), resendAvailableAt: Date.now() + RESEND_WAIT_MS });
        holdPassword(form.password);
        navigate(withLang(SIGNUP_VERIFY_PATH, lang));
        return;
      }
      if (outcome.kind === "fieldErrors") setErrors(outcome.errors);
      else if (outcome.kind === "closed") setAvailability("closed");
      else setProblem(outcome.kind);
    } catch (error) {
      if (error instanceof PublicApiError && error.kind === "challenge") {
        if (handleChallenge(SIGNUP_PATH, search, draftOf(form), (url) => window.location.assign(url)) === "reloading") return;
        setProblem("challengeFailed");
      } else setProblem(error instanceof PublicApiError && error.kind === "network" ? "network" : "failed");
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (availability === "checking") body = <p className="text-sm text-slate">{copy.common.loading}</p>;
  else if (availability === "closed") body = <Closed />;
  else {
    body = (
      <div className="space-y-4">
        <StepHeading title={copy.signup.title} lead={copy.signup.lead} />
        {search.get(SIGNUP_RESTART_PARAM) === "1" ? <Callout tone="warning">{copy.signup.restart}</Callout> : null}
        {problem ? <Problem problem={problem} /> : null}
        <SignupFormFields copy={copy} form={form} errors={errors} announced={announced} busy={busy} onChange={setForm} onSubmit={() => void submit()} />
        <p className="border-t border-mist pt-4 text-center text-sm text-slate">
          {copy.signup.haveAccount} ·{" "}
          <a className={`${LINK} inline-flex min-h-11 items-center`} href={withLang(LOGIN_PATH, lang)}>
            {copy.signup.signIn}
          </a>
        </p>
      </div>
    );
  }
  return <AuthLayout>{body}</AuthLayout>;
}
