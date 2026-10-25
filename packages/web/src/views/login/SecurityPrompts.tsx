// The recent-login step-up of the console, in place, without leaving the view: approving money,
// answering a complaint in writing and resetting a world need an interactive sign-in in the last 15
// minutes (BFF `LOGIN_NOT_RECENT`, ADR-0005). The same person signs in again (password, and the code
// when TOTP is on), which gives a fresh `auth_time`; the tokens are swapped and the old refresh
// token revoked. There is no other prompt: TOTP is enrolled only inside the sign-in (ADR-0018).
// Opened from ApiErrorNotice through the session context; mounted once by console-routes.tsx.
import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Drawer } from "../../components/Drawer";
import { useSession } from "../../context/SessionContext";
import { flowDeps } from "../../lib/auth/deps";
import { AuthFlowPanel } from "./AuthFlowPanel";
import { loginCopy } from "./copy";
import { ErrorNote, NoticeNote } from "./form-parts";
import { useAuthFlow } from "./use-auth-flow";

function StepUp({ onClose }: { readonly onClose: () => void }) {
  const { state, auth, getSession, completeSignIn } = useSession();
  const principal = state.status === "authenticated" ? state.principal : undefined;
  const [finished, setFinished] = useState(false);
  const deps = useMemo(
    () => (auth && principal?.username ? flowDeps(auth.cognito, auth.srp, { kind: "stepUp", sub: principal.sub, username: principal.username }) : undefined),
    [auth, principal?.sub, principal?.username],
  );
  const flow = useAuthFlow(deps, (done) => {
    const previous = getSession();
    if (auth && previous?.refreshToken) void auth.cognito.revoke(previous.refreshToken).catch(() => undefined);
    completeSignIn(done.tokens);
    setFinished(true);
  });

  if (finished) {
    return (
      <div className="space-y-4">
        <NoticeNote>{loginCopy.stepUp.done}</NoticeNote>
        <Button onClick={onClose}>{loginCopy.close}</Button>
      </div>
    );
  }
  if (!deps || !principal?.username) return <ErrorNote>{loginCopy.errors.UNAVAILABLE}</ErrorNote>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate">{loginCopy.stepUp.lead}</p>
      <AuthFlowPanel flow={flow} fixedUsername={principal.username} inDrawer />
    </div>
  );
}

export function SecurityPrompts() {
  const { prompt, closePrompt } = useSession();
  if (prompt !== "stepUp") return null;
  return (
    <Drawer open title={loginCopy.stepUp.title} onClose={closePrompt} closeLabel={loginCopy.close}>
      <StepUp onClose={closePrompt} />
    </Drawer>
  );
}
