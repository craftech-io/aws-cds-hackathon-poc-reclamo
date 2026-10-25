// Top-level routing and session guard. The landing (`/`) and the access screens (login, sign-up,
// provisioning wait, recovery: views/login/access-views.tsx) render for anyone; every other path
// needs an authenticated principal, and the console itself loads lazily (console-routes.tsx) so a
// visitor of the landing never downloads it.
import { Suspense, lazy } from "react";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { useSession } from "./context/SessionContext";
import { copy } from "./copy/console";
import { Redirect, useRouter } from "./lib/router";
import { LANDING_PATH, LOGIN_PATH } from "./routes";
import { LandingView } from "./views/landing/LandingView";
import { accessViewOf } from "./views/login/access-views";

const ConsoleRoutes = lazy(() => import("./console-routes"));

export function App() {
  const { path } = useRouter();
  const { state } = useSession();

  if (path === LANDING_PATH) return <LandingView />;
  const AccessView = accessViewOf(path);
  if (AccessView) return <AccessView />;
  if (state.status === "loading") return <FullScreenMessage title={copy.app.loading} />;
  if (state.status !== "authenticated") return <Redirect to={`${LOGIN_PATH}?returnTo=${encodeURIComponent(path)}`} />;

  return (
    <Suspense fallback={<FullScreenMessage title={copy.app.loading} />}>
      <ConsoleRoutes />
    </Suspense>
  );
}
