// Cinta de cumplimiento (docs/design-brief.md §7 and §9; docs/architecture-integrations.md §4; FL-064,
// FL-075): every decision of the outbound gate in the world's current epoch, whoever sent the message
// (the agent, the system or a person of the team), with its rules, its reroute and the result of the
// dispatch; blocks in red with their English gloss; the policy violations (which must stay at 0); the
// state of the tape's own hash chain and its verified export. Read-only for every role.
import { type Channel, type TapeEntryKind, TapeEntryKind as TapeEntryKinds } from "@reclamo/shared";
import { BLOCK_SOURCE_REASON } from "@reclamo/bff/copy/block-reasons";
import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { StatGrid, StatTile } from "../../components/StatTile";
import { EmptyState } from "../../components/EmptyState";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { useRouter } from "../../lib/router";
import { dataOf, useRemote } from "../../lib/use-remote";
import { CONSOLE_PREFIX } from "../../routes";
import { ChainStatus } from "../register/ChainStatus";
import { ExportPanel } from "../register/ExportPanel";
import { TapeTable } from "./TapeTable";
import { tapeCopy } from "./copy";
import { ALL, type All, NO_FILTER, PAGE, RULE_OPTIONS, type SenderClass, type TapeFilterState, type TapeList, complaintFilterOf, listInputOf } from "./tape-model";

/** The tape refreshes on its own while the view is open (docs/architecture.md §11, at rest). */
const REFRESH_MS = 15_000;

const SENDERS: readonly SenderClass[] = ["AGENT", "SYSTEM", "OPERATOR"];
const CHANNELS: readonly Channel[] = ["WHATSAPP", "EMAIL"];

function Stats({ list }: { readonly list: TapeList }) {
  const s = tapeCopy.stats;
  return (
    <div className="space-y-2">
      <StatGrid>
        <StatTile label={s.violations} value={list.violations} tone={list.violations === 0 ? "success" : "danger"} hint={s.violationsHint} />
        <StatTile label={s.total} value={list.total} />
        <StatTile label={s.blocked} value={list.byDecision.BLOCKED ?? 0} tone={(list.byDecision.BLOCKED ?? 0) > 0 ? "danger" : "neutral"} />
        <StatTile label={s.rerouted} value={list.byDecision.REROUTED ?? 0} tone="warning" />
      </StatGrid>
      <p className="text-xs text-slate">{s.violationsNote}</p>
    </div>
  );
}

function Filters({ filter, counts, onChange }: { readonly filter: TapeFilterState; readonly counts: Readonly<Record<string, number>> | undefined; readonly onChange: (next: TapeFilterState) => void }) {
  const f = tapeCopy.filters;
  const decisions: readonly (TapeEntryKind | All)[] = [ALL, ...TapeEntryKinds.options];
  return (
    <div className="space-y-3">
      <FilterPills
        label={f.decision}
        value={filter.decision}
        onChange={(decision) => onChange({ ...filter, decision })}
        options={decisions.map((value) => ({
          value,
          label: value === ALL ? f.all : tapeCopy.decisions[value],
          ...(counts === undefined ? {} : { count: value === ALL ? Object.values(counts).reduce((sum, n) => sum + n, 0) : (counts[value] ?? 0) }),
        }))}
      />
      <div className="flex flex-wrap items-end gap-3">
        <SelectField<SenderClass | All>
          label={f.sender}
          value={filter.sender}
          onChange={(sender) => onChange({ ...filter, sender })}
          options={[{ value: ALL, label: f.allSenders }, ...SENDERS.map((value) => ({ value, label: tapeCopy.senders[value] }))]}
        />
        <SelectField<Channel | All>
          label={f.channel}
          value={filter.channel}
          onChange={(channel) => onChange({ ...filter, channel })}
          options={[{ value: ALL, label: f.allChannels }, ...CHANNELS.map((value) => ({ value, label: tapeCopy.channels[value] }))]}
        />
        <div className="w-full min-w-0 sm:w-auto">
          <SelectField<TapeFilterState["ruleId"]>
            label={f.rule}
            value={filter.ruleId}
            className="w-full"
            onChange={(ruleId) => onChange({ ...filter, ruleId })}
            options={[{ value: ALL, label: f.allRules }, ...RULE_OPTIONS.map((value) => ({ value, label: `${value} · ${BLOCK_SOURCE_REASON[value].short}` }))]}
          />
        </div>
      </div>
    </div>
  );
}

export function TapeView() {
  const { trpc } = useSession();
  const { search, navigate } = useRouter();
  const view = consoleCopy.views.tape;
  const complaintId = complaintFilterOf(search);
  const [filter, setFilter] = useState<TapeFilterState>(NO_FILTER);
  const [limit, setLimit] = useState(PAGE);
  const effective: TapeFilterState = complaintId === undefined ? filter : { ...filter, complaintId };
  const input = listInputOf(effective, limit);

  const list = useRemote(`tape.list:${JSON.stringify(input)}`, (signal) => trpc.tape.list.query(input, { signal }));
  const chain = useRemote("register.verify:TAPE", (signal) => trpc.register.verify.query({ chain: "TAPE" }, { signal }));
  const { reload } = list;
  useEffect(() => {
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const change = (next: TapeFilterState) => {
    setFilter(next);
    setLimit(PAGE);
  };
  const counts = dataOf(list.state)?.byDecision;

  return (
    <div className="space-y-6">
      <PageHeader title={view.title} description={view.description} />
      <RemoteBlock state={list.state} onRetry={list.reload}>
        {(data) => <Stats list={data} />}
      </RemoteBlock>
      <Section id="tape-decisions" title={tapeCopy.listTitle}>
        <div className="space-y-4">
          <Filters filter={filter} counts={counts} onChange={change} />
          {complaintId !== undefined ? (
            <p className="flex flex-wrap items-center gap-3 text-sm text-ink">
              {tapeCopy.filters.complaint(complaintId)}
              <Button variant="ghost" onClick={() => navigate(`${CONSOLE_PREFIX}/tape`)}>
                {tapeCopy.filters.clearComplaint}
              </Button>
            </p>
          ) : null}
          <RemoteBlock state={list.state} onRetry={list.reload}>
            {(data) =>
              data.entries.length === 0 ? (
                <EmptyState title={tapeCopy.empty} />
              ) : (
                <div className="space-y-3">
                  <TapeTable entries={data.entries} />
                  <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate">
                    <span>{tapeCopy.shown(data.entries.length, data.matching)}</span>
                    {data.cursor !== null ? (
                      <Button variant="secondary" onClick={() => setLimit((current) => Math.min(500, current + PAGE))}>
                        {tapeCopy.more}
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            }
          </RemoteBlock>
        </div>
      </Section>
      <Section id="tape-chain" title={tapeCopy.chainTitle}>
        <RemoteBlock state={chain.state} onRetry={chain.reload}>
          {(verification) => <ChainStatus verification={verification} title={tapeCopy.chainTitle} />}
        </RemoteBlock>
        <div className="mt-4 border-t border-mist pt-4">
          <ExportPanel title={tapeCopy.exportTitle} run={() => trpc.tape.export.query()} onExported={chain.reload} />
        </div>
      </Section>
    </div>
  );
}
