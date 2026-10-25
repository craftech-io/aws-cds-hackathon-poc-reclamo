import type { ReactNode } from "react";

interface EmptyStateProps {
  readonly title: string;
  readonly lead?: string;
  readonly action?: ReactNode;
}

export function EmptyState({ title, lead, action }: EmptyStateProps) {
  return (
    <div className="rounded-card border border-dashed border-mist bg-white px-6 py-10 text-center">
      <p className="text-base font-semibold text-pine">{title}</p>
      {lead ? <p className="mt-2 text-sm text-slate">{lead}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
