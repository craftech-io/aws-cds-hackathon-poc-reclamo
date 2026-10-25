// History-based router of the console: Context + useState, no routing library. Routes are
// declared in src/routes.ts and matched in app.tsx; this file only tracks the location.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";

export { matchPath } from "./match-path";

export interface RouterLocation {
  readonly path: string;
  readonly search: URLSearchParams;
}

export interface NavigateOptions {
  readonly replace?: boolean;
}

export interface RouterValue extends RouterLocation {
  navigate(to: string, options?: NavigateOptions): void;
}

const RouterContext = createContext<RouterValue | undefined>(undefined);

function readLocation(): RouterLocation {
  return { path: window.location.pathname, search: new URLSearchParams(window.location.search) };
}

export function RouterProvider({ children }: { readonly children: ReactNode }) {
  const [location, setLocation] = useState<RouterLocation>(readLocation);

  useEffect(() => {
    const onPopState = () => setLocation(readLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((to: string, options?: NavigateOptions) => {
    if (options?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setLocation(readLocation());
  }, []);

  const value = useMemo<RouterValue>(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter must be used inside RouterProvider");
  return value;
}

/** Declarative redirect: navigates on mount, renders nothing. */
export function Redirect({ to, replace = true }: { readonly to: string; readonly replace?: boolean }) {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, { replace }), [navigate, to, replace]);
  return null;
}

interface LinkProps {
  readonly to: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly "aria-current"?: "page";
  readonly replace?: boolean;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function Link({ to, className, children, replace, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    navigate(to, replace === undefined ? undefined : { replace });
  };
  return (
    <a href={to} className={className} onClick={onClick} aria-current={rest["aria-current"]}>
      {children}
    </a>
  );
}
