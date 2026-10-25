// The fields of `/signup` (docs/landing-spec.md §9.2): email and password (required), name, company
// and role (optional, never more than three), the two consents, separate and unticked, the first
// required and the second optional, with the BFF's versioned texts, and the fixed line about the
// synthetic data. Errors sit under their field; the first one after a submit is announced.
import { useId, type FormEvent, type ReactNode } from "react";
import { FIELD_CLASS } from "../../components/form-classes";
import type { AuthCopy } from "../login/auth-copy";
import { consentParts } from "../login/auth-copy";
import { Field, FieldError, PasswordField, PasswordRules, SubmitButton } from "../login/form-parts";
import { type FieldErrors, LEAD_TEXT_MAX, type SignupField, type SignupForm, firstErrorField } from "./signup-model";

interface SignupFormProps {
  readonly copy: AuthCopy;
  readonly form: SignupForm;
  readonly errors: FieldErrors;
  /** Errors come from a submit: the first one is announced. */
  readonly announced: boolean;
  readonly busy: boolean;
  onChange(next: SignupForm): void;
  onSubmit(): void;
}

const LEGAL_LINK = "font-semibold text-seal-deep underline underline-offset-2";

function Consent({ id, checked, onChange, error, alert, children }: { readonly id: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly error?: string | undefined; readonly alert?: boolean; readonly children: ReactNode }) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 accent-pine"
        />
        <label htmlFor={id} className="text-sm text-ink">
          {children}
        </label>
      </div>
      <FieldError id={errorId} text={error} alert={alert ?? false} />
    </div>
  );
}

export function SignupFormFields({ copy, form, errors, announced, busy, onChange, onSubmit }: SignupFormProps) {
  const ids = { role: useId(), terms: useId(), contact: useId() };
  const first = announced ? firstErrorField(errors) : undefined;
  const text = copy.signup;
  const errorOf = (field: SignupField) => {
    const key = errors[field];
    return key === undefined ? undefined : text.errors[key];
  };
  const set = <K extends keyof SignupForm>(key: K, value: SignupForm[K]) => onChange({ ...form, [key]: value });
  const [termsBefore, termsMiddle, termsAfter] = consentParts(text.consentTerms);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <Field label={text.email} type="email" autoComplete="email" autoCapitalize="off" spellCheck={false} maxLength={254} value={form.email} onChange={(event) => set("email", event.target.value)} error={errorOf("email")} alert={first === "email"} required />
      <PasswordField label={text.password} toggle={copy.password} autoComplete="new-password" value={form.password} onChange={(event) => set("password", event.target.value)} error={errorOf("password")} alert={first === "password"} required />
      <PasswordRules password={form.password} text={copy.password} />
      <Field label={text.name} type="text" autoComplete="name" maxLength={LEAD_TEXT_MAX} value={form.name} onChange={(event) => set("name", event.target.value)} error={errorOf("name")} alert={first === "name"} />
      <Field label={text.company} type="text" autoComplete="organization" maxLength={LEAD_TEXT_MAX} value={form.company} onChange={(event) => set("company", event.target.value)} error={errorOf("company")} alert={first === "company"} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.role} className="text-sm font-medium text-ink">
          {text.role}
        </label>
        <select id={ids.role} className={`${FIELD_CLASS} min-h-11 w-full`} value={form.jobTitle} onChange={(event) => set("jobTitle", event.target.value)}>
          <option value="">{text.rolePlaceholder}</option>
          {text.roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </div>
      <Consent id={ids.terms} checked={form.acceptTerms} onChange={(checked) => set("acceptTerms", checked)} error={errorOf("acceptTerms")} alert={first === "acceptTerms"}>
        {termsBefore}
        <a className={LEGAL_LINK} href="/legal/terms.html" target="_blank" rel="noopener">
          {text.termsLink}
        </a>
        {termsMiddle}
        <a className={LEGAL_LINK} href="/legal/privacy.html" target="_blank" rel="noopener">
          {text.privacyLink}
        </a>
        {termsAfter}
      </Consent>
      <Consent id={ids.contact} checked={form.acceptContact} onChange={(checked) => set("acceptContact", checked)}>
        {text.consentContact}
      </Consent>
      <SubmitButton busy={busy} working={copy.common.working}>
        {text.submit}
      </SubmitButton>
      <p className="text-xs text-slate">{text.synthetic}</p>
    </form>
  );
}
