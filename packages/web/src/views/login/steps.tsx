// One component per state of the sign-in machine. They hold what the person types (in memory,
// cleared when the step changes) and hand it to `dispatch`; the machine decides what comes next.
import { useState, type FormEvent, type ReactNode } from "react";
import { hasOuterSpaces, looksLikeUsername, missingPasswordRules } from "../../lib/auth/credentials";
import type { AuthFlowAction } from "../../lib/auth/flow";
import { loginCopy } from "./copy";
import { CodeField, Field, NoticeNote, PasswordField, PasswordRules, StepHeading, SubmitButton } from "./form-parts";

export interface StepProps {
  readonly busy: boolean;
  readonly dispatch: (action: AuthFlowAction) => void;
  readonly inDrawer?: boolean;
}

function submit(handler: () => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handler();
  };
}

/** What the credentials step says: the console's Spanish, or the login page's language. */
export interface CredentialsText {
  readonly title: string;
  readonly lead: string;
  readonly username: string;
  readonly password: string;
  readonly submit: string;
  readonly working: string;
  readonly show: string;
  readonly hide: string;
}

const CONSOLE_CREDENTIALS: CredentialsText = { ...loginCopy.credentials, working: loginCopy.working, show: loginCopy.password.show, hide: loginCopy.password.hide };

interface CredentialsStepProps extends StepProps {
  /** Step-up: the username is the session's and cannot change. */
  readonly fixedUsername?: string;
  /** Pre-filled (an account just confirmed or reset): read-only until the person touches it. */
  readonly initialUsername?: string;
  readonly notice?: string;
  readonly text?: CredentialsText;
  /** Under the password field (the login page's "Forgot your password?"). */
  readonly afterPassword?: ReactNode;
}

export function CredentialsStep({ busy, dispatch, inDrawer, fixedUsername, initialUsername, notice, text = CONSOLE_CREDENTIALS, afterPassword }: CredentialsStepProps) {
  const [username, setUsername] = useState(fixedUsername ?? initialUsername ?? "");
  const [locked, setLocked] = useState(fixedUsername !== undefined || initialUsername !== undefined);
  const [password, setPassword] = useState("");
  const onSubmit = submit(() => {
    if (!looksLikeUsername(username) || !password) return;
    dispatch({ type: "signIn", username, password });
    setPassword("");
  });
  const unlock = fixedUsername === undefined ? () => setLocked(false) : undefined;
  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate={false}>
      {inDrawer ? null : <StepHeading title={text.title} lead={text.lead} />}
      {notice ? <NoticeNote>{notice}</NoticeNote> : null}
      <Field
        label={text.username}
        type="text"
        autoComplete="username"
        autoCapitalize="off"
        spellCheck={false}
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        readOnly={locked}
        onClick={unlock}
        onKeyDown={unlock}
        required
      />
      <PasswordField label={text.password} toggle={text} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      {afterPassword}
      <SubmitButton busy={busy} working={text.working}>
        {text.submit}
      </SubmitButton>
    </form>
  );
}

/** New password + confirmation, checked against the pool's policy before anything is sent. */
function useNewPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = missingPasswordRules(password).length === 0 && !hasOuterSpaces(password) && password === confirm;
  const reset = () => {
    setPassword("");
    setConfirm("");
  };
  const fields = (label: string) => (
    <>
      <PasswordField label={label} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <PasswordRules password={password} />
      <PasswordField label={loginCopy.password.confirm} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
      {mismatch ? <p className="text-xs text-danger">{loginCopy.password.mismatch}</p> : null}
      {hasOuterSpaces(password) ? <p className="text-xs text-danger">{loginCopy.password.outerSpaces}</p> : null}
    </>
  );
  return { password, valid, reset, fields };
}

export function NewPasswordStep({ busy, dispatch, inDrawer }: StepProps) {
  const form = useNewPassword();
  const onSubmit = submit(() => {
    if (!form.valid) return;
    dispatch({ type: "newPassword", password: form.password });
    form.reset();
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={loginCopy.newPassword.title} lead={loginCopy.newPassword.lead} inDrawer={inDrawer} />
      {form.fields(loginCopy.newPassword.field)}
      <SubmitButton busy={busy}>{loginCopy.newPassword.submit}</SubmitButton>
    </form>
  );
}

export function TotpStep({ busy, dispatch, inDrawer }: StepProps) {
  const [code, setCode] = useState("");
  const onSubmit = submit(() => {
    dispatch({ type: "totp", code });
    setCode("");
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={loginCopy.totp.title} lead={loginCopy.totp.lead} inDrawer={inDrawer} />
      <CodeField label={loginCopy.totp.code} value={code} onChange={setCode} />
      <SubmitButton busy={busy}>{loginCopy.totp.submit}</SubmitButton>
    </form>
  );
}
