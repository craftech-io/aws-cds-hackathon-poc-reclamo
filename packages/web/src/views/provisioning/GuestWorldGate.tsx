// The world of a signed-in GUEST in front of the console (docs/landing-spec.md §9.4-§9.5, FL-117,
// FL-120, FL-121, FL-124, FL-125). A self-signup guest's world is prepared on demand, so the console
// asks `guest.status` first and, until the world is `READY`, shows the fixed provisioning screen
// instead of the views (whose procedures answer WORLD_NOT_READY); an expired world gets "Set up my
// environment" (`guest.requestWorld`). The status is asked again every 5 s while waiting and every
// minute once open, which also catches an expiry while the session is open and keeps the day's usage
// fresh for "you've reached today's usage limit". An invited guest (`gNN`) is never held: its world
// is ready before its credentials exist; it only gets the usage notice.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Callout } from "../../components/Callout";
import { FullScreenMessage } from "../../components/FullScreenMessage";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { apiErrorOf } from "../../lib/api-error";
import { AUTH_COPY } from "../login/auth-copy";
import { AuthLangProvider, useAuthLang } from "../login/auth-lang";
import { GuestStatus, IDLE_WAIT, RequestWorldResult, type WaitClock, isSlow, nextWait, phaseOf, pollDelay } from "./provisioning-model";
import { ProvisioningScreen } from "./ProvisioningScreen";

const GuestStatusContext = createContext<GuestStatus | undefined>(undefined);

/** "Llegaste al límite de uso de hoy…": the console's Spanish with its English gloss. */
export function GuestUsageNotice() {
  const status = useContext(GuestStatusContext);
  if (!status?.usage?.limitReached) return null;
  return (
    <div className="mb-4">
      <Callout tone="warning">{`${AUTH_COPY.es.provisioning.usageLimit} · ${AUTH_COPY.en.provisioning.usageLimit}`}</Callout>
    </div>
  );
}

function useGuestStatus(): { readonly status: GuestStatus | undefined; readonly wait: WaitClock; refresh(): void } {
  const { trpc, expireSession } = useSession();
  const [status, setStatus] = useState<GuestStatus | undefined>(undefined);
  const [wait, setWait] = useState<WaitClock>(IDLE_WAIT);
  const [nonce, setNonce] = useState(0);
  const latest = useRef<GuestStatus | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const parsed = GuestStatus.safeParse(await trpc.guest.status.query());
        if (stopped) return;
        if (parsed.success) {
          latest.current = parsed.data;
          setStatus(parsed.data);
          setWait((clock) => nextWait(clock, phaseOf(parsed.data), Date.now()));
        }
      } catch (error) {
        if (stopped) return;
        if (apiErrorOf(error).kind === "unauthorized") {
          expireSession();
          return;
        }
        // Anything else (the network, a deploy in progress) waits for the next round.
      }
      timer = window.setTimeout(() => void poll(), pollDelay(latest.current));
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [trpc, expireSession, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { status, wait, refresh };
}

function NotReady({ status, wait, refresh }: { readonly status: GuestStatus; readonly wait: WaitClock; refresh(): void }) {
  const { trpc, signOut } = useSession();
  const [requesting, setRequesting] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const phase = phaseOf(status);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const requestWorld = async (): Promise<void> => {
    if (requesting) return;
    setRequesting(true);
    setRateLimited(false);
    try {
      const answer = RequestWorldResult.safeParse(await trpc.guest.requestWorld.mutate());
      if (answer.success && answer.data.status === "RATE_LIMITED") setRateLimited(true);
      else refresh();
    } catch {
      refresh();
    } finally {
      setRequesting(false);
    }
  };

  if (phase.kind === "ready") return null;
  return <ProvisioningScreen phase={phase} slow={isSlow(wait, now)} requesting={requesting} rateLimited={rateLimited} onRequestWorld={() => void requestWorld()} onSignOut={signOut} />;
}

function Loading() {
  const { copy } = useAuthLang();
  return <FullScreenMessage title={copy.common.loading} />;
}

function Watched({ hold, children }: { readonly hold: boolean; readonly children: ReactNode }) {
  const { status, wait, refresh } = useGuestStatus();
  if (hold && status === undefined) return <Loading />;
  if (hold && status !== undefined && phaseOf(status).kind !== "ready") {
    return (
      <AuthLangProvider>
        <NotReady status={status} wait={wait} refresh={refresh} />
      </AuthLangProvider>
    );
  }
  return <GuestStatusContext.Provider value={status}>{children}</GuestStatusContext.Provider>;
}

/** Wraps the console: holds a self-signup guest until its world is `READY`; watches every guest's usage. */
export function GuestWorldGate({ children }: { readonly children: ReactNode }) {
  const principal = usePrincipal();
  if (principal.role !== "GUEST") return <>{children}</>;
  return <Watched hold={principal.selfSignup === true}>{children}</Watched>;
}
