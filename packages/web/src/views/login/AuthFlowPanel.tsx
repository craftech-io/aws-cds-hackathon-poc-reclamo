// The sign-in machine on screen: one step component per state, the error of the last step and the
// way back to the start. Used by the login page (in its language) and by the step-up drawer.
import type { ReactNode } from "react";
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import type { AuthFlowHandle } from "./use-auth-flow";
import { loginCopy } from "./copy";
import { ErrorNote, LinkButton } from "./form-parts";
import { MfaSetupStep } from "./MfaSetupStep";
import { CredentialsStep, type CredentialsText, NewPasswordStep, TotpStep } from "./steps";

interface AuthFlowPanelProps {
  readonly flow: AuthFlowHandle;
  /** Step-up: the username is the session's and cannot change. */
  readonly fixedUsername?: string;
  readonly inDrawer?: boolean;
  /** Shown above the credentials when nothing else is (e.g. "the session expired"). */
  readonly credentialsNotice?: string;
  /** The login page's language; the console's Spanish otherwise. */
  readonly credentialsText?: CredentialsText;
  readonly errorText?: Readonly<Record<AuthFlowErrorCode, string>>;
  readonly initialUsername?: string;
  readonly afterPassword?: ReactNode;
  readonly backText?: string;
}

export function AuthFlowPanel({ flow, fixedUsername, inDrawer = false, credentialsNotice, credentialsText, errorText = loginCopy.errors, initialUsername, afterPassword, backText = loginCopy.back }: AuthFlowPanelProps) {
  const { state, error, busy, dispatch } = flow;
  const common = { busy, dispatch, inDrawer };
  const restart = <LinkButton onClick={() => dispatch({ type: "restart" })}>{state.step === "totp" ? loginCopy.otherUser : backText}</LinkButton>;

  let body;
  switch (state.step) {
    case "credentials":
      body = (
        <CredentialsStep
          {...common}
          {...(fixedUsername !== undefined ? { fixedUsername } : {})}
          {...(initialUsername !== undefined ? { initialUsername } : {})}
          {...(credentialsNotice !== undefined ? { notice: credentialsNotice } : {})}
          {...(credentialsText !== undefined ? { text: credentialsText } : {})}
          afterPassword={afterPassword}
        />
      );
      break;
    case "newPassword":
      body = <NewPasswordStep {...common} />;
      break;
    case "totp":
      body = <TotpStep {...common} />;
      break;
    case "mfaSetup":
      body = <MfaSetupStep {...common} setup={state.setup} />;
      break;
    case "done":
      body = null;
      break;
  }

  return (
    <div className="space-y-4">
      {error ? <ErrorNote>{errorText[error]}</ErrorNote> : null}
      {/* The same step component can come back with a fresh state (a new challenge): re-mount it. */}
      <div key={state.step}>{body}</div>
      {state.step !== "credentials" && state.step !== "done" ? <div className="text-center">{restart}</div> : null}
    </div>
  );
}
