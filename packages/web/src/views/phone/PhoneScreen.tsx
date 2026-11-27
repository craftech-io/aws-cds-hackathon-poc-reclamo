// The SMS-code screen after the password (docs/architecture-guests.md §17, FL-129, FL-130). Enrolment:
// the number (prefilled with the one of the form, editable), "Send code", then the 6-digit code. Every
// later sign-in: only the last digits of the verified number (it cannot be changed here), the code sent
// by itself once, and the resend countdown. Every refusal is a fixed text; the ones a person cannot fix
// alone carry the "contact us" link. Responsive with the access screens' layout and the theme's styles.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSession } from "../../context/SessionContext";
import { EXTERNAL_LINK, contactHref } from "../landing/links";
import { AuthLayout } from "../login/AuthLayout";
import { useAuthLang } from "../login/auth-lang";
import { CodeField, ErrorNote, Field, LinkButton, NoticeNote, StepHeading, SubmitButton } from "../login/form-parts";
import { type PhoneProblem, type PhoneStatus, SendCodeAnswer, VerifyAnswer, codeOf, secondsUntil, sendProblem, verifyProblem } from "./phone-model";

type Pending = Extract<PhoneStatus, { readonly state: "ENROL" | "SIGN_IN" }>;

const LINK = "font-semibold text-seal-deep underline underline-offset-2";
const RESEND = "inline-flex min-h-11 items-center text-sm font-semibold text-seal-deep underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-slate disabled:no-underline";

function useCountdown(atReal: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const seconds = secondsUntil(atReal, now);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [seconds]);
  return seconds;
}

function Problem({ problem, contactText }: { readonly problem: PhoneProblem; readonly contactText: string }) {
  return (
    <ErrorNote>
      {problem.text}
      {problem.contact ? (
        <>
          {" "}
          <a className={LINK} href={contactHref("phone-verification")} {...EXTERNAL_LINK}>
            {contactText}
          </a>
        </>
      ) : null}
    </ErrorNote>
  );
}

export function PhoneScreen({ status, onPassed }: { readonly status: Pending; readonly onPassed: () => void }) {
  const { trpc, signOut } = useSession();
  const { lang, copy } = useAuthLang();
  const text = copy.phone;
  const enrolling = status.state === "ENROL";
  const [phone, setPhone] = useState(status.state === "ENROL" ? (status.phone ?? "") : "");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(status.codeSent);
  const [resendAt, setResendAt] = useState(status.resendAvailableAtReal);
  const [problem, setProblem] = useState<PhoneProblem | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const seconds = useCountdown(resendAt);
  const autoSent = useRef(false);

  const send = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const answer = SendCodeAnswer.parse(await trpc.phone.sendCode.mutate({ ...(enrolling ? { phone } : {}), locale: lang }));
      if (answer.status === "NOT_REQUIRED") return onPassed();
      if (answer.status === "CODE_SENT" || answer.status === "RESEND_TOO_SOON") setResendAt(answer.resendAvailableAtReal);
      if (answer.status === "CODE_SENT") setCodeSent(true);
      setProblem(sendProblem(answer, text.errors));
    } catch {
      setProblem({ text: text.errors.failed, contact: false });
    } finally {
      setBusy(false);
    }
  };

  // A sign-in sends its code by itself, once, unless a live one is already on its way.
  useEffect(() => {
    if (enrolling || autoSent.current || status.codeSent || secondsUntil(status.resendAvailableAtReal, Date.now()) > 0) return;
    autoSent.current = true;
    void send();
    // `send` reads the current state; this runs once per screen.
  }, []);

  const verify = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const digits = codeOf(code);
    if (!digits) {
      setProblem({ text: text.errors.codeShape, contact: false });
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const answer = VerifyAnswer.parse(await trpc.phone.verify.mutate({ code: digits }));
      if (answer.status === "VERIFIED" || answer.status === "NOT_REQUIRED") return onPassed();
      setCode("");
      if (answer.status === "CODE_MISMATCH" && answer.attemptsLeft === 0) setCodeSent(false);
      setProblem(verifyProblem(answer, text.errors));
    } catch {
      setProblem({ text: text.errors.failed, contact: false });
    } finally {
      setBusy(false);
    }
  };

  const sendForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };

  return (
    <AuthLayout>
      <div className="space-y-4">
        {enrolling ? (
          <StepHeading title={text.enrolTitle} lead={text.enrolLead} />
        ) : (
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-pine">{text.signInTitle}</h1>
            <p className="text-sm text-slate">
              {text.signInLead.before}
              <strong className="text-ink">{status.state === "SIGN_IN" ? status.lastDigits : ""}</strong>
              {text.signInLead.after}
            </p>
          </div>
        )}
        {problem ? <Problem problem={problem} contactText={text.contact} /> : null}
        {codeSent && !problem ? <NoticeNote>{text.sent}</NoticeNote> : null}
        {enrolling ? (
          <form className="space-y-3" onSubmit={sendForm} noValidate>
            <Field label={text.number} type="tel" inputMode="tel" autoComplete="tel" maxLength={32} value={phone} onChange={(event) => setPhone(event.target.value)} required />
            <p className="-mt-1 text-xs text-slate">{text.numberHint}</p>
            {codeSent ? null : (
              <SubmitButton busy={busy} working={copy.common.working}>
                {text.send}
              </SubmitButton>
            )}
          </form>
        ) : null}
        {codeSent || !enrolling ? (
          <form className="space-y-3" onSubmit={(event) => void verify(event)} noValidate>
            <CodeField label={text.code} value={code} onChange={setCode} />
            <SubmitButton busy={busy} working={copy.common.working}>
              {text.verify}
            </SubmitButton>
            <button type="button" onClick={() => void send()} disabled={seconds > 0 || busy} className={RESEND}>
              {seconds > 0 ? text.resendIn(seconds) : text.resend}
            </button>
          </form>
        ) : null}
        <div className="border-t border-mist pt-4 text-center">
          <LinkButton onClick={signOut}>{text.signOut}</LinkButton>
        </div>
      </div>
    </AuthLayout>
  );
}
