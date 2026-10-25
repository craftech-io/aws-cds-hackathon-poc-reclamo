// Pieces both recovery screens share: the email field (refused before sending when it is not one)
// and the way back to the sign-in, in the screen's language.
import { LOGIN_PATH } from "../../routes";
import { useAuthLang, withLang } from "../login/auth-lang";
import { Field } from "../login/form-parts";

export function EmailField({ value, onChange, invalid }: { readonly value: string; readonly onChange: (value: string) => void; readonly invalid: boolean }) {
  const { copy } = useAuthLang();
  return (
    <Field
      label={copy.recover.email}
      type="email"
      autoComplete="email"
      autoCapitalize="off"
      spellCheck={false}
      maxLength={254}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={invalid ? copy.signup.errors.email : undefined}
      alert={invalid}
      required
    />
  );
}

export function BackToLogin() {
  const { lang, copy } = useAuthLang();
  return (
    <p className="text-center">
      <a href={withLang(LOGIN_PATH, lang)} className="inline-flex min-h-11 items-center text-sm font-medium text-seal-deep underline-offset-2 hover:underline">
        {copy.login.back}
      </a>
    </p>
  );
}
