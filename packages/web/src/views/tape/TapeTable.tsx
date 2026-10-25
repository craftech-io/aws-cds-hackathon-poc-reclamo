// The decisions of the tape, newest first, one shared TapeRow each. A block, a reroute and a deferral
// carry their banner right under the row, in red for a block whoever the sender was, with the English
// gloss for a guest who does not read Spanish (docs/design-brief.md §13); the rest of an entry (the
// rules it went through, the reroute, the hashes) opens in place. Below `md` the same entries are
// stacked cards, so a block's red banner is whole at 390 px instead of cut off by a wide table.
import { formatSimInstant } from "@reclamo/shared";
import { Fragment, type ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { RuleChip } from "../../components/RuleChip";
import { RuleChips } from "../../components/RuleChips";
import { DECISION_LABEL, TAPE_DECISION_TONE, TapeRow } from "../../components/TapeRow";
import { Link } from "../../lib/router";
import { CONSOLE_PREFIX } from "../../routes";
import { shortHash } from "../register/register-model";
import { tapeCopy } from "./copy";
import { type TapeItem, bannerOf, rerouteText, reviewedRules, rowOf } from "./tape-model";

const cols = tapeCopy.columns;
const BANNER_TONE = { BLOCKED: "border-danger bg-danger-soft text-danger", REROUTED: "border-warning bg-warning-soft text-warning", DEFERRED: "border-info bg-info-soft text-info" } as const;

function Banner({ entry }: { readonly entry: TapeItem }) {
  const banner = bannerOf(entry);
  if (banner === undefined || entry.decision === "ALLOWED" || entry.decision === "DISPATCH") return null;
  return (
    <div data-tape-banner={entry.decision} className={`rounded-md border-l-4 px-3 py-2 ${BANNER_TONE[entry.decision]}`}>
      <p className="text-sm font-semibold">{banner.es}</p>
      <p lang="en" className="text-xs text-ink">
        {banner.en}
      </p>
    </div>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-x-2 gap-y-0.5 text-xs sm:grid-cols-[11rem_1fr]">
      <dt className="font-semibold text-slate">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

function Detail({ entry }: { readonly entry: TapeItem }) {
  const d = tapeCopy.detail;
  const reroute = entry.reroute;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs font-semibold text-seal-deep">{d.open}</summary>
      <dl className="mt-2 space-y-1">
        <Fact label={d.entry}>
          seq {entry.seq} · <code className="font-mono">{entry.tapeId}</code> · <code className="font-mono" title={entry.hash}>{shortHash(entry.hash)}</code>
        </Fact>
        <Fact label={d.version}>{entry.ruleSetVersion}</Fact>
        {entry.complaintId !== undefined ? (
          <Fact label={d.complaint}>
            <Link to={`${CONSOLE_PREFIX}/complaints/${entry.complaintId}`} className="font-mono text-seal-deep underline">
              {entry.complaintId}
            </Link>
          </Fact>
        ) : null}
        {entry.messageId !== undefined ? <Fact label={d.message}><code className="font-mono">{entry.messageId}</code></Fact> : null}
        {entry.payloadHash !== undefined ? <Fact label={d.payload}><code className="font-mono" title={entry.payloadHash}>{shortHash(entry.payloadHash)}</code></Fact> : null}
        {entry.customerRef !== undefined ? <Fact label={d.customer}><code className="font-mono" title={entry.customerRef}>{shortHash(entry.customerRef)}</code></Fact> : null}
        {entry.result !== undefined ? <Fact label={d.result}>{tapeCopy.results[entry.result] ?? entry.result}</Fact> : null}
        {entry.nextAllowedAt !== undefined ? <Fact label={d.nextAllowed}>{formatSimInstant(entry.nextAllowedAt)}</Fact> : null}
        {reroute !== undefined ? (
          <Fact label={d.reroute}>
            {rerouteText(reroute.route).es} <span lang="en" className="text-slate">· {rerouteText(reroute.route).en}</span>
            {reroute.childTapeId !== undefined ? <> · {d.child}: <code className="font-mono">{reroute.childTapeId}</code></> : null}
          </Fact>
        ) : null}
        {entry.rerouteOf !== undefined ? <Fact label={d.rerouteOf}><code className="font-mono">{entry.rerouteOf}</code></Fact> : null}
        {entry.evaluated.length > 0 ? (
          <Fact label={d.reviewed}>
            <ul className="flex flex-wrap gap-1.5">
              {reviewedRules(entry).map((rule) => (
                <li key={rule.ruleId} className="inline-flex items-center gap-1">
                  <RuleChip ruleId={rule.ruleId} /> <span className="text-slate">{rule.text}</span>
                </li>
              ))}
            </ul>
          </Fact>
        ) : null}
      </dl>
    </details>
  );
}

/** One decision as a card (below `md`): when, the decision, who, channel and kind, rules, then the banner. */
function TapeCard({ entry }: { readonly entry: TapeItem }) {
  const row = rowOf(entry);
  return (
    <li data-tape-card={entry.tapeId} className={`space-y-2 rounded-card border border-mist p-3 shadow-card ${entry.decision === "BLOCKED" ? "bg-danger-soft" : "bg-white"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={TAPE_DECISION_TONE[row.decision]}>{DECISION_LABEL[row.decision]}</Badge>
        <span className="text-xs text-slate">{row.atText}</span>
      </div>
      <Banner entry={entry} />
      <dl className="space-y-1">
        <Fact label={cols.sender}>{row.sender}</Fact>
        <Fact label={cols.channel}>{row.channel}</Fact>
        <Fact label={cols.kind}>{row.kind}</Fact>
        {row.ruleIds.length > 0 ? (
          <Fact label={cols.rules}>
            <RuleChips ids={row.ruleIds} />
          </Fact>
        ) : null}
      </dl>
      <Detail entry={entry} />
    </li>
  );
}

export function TapeTable({ entries }: { readonly entries: readonly TapeItem[] }) {
  return (
    <>
      <ul aria-label={tapeCopy.caption} className="space-y-3 md:hidden">
        {entries.map((entry) => (
          <TapeCard key={entry.tapeId} entry={entry} />
        ))}
      </ul>
      <TapeWideTable entries={entries} />
    </>
  );
}

function TapeWideTable({ entries }: { readonly entries: readonly TapeItem[] }) {
  return (
    <div className="hidden overflow-x-auto rounded-card border border-mist bg-white shadow-card md:block">
      <table className="w-full text-sm">
        <caption className="sr-only">{tapeCopy.caption}</caption>
        <thead className="bg-paper text-left text-xs uppercase tracking-wide text-slate">
          <tr>
            {[cols.at, cols.decision, cols.sender, cols.channel, cols.kind, cols.rules].map((header) => (
              <th key={header} scope="col" className="px-3 py-2 font-semibold">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <Fragment key={entry.tapeId}>
              <TapeRow entry={rowOf(entry)} />
              <tr className={`border-b border-mist ${entry.decision === "BLOCKED" ? "bg-danger-soft" : ""}`} data-tape-id={entry.tapeId}>
                <td colSpan={6} className="space-y-2 px-3 pb-3">
                  <Banner entry={entry} />
                  <Detail entry={entry} />
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
