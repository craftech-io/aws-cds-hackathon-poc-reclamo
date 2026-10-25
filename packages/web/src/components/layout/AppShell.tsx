// Frame of every authenticated view: sidebar navigation built from the route table and filtered
// by role (below `md`, the same list behind a menu button in a drawer), top bar with the principal and its world, and the "Reclamo en regla · Powered by
// Craftech" brand, the simulated-time bar (ShellClock over ClockBanner) and the guided-tour panel
// (docs/design-brief.md §9).
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { copy, PRODUCT_NAME } from "../../copy/console";
import { ReclamoWordmark, PoweredByCraftech } from "../brand/Brand";
import { Link, useRouter } from "../../lib/router";
import { ROUTES, routeAllows, routeTitle, type ConsoleRoute, type NavGroup } from "../../routes";
import { Button } from "../Button";
import { Drawer } from "../Drawer";
import { ShellClock } from "./ShellClock";
import { TourPanel } from "./TourPanel";

const GROUP_ORDER: readonly NavGroup[] = ["complaints", "compliance", "demo"];

/** The world line of the header: the technical id is for the staff and invited guests, never a self-signup's. */
function worldText(principal: { readonly worldId?: string | undefined; readonly selfSignup?: boolean | undefined }): string {
  return principal.selfSignup === true ? copy.app.ownWorld : `${copy.app.worldLabel}: ${principal.worldId ?? "—"}`;
}

function isActive(route: ConsoleRoute, path: string): boolean {
  return path === route.path || path.startsWith(`${route.path}/`);
}

const LINK_TONE = {
  dark: { active: "bg-pine-soft text-white", idle: "text-mist hover:bg-pine-soft/60 hover:text-white" },
  light: { active: "bg-pine text-white", idle: "text-ink hover:bg-paper" },
} as const;

interface NavSectionProps {
  readonly group: NavGroup;
  readonly routes: readonly ConsoleRoute[];
  readonly path: string;
  readonly tone: keyof typeof LINK_TONE;
}

function NavSection({ group, routes, path, tone }: NavSectionProps) {
  if (routes.length === 0) return null;
  return (
    <div>
      <p className="px-3 text-xs font-semibold uppercase tracking-widest text-slate">{copy.nav.groups[group]}</p>
      <ul className="mt-2 space-y-0.5">
        {routes.map((route) => {
          const active = isActive(route, path);
          return (
            <li key={route.id}>
              <Link
                to={route.path}
                aria-current={active ? "page" : undefined}
                className={`block rounded-md px-3 py-2 text-sm font-medium transition-colors ${active ? LINK_TONE[tone].active : LINK_TONE[tone].idle}`}
              >
                {routeTitle(route)}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NavGroups({ routes, path, tone }: { readonly routes: readonly ConsoleRoute[]; readonly path: string; readonly tone: keyof typeof LINK_TONE }) {
  return (
    <>
      {GROUP_ORDER.map((group) => (
        <NavSection key={group} group={group} routes={routes.filter((route) => route.group === group)} path={path} tone={tone} />
      ))}
    </>
  );
}

/** The console's menu below `md`: the same routes as the sidebar, in a drawer. */
function MobileMenu({ routes, path }: { readonly routes: readonly ConsoleRoute[]; readonly path: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // A new path (the back button included) closes the menu.
  useEffect(close, [path, close]);
  return (
    <div className="md:hidden">
      <Button variant="secondary" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {copy.nav.menu}
      </Button>
      <Drawer open={open} title={copy.nav.menuTitle} closeLabel={copy.nav.close} onClose={close}>
        {/* Following a link closes the menu, the current view's own included. */}
        <nav aria-label={PRODUCT_NAME} className="space-y-6" onClickCapture={(event) => (event.target instanceof Element && event.target.closest("a") ? close() : undefined)}>
          <NavGroups routes={routes} path={path} tone="light" />
        </nav>
      </Drawer>
    </div>
  );
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const { path } = useRouter();
  const { signOut } = useSession();
  const principal = usePrincipal();
  const visible = ROUTES.filter((route) => route.nav && routeAllows(route, principal.role));

  return (
    <div className="flex min-h-screen">
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2">
        {copy.app.skipToContent}
      </a>
      <nav aria-label={PRODUCT_NAME} className="hidden w-60 shrink-0 flex-col bg-pine px-3 py-5 md:flex">
        <div className="space-y-2 px-3">
          <p>
            <ReclamoWordmark tone="dark" size="lg" />
          </p>
          <p className="text-xs text-seal-soft">{copy.app.tagline}</p>
        </div>
        <div className="mt-8 flex-1 space-y-6">
          <NavGroups routes={visible} path={path} tone="dark" />
        </div>
        <div className="mt-8 space-y-3 border-t border-pine-soft px-3 pt-4">
          <p className="text-xs text-mist">{copy.app.syntheticData}</p>
          <PoweredByCraftech tone="dark" />
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-mist bg-white px-6 py-3">
          <div className="flex shrink-0 items-center gap-2 md:hidden">
            <MobileMenu routes={visible} path={path} />
            <ReclamoWordmark tone="light" size="sm" />
          </div>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <div className="text-right">
              <p className="font-medium text-ink">{principal.username ?? principal.sub}</p>
              <p className="text-xs text-slate">
                {copy.app.roleLabel}: {principal.role ? copy.roles[principal.role] : "—"} · {worldText(principal)}
              </p>
            </div>
            <Button variant="secondary" onClick={signOut}>
              {copy.app.signOut}
            </Button>
          </div>
        </header>
        {principal.role ? <ShellClock role={principal.role} /> : null}
        <TourPanel />
        <main id="content" className="flex-1 px-6 py-6">
          {children}
        </main>
        <footer className="flex justify-center border-t border-mist px-6 py-3 md:hidden">
          <PoweredByCraftech tone="light" />
        </footer>
      </div>
    </div>
  );
}
