// The SMS code in front of the console (docs/architecture-guests.md §17, FL-129, FL-130): after the
// password, every session of every account asks `phone.status` first and, until the session passed the
// code, shows the SMS-code screen instead of the views. An automation account (exempt on the server)
// and a passed session go straight in. The BFF refuses every other procedure of a session that has not
// passed it (PHONE_VERIFICATION_REQUIRED), so a status that cannot be read lets the console try and
// the server decides; only an expired token goes back to the sign-in.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FullScreenMessage } from "../../components/FullScreenMessage";
import { useSession } from "../../context/SessionContext";
import { apiErrorOf } from "../../lib/api-error";
import { AuthLangProvider, useAuthLang } from "../login/auth-lang";
import { PhoneStatus, passed } from "./phone-model";
import { PhoneScreen } from "./PhoneScreen";

type GateState = { readonly kind: "loading" } | { readonly kind: "open" } | { readonly kind: "pending"; readonly status: Extract<PhoneStatus, { readonly state: "ENROL" | "SIGN_IN" }> };

function Loading() {
  const { copy } = useAuthLang();
  return <FullScreenMessage title={copy.common.loading} />;
}

export function PhoneGate({ children }: { readonly children: ReactNode }) {
  const { trpc, expireSession } = useSession();
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    trpc.phone.status.query().then(
      (raw) => {
        if (!live) return;
        const parsed = PhoneStatus.safeParse(raw);
        if (!parsed.success || passed(parsed.data)) setState({ kind: "open" });
        else if (parsed.data.state === "ENROL" || parsed.data.state === "SIGN_IN") setState({ kind: "pending", status: parsed.data });
      },
      (error: unknown) => {
        if (!live) return;
        if (apiErrorOf(error).kind === "unauthorized") expireSession();
        else setState({ kind: "open" });
      },
    );
    return () => {
      live = false;
    };
  }, [trpc, expireSession, nonce]);

  const recheck = useCallback(() => {
    setState({ kind: "loading" });
    setNonce((value) => value + 1);
  }, []);

  if (state.kind === "open") return <>{children}</>;
  return <AuthLangProvider>{state.kind === "loading" ? <Loading /> : <PhoneScreen status={state.status} onPassed={recheck} />}</AuthLangProvider>;
}
