// Stand-in for the views later work packages build (docs/build-plan.md, waves 4 and 5): the title
// and description of the route, so the shell, the navigation and the role guards can be tested end
// to end before the data exists. Each views/<view>/View.tsx renders it until its WP replaces it.
import { copy } from "../copy/console";
import type { RouteId } from "../routes";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";

export function ViewPlaceholder({ id }: { readonly id: RouteId }) {
  const view = copy.views[id];
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <EmptyState title={copy.placeholder.title} lead={copy.placeholder.lead} />
    </div>
  );
}
