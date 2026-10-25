// One decision of the compliance tape as the operation views show it: the line of the decision with
// its rule and reason, in red for a block, its English gloss under it, the rules and who sent what
// on which channel (docs/design-brief.md §7, "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION · …").
import type { ReactNode } from "react";
import { MESSAGE_KIND_LABEL } from "@reclamo/bff/copy/index";
import { RuleChips } from "../../components/RuleChips";
import { customerCopy } from "./copy";
import { type TapeEntryView, atText, bannerOf } from "./gate-model";

const TONE_CLASS = {
  danger: "border-danger bg-danger-soft text-danger",
  warning: "border-warning bg-warning-soft text-warning",
  success: "border-success bg-success-soft text-success",
  info: "border-info bg-info-soft text-info",
  neutral: "border-mist bg-paper text-slate",
} as const;

export type BannerEntry = Pick<TapeEntryView, "decision" | "ruleIds" | "sender" | "channel" | "kind" | "atSim"> & {
  readonly result?: TapeEntryView["result"] | null;
  readonly nextAllowedAt?: string | null;
};

/** Who sent it, without the staff id: a person of the team, the agent or the system. */
export function senderText(sender: string): string {
  if (sender === "AGENT" || sender === "SYSTEM") return customerCopy.senders[sender];
  return customerCopy.senders.OPERATOR;
}

export function TapeBanner({ entry, children }: { readonly entry: BannerEntry; readonly children?: ReactNode }) {
  const banner = bannerOf(entry);
  const result = entry.decision === "DISPATCH" && entry.result ? ` · ${customerCopy.trail.result[entry.result]}` : "";
  return (
    <div role={entry.decision === "BLOCKED" ? "alert" : undefined} className={`rounded-card border px-4 py-3 text-sm ${TONE_CLASS[banner.tone]}`}>
      <p className="font-semibold">
        {banner.es}
        {result}
      </p>
      <p lang="en" className="mt-0.5 text-xs italic">
        {customerCopy.trail.gloss}: {banner.en}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink">
        <RuleChips ids={entry.ruleIds} />
        <span>
          {atText(entry)} · {senderText(entry.sender)} · {customerCopy.channel[entry.channel]} · {MESSAGE_KIND_LABEL[entry.kind]}
        </span>
      </div>
      {entry.decision === "DEFERRED" && entry.nextAllowedAt ? <p className="mt-1 text-xs text-ink">{customerCopy.trail.deferredUntil(atText({ atSim: entry.nextAllowedAt }))}</p> : null}
      {children ? <div className="mt-3 flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}
