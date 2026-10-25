import type { ReactNode } from "react";
import { ReclamoWordmark, PoweredByCraftech } from "./brand/Brand";

interface FullScreenMessageProps {
  readonly title: string;
  readonly lead?: string;
  readonly children?: ReactNode;
}

/** Centered card used outside the shell: loading, errors, no access. Branded like the login. */
export function FullScreenMessage({ title, lead, children }: FullScreenMessageProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-pine px-4 py-10">
      <ReclamoWordmark tone="dark" size="lg" />
      <div className="w-full max-w-md rounded-card bg-white p-8 shadow-card">
        <h1 className="text-2xl font-semibold text-pine">{title}</h1>
        {lead ? <p className="mt-2 text-sm text-slate">{lead}</p> : null}
        {children ? <div className="mt-6">{children}</div> : null}
      </div>
      <PoweredByCraftech tone="dark" />
    </main>
  );
}
