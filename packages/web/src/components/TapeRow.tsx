// One decision of the compliance tape (docs/design-brief.md §8): who tried to send what on which
// channel, what the channel policy decided and under which rules. Blocked attempts are red, whoever
// the sender was: the agent says no to its own operator too.
import type { Channel, TapeEntryKind } from "@reclamo/shared";
import { Badge, type BadgeTone } from "./Badge";
import { RuleChips } from "./RuleChips";

export interface TapeRowEntry {
  readonly decision: TapeEntryKind;
  readonly sender: string;
  readonly channel: Channel;
  readonly kind: string;
  readonly ruleIds: readonly string[];
  /** Simulated time of the decision, already formatted for es-AR. */
  readonly atText: string;
}

export const TAPE_DECISION_TONE: Readonly<Record<TapeEntryKind, BadgeTone>> = { ALLOWED: "success", BLOCKED: "danger", REROUTED: "warning", DEFERRED: "info", DISPATCH: "neutral" };

export const DECISION_LABEL: Readonly<Record<TapeEntryKind, string>> = {
  ALLOWED: "Permitido",
  BLOCKED: "BLOQUEADO",
  REROUTED: "Reencaminado",
  DEFERRED: "Diferido",
  DISPATCH: "Envío",
};

export function TapeRow({ entry }: { readonly entry: TapeRowEntry }) {
  return (
    <tr className={entry.decision === "BLOCKED" ? "bg-danger-soft" : undefined}>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate">{entry.atText}</td>
      <td className="px-3 py-2">
        <Badge tone={TAPE_DECISION_TONE[entry.decision]}>{DECISION_LABEL[entry.decision]}</Badge>
      </td>
      <td className="px-3 py-2 text-sm text-ink">{entry.sender}</td>
      <td className="px-3 py-2 text-sm text-ink">{entry.channel}</td>
      <td className="px-3 py-2 font-mono text-xs text-slate">{entry.kind}</td>
      <td className="px-3 py-2">
        <RuleChips ids={entry.ruleIds} />
      </td>
    </tr>
  );
}
