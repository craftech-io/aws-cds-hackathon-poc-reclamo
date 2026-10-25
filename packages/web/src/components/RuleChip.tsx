// A rule or fence id, coloured by family: `CH-*` channel policy (docs/design-brief.md §8),
// `CED-*` Cedar statements of the Gateway, `LAM-*` Lambda fences; anything else is neutral. The id
// itself is the label, so a row of the tape reads the same on screen, in search and in exports.
import { Badge, type BadgeTone } from "./Badge";

const FAMILIES: ReadonlyArray<readonly [RegExp, BadgeTone]> = [
  [/^CH-WA-NO-COLLECTION$/, "danger"],
  [/^CH-/, "info"],
  [/^CED-/, "brand"],
  [/^LAM-/, "warning"],
];

export function ruleTone(ruleId: string): BadgeTone {
  return FAMILIES.find(([pattern]) => pattern.test(ruleId))?.[1] ?? "neutral";
}

export function RuleChip({ ruleId }: { readonly ruleId: string }) {
  return (
    <Badge tone={ruleTone(ruleId)}>
      <code className="font-mono text-xs">{ruleId}</code>
    </Badge>
  );
}
