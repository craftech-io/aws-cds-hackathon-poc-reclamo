// `/signup/provisioning` (docs/landing-spec.md §9.3-§9.4): where a confirmed sign-up lands, already
// signed in by the silent sign-in. The guest's world gate shows the wait and, at `READY`, lets the
// console open on its inbox by itself (no "continue" button: there is nothing to confirm). Without a
// session (a reload of a tab that never signed in, a link opened elsewhere) it goes to `/login` with
// the "your account is confirmed" notice, never to a raw error.
import { FullScreenMessage } from "../../components/FullScreenMessage";
import { useSession } from "../../context/SessionContext";
import { Redirect } from "../../lib/router";
import { CONSOLE_HOME, LOGIN_NOTICE, LOGIN_PATH } from "../../routes";
import { useAuthLang, withLang } from "../login/auth-lang";
import { GuestWorldGate } from "./GuestWorldGate";

export function ProvisioningRoute() {
  const { state } = useSession();
  const { lang, copy } = useAuthLang();
  if (state.status === "loading") return <FullScreenMessage title={copy.common.loading} />;
  if (state.status !== "authenticated") return <Redirect to={withLang(`${LOGIN_PATH}?${LOGIN_NOTICE.param}=${LOGIN_NOTICE.confirmed}`, lang)} />;
  return (
    <GuestWorldGate>
      <Redirect to={CONSOLE_HOME} />
    </GuestWorldGate>
  );
}
