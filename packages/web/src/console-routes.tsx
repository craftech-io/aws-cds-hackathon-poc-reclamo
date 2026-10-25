// The authenticated console: the view of the route inside the shell, with the no-access,
// not-found and forbidden screens. A guest's world goes through its gate first
// (views/provisioning/GuestWorldGate.tsx): a self-signup world not yet `READY` shows the provisioning
// screen instead of the views, and every guest gets the day's usage notice. Loaded lazily by app.tsx,
// so the landing and the login do not download the views.
import type { ComponentType } from "react";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { AppShell } from "./components/layout/AppShell";
import { WorldResetScreen } from "./components/layout/WorldResetScreen";
import { usePrincipal, useSession } from "./context/SessionContext";
import { copy } from "./copy/console";
import { Link, useRouter } from "./lib/router";
import { routeOf } from "./route-match";
import { CONSOLE_HOME, routeAllows, type RouteId } from "./routes";
import { ApprovalsView } from "./views/approvals/View";
import { ClockView } from "./views/clock/View";
import { ComplaintView } from "./views/complaint/View";
import { CustomerView } from "./views/customer/View";
import { EmailsView } from "./views/emails/View";
import { InboxView } from "./views/inbox/View";
import { SecurityPrompts } from "./views/login/SecurityPrompts";
import { MetricsView } from "./views/metrics/View";
import { PolicyView } from "./views/policy/View";
import { GuestUsageNotice, GuestWorldGate } from "./views/provisioning/GuestWorldGate";
import { RegisterView } from "./views/register/View";
import { SimulatorView } from "./views/simulator/View";
import { TapeView } from "./views/tape/View";
import { TourView } from "./views/tour/View";

const VIEWS: Readonly<Record<RouteId, ComponentType>> = {
  inbox: InboxView,
  complaint: ComplaintView,
  customer: CustomerView,
  approvals: ApprovalsView,
  tape: TapeView,
  register: RegisterView,
  emails: EmailsView,
  policy: PolicyView,
  metrics: MetricsView,
  simulator: SimulatorView,
  clock: ClockView,
  tour: TourView,
};

function BackHome() {
  return (
    <Link to={CONSOLE_HOME} className="text-sm font-semibold text-seal-deep underline">
      {copy.errors.backHome}
    </Link>
  );
}

function NoAccess({ onSignOut }: { readonly onSignOut: () => void }) {
  return (
    <FullScreenMessage title={copy.login.noAccessTitle} lead={copy.login.noAccessLead}>
      <button type="button" className="text-sm font-semibold text-seal-deep underline" onClick={onSignOut}>
        {copy.app.signOut}
      </button>
    </FullScreenMessage>
  );
}

function RouteView() {
  const { path } = useRouter();
  const { worldResetting } = useSession();
  const principal = usePrincipal();
  if (worldResetting) return <WorldResetScreen />;

  const route = routeOf(path);
  if (!route) {
    return (
      <FullScreenMessage title={copy.errors.notFoundTitle} lead={copy.errors.notFoundLead}>
        <BackHome />
      </FullScreenMessage>
    );
  }
  if (!routeAllows(route, principal.role)) {
    return (
      <FullScreenMessage title={copy.errors.forbiddenTitle} lead={copy.errors.forbiddenLead}>
        <BackHome />
      </FullScreenMessage>
    );
  }

  const View = VIEWS[route.id];
  return (
    <>
      <AppShell>
        <GuestUsageNotice />
        <View />
      </AppShell>
      <SecurityPrompts />
    </>
  );
}

export default function ConsoleRoutes() {
  const { signOut } = useSession();
  const principal = usePrincipal();
  if (!principal.worldId || !principal.role) return <NoAccess onSignOut={signOut} />;
  return (
    <GuestWorldGate>
      <RouteView />
    </GuestWorldGate>
  );
}
