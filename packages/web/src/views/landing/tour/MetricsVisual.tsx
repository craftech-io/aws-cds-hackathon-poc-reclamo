// Step 7 of the tour: the console's `StatTile`s with the design's targets of the impact section, each
// labelled "meta" (target) and with its source: never a figure presented as measured.
import { StatTile } from "../../../components/StatTile";
import { useLandingCopy } from "../lang";
import { GOAL_KEYS, goalText } from "../goals";

export function MetricsVisual() {
  const { impact, visuals } = useLandingCopy();
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {GOAL_KEYS.map((key) => (
        <StatTile key={key} label={impact.goals[key].label} value={goalText(impact.goals[key])} hint={`${impact.target} · ${visuals.metricsSource}`} tone={key === "violations" ? "success" : "neutral"} />
      ))}
    </div>
  );
}
