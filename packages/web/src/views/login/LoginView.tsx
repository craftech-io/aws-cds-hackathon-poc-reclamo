// `/login`: the console's own sign-in, "Reclamo en regla · Powered by Craftech", against the Cognito
// pool (USER_SRP_AUTH and its challenges, lib/auth/flow.ts), in Spanish or English (docs/landing-spec.md
// §9.5). Staff sign in with their username, a self-signup guest with the email. Under the password,
// "Forgot your password?"; under the button, "Try Reclamo en regla", ALWAYS shown (showing it by who
// typed what would tell staff accounts apart). Both are full page loads, so the edge firewall can
// challenge the document. After a confirmed sign-up or a password reset the email comes pre-filled
// with its notice. A finished sign-in stores the tokens in the session and lands on `returnTo`.
import { useMemo, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { flowDeps } from "../../lib/auth/deps";
import { forgetAccessHandoff, loginEmailHint } from "../../lib/auth/handoff";
import { safeReturnTo } from "../../lib/auth/tokens";
import { Redirect, useRouter } from "../../lib/router";
import { CONSOLE_HOME, LOGIN_NOTICE, LOGIN_PATH, RECOVER_PATH, SIGNUP_PATH } from "../../routes";
import { AuthFlowPanel } from "./AuthFlowPanel";
import { AuthLayout } from "./AuthLayout";
import { AuthLangProvider, useAuthLang, withLang } from "./auth-lang";
import type { CredentialsText } from "./steps";
import { useAuthFlow } from "./use-auth-flow";

function Unconfigured({ missing }: { readonly missing: readonly string[] }) {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold text-pine">{consoleCopy.login.unconfiguredTitle}</h1>
      <p className="text-sm text-slate">{consoleCopy.login.unconfiguredLead}</p>
      <ul className="list-disc pl-5 font-mono text-xs text-danger">
        {missing.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </div>
  );
}

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-seal-deep underline-offset-2 hover:underline";

function LoginScreen() {
  const { state, auth, completeSignIn } = useSession();
  const { search } = useRouter();
  const { lang, copy } = useAuthLang();
  const returnTo = safeReturnTo(search.get("returnTo"), LOGIN_PATH, CONSOLE_HOME);
  const deps = useMemo(() => (auth ? flowDeps(auth.cognito, auth.srp, { kind: "signIn" }) : undefined), [auth]);
  const flow = useAuthFlow(deps, (done) => {
    forgetAccessHandoff();
    completeSignIn(done.tokens);
  });
  const notice = search.get(LOGIN_NOTICE.param);
  const [emailHint] = useState(() => (notice === LOGIN_NOTICE.confirmed || notice === LOGIN_NOTICE.passwordChanged ? loginEmailHint() : undefined));

  if (state.status === "authenticated") return <Redirect to={returnTo} />;

  const text: CredentialsText = { ...copy.login, working: copy.common.working, show: copy.password.show, hide: copy.password.hide };
  let message: string | undefined;
  if (state.status === "anonymous" && state.reason === "expired") message = copy.login.sessionExpired;
  else if (notice === LOGIN_NOTICE.confirmed) message = copy.login.confirmed;
  else if (notice === LOGIN_NOTICE.passwordChanged) message = copy.login.passwordChanged;

  let content;
  if (state.status === "unconfigured") content = <Unconfigured missing={state.missing} />;
  else if (state.status === "loading") content = <p className="text-sm text-slate">{copy.common.loading}</p>;
  else {
    content = (
      <AuthFlowPanel
        flow={flow}
        credentialsText={text}
        errorText={copy.errors}
        backText={copy.login.back}
        {...(message !== undefined ? { credentialsNotice: message } : {})}
        {...(emailHint !== undefined ? { initialUsername: emailHint } : {})}
        afterPassword={
          <p className="-mt-2 text-right">
            <a href={withLang(RECOVER_PATH, lang)} className={LINK}>
              {copy.login.forgot}
            </a>
          </p>
        }
      />
    );
  }

  return (
    <AuthLayout>
      {content}
      <p className="mt-6 border-t border-mist pt-4 text-center text-sm text-slate">
        {copy.login.noAccount}{" "}
        <a href={withLang(SIGNUP_PATH, lang)} className={LINK} data-cta="try">
          {copy.login.tryIt}
        </a>
      </p>
    </AuthLayout>
  );
}

export function LoginView() {
  return (
    <AuthLangProvider>
      <LoginScreen />
    </AuthLangProvider>
  );
}
