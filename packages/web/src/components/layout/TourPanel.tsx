// The guided-tour panel of the shell (docs/design-brief.md §9 and §15): "Tu recorrido: ~X min"
// and a link to the full tour, from `tour.steps`. Nothing is offered while the tour cannot answer
// (a world being reset answers `WORLD_RESETTING` and the reset screen takes over).
import { useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { Link } from "../../lib/router";
import { dataOf, useRemote } from "../../lib/use-remote";
import { TourSteps } from "../../lib/world-clock";
import { ROUTES } from "../../routes";

const TOUR_PATH = ROUTES.find((route) => route.id === "tour")?.path;

export function TourPanel() {
  const { trpc } = useSession();
  const remote = useRemote<unknown>("tour.steps", (signal) => trpc.tour.steps.query(undefined, { signal }));
  const parsed = TourSteps.safeParse(dataOf(remote.state));
  if (!parsed.success || !TOUR_PATH) return null;
  return (
    <aside aria-label={copy.shell.tourTitle} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-mist bg-paper px-6 py-2 text-sm">
      <span className="font-semibold text-pine">{copy.shell.tourTitle}</span>
      <span className="text-slate">{copy.shell.tourEstimate(Math.ceil(parsed.data.totalMinutes))}</span>
      <Link to={TOUR_PATH} className="ml-auto font-semibold text-seal-deep underline">
        {copy.shell.tourOpen}
      </Link>
    </aside>
  );
}
