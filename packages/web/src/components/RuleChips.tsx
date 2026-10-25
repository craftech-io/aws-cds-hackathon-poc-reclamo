// Rule and fence ids as the tape, the case timeline and the metrics list them.
import { Fragment } from "react";
import { RuleChip } from "./RuleChip";

export function RuleChips({ ids, empty }: { readonly ids: readonly string[]; readonly empty?: string }) {
  if (ids.length === 0) return empty ? <span className="text-xs text-slate">{empty}</span> : null;
  // The spaces keep each id a separate word in the text of the row (search, copy, exports).
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Fragment key={id}>
          {" "}
          <RuleChip ruleId={id} />{" "}
        </Fragment>
      ))}
    </span>
  );
}
