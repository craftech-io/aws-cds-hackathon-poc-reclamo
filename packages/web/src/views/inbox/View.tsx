// `/app/inbox` (docs/design-brief.md §9 "Bandeja"; FL-097, FL-077): open complaints by deadline, the
// main story pinned on top, with the business days left, the SLA state, the next milestone, who has
// the conversation and who the complaint waits for (a network wait is never the customer's). Filters
// run in the browser over one answer, so each option says how many rows it would show.
import { useState } from "react";
import { type ComplaintType, type SlaState, SlaState as SlaStates } from "@reclamo/shared";
import { COMPLAINT_STATUS_LABEL, COMPLAINT_TYPE_LABEL, SLA_STATE_LABEL, beyondLabel, capitalize } from "@reclamo/bff/copy/index";
import { Badge } from "../../components/Badge";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { FilterPills } from "../../components/FilterPills";
import { LABEL_CLASS } from "../../components/form-classes";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { SelectField } from "../../components/SelectField";
import { SlaChip } from "../../components/SlaChip";
import type { Column } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { useRouter } from "../../lib/router";
import { useRemote } from "../../lib/use-remote";
import { complaintPath } from "../complaint/paths";
import { BlockedByBadge } from "./BlockedByBadge";
import { type BlockedByKey, inboxCopy } from "./copy";
import { ALL, type Choice, type ControlKey, type InboxFilters, type InboxItem, NO_FILTERS, applyFilters, countsFor, reminderFired, typesOf } from "./inbox-model";

const BLOCKED_ORDER: readonly BlockedByKey[] = ["CUSTOMER", "NETWORK", "PERSON", "AGENT"];
const CONTROLS: readonly ControlKey[] = ["AGENT", "OPERATOR"];

const COLUMNS: readonly Column<InboxItem>[] = [
  {
    id: "number",
    header: inboxCopy.columns.number,
    cell: (item) => (
      <div className="space-y-1">
        <p className="font-mono text-sm font-semibold text-seal-deep">{item.complaintNumber}</p>
        <div className="flex flex-wrap gap-1">
          {item.pinned ? <Badge tone="brand">{inboxCopy.mainStory}</Badge> : null}
          <Badge>{inboxCopy.kind[item.kind]}</Badge>
          {item.priority === "HIGH" ? <Badge tone="danger">{inboxCopy.highPriority}</Badge> : null}
        </div>
      </div>
    ),
  },
  {
    id: "type",
    header: inboxCopy.columns.type,
    cell: (item) => {
      const summary = beyondLabel(COMPLAINT_TYPE_LABEL[item.type], item.summary);
      return (
        <div className="max-w-xs space-y-1">
          <p className="text-sm text-ink">{capitalize(COMPLAINT_TYPE_LABEL[item.type])}</p>
          {summary === undefined ? null : <p className="line-clamp-2 text-xs text-slate">{summary}</p>}
        </div>
      );
    },
  },
  {
    id: "status",
    header: inboxCopy.columns.status,
    cell: (item) => (
      <div className="space-y-1">
        <p className="text-sm text-ink">{COMPLAINT_STATUS_LABEL[item.status]}</p>
        {item.openTasks > 0 ? <Badge tone="warning">{inboxCopy.openTasks(item.openTasks)}</Badge> : null}
      </div>
    ),
  },
  {
    id: "deadline",
    header: inboxCopy.columns.deadline,
    cell: (item) => (
      <div className="space-y-1">
        <SlaChip state={item.slaState} businessDaysLeft={Math.max(0, item.businessDaysLeft)} />
        <p className="whitespace-nowrap text-xs text-slate">{item.deadlineText}</p>
      </div>
    ),
  },
  {
    id: "next",
    header: inboxCopy.columns.next,
    cell: (item) => (
      <div className="space-y-1 text-xs">
        {item.nextMilestone?.milestone ? (
          <>
            <p className="text-ink">{inboxCopy.milestone[item.nextMilestone.milestone]}</p>
            <p className="whitespace-nowrap text-slate">{item.nextMilestone.dueText}</p>
          </>
        ) : (
          <p className="text-slate">{inboxCopy.noMilestone}</p>
        )}
        {reminderFired(item) ? <Badge tone="warning">{inboxCopy.reminderFired}</Badge> : null}
      </div>
    ),
  },
  { id: "blockedBy", header: inboxCopy.columns.blockedBy, cell: (item) => <BlockedByBadge blockedBy={item.blockedBy} /> },
  { id: "control", header: inboxCopy.columns.control, cell: (item) => <span className="text-sm text-ink">{inboxCopy.control[item.control]}</span> },
];

function pill<T extends string>(value: Choice<T>, label: string, counts: Readonly<Record<string, number>>) {
  return { value, label, count: counts[value] ?? 0 };
}

interface FiltersProps {
  readonly items: readonly InboxItem[];
  readonly filters: InboxFilters;
  readonly onChange: (filters: InboxFilters) => void;
}

function Filters({ items, filters, onChange }: FiltersProps) {
  const blocked = countsFor(items, filters, "blockedBy");
  const sla = countsFor(items, filters, "sla");
  const types = typesOf(items);
  return (
    <div className="flex flex-col gap-3 rounded-card border border-mist bg-white p-4 shadow-card">
      <FilterPills
        label={inboxCopy.filters.blockedBy}
        options={[pill(ALL, `${inboxCopy.filters.blockedBy}: ${inboxCopy.filters.all}`, blocked), ...BLOCKED_ORDER.map((key) => pill(key, inboxCopy.blockedBy[key], blocked))]}
        value={filters.blockedBy}
        onChange={(blockedBy) => onChange({ ...filters, blockedBy })}
      />
      <FilterPills
        label={inboxCopy.filters.sla}
        options={[pill<SlaState>(ALL, `${inboxCopy.filters.sla}: ${inboxCopy.filters.all}`, sla), ...SlaStates.options.map((state) => pill(state, SLA_STATE_LABEL[state], sla))]}
        value={filters.sla}
        onChange={(slaState) => onChange({ ...filters, sla: slaState })}
      />
      <div className="flex flex-wrap items-end gap-3">
        <SelectField<Choice<ComplaintType>>
          label={inboxCopy.filters.type}
          value={filters.type}
          options={[{ value: ALL, label: inboxCopy.filters.allTypes }, ...types.map((type) => ({ value: type, label: capitalize(COMPLAINT_TYPE_LABEL[type]) }))]}
          onChange={(type) => onChange({ ...filters, type })}
        />
        <div className="flex flex-col gap-1">
          <span aria-hidden="true" className={LABEL_CLASS}>
            {inboxCopy.filters.control}
          </span>
          <FilterPills
            label={inboxCopy.filters.control}
            variant="segmented"
            options={[{ value: ALL, label: inboxCopy.filters.all }, ...CONTROLS.map((control) => ({ value: control, label: inboxCopy.control[control] }))]}
            value={filters.control}
            onChange={(control) => onChange({ ...filters, control })}
          />
        </div>
      </div>
    </div>
  );
}

export function InboxView() {
  const { trpc } = useSession();
  const { navigate } = useRouter();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS);
  const remote = useRemote(`inbox.list:${String(includeClosed)}`, (signal) => trpc.inbox.list.query(includeClosed ? { includeClosed: true } : undefined, { signal }));

  return (
    <div className="space-y-4">
      <PageHeader
        title={copy.views.inbox.title}
        description={inboxCopy.lead}
        actions={
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="size-4 accent-seal-deep" checked={includeClosed} onChange={(event) => setIncludeClosed(event.target.checked)} />
            {inboxCopy.filters.includeClosed}
          </label>
        }
      />
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(data) => {
          if (data.items.length === 0) return <EmptyState title={inboxCopy.emptyWorld} lead={inboxCopy.emptyWorldLead} />;
          const rows = applyFilters(data.items, filters);
          return (
            <div className="space-y-3">
              <Filters items={data.items} filters={filters} onChange={setFilters} />
              <p className="text-xs text-slate" aria-live="polite">
                {inboxCopy.filters.total(rows.length, data.items.length)}
              </p>
              <DataTable
                columns={COLUMNS}
                rows={rows}
                keyOf={(item) => item.complaintId}
                caption={inboxCopy.caption}
                emptyTitle={inboxCopy.empty}
                emptyLead={inboxCopy.emptyLead}
                onRowClick={(item) => navigate(complaintPath(item.complaintId))}
              />
            </div>
          );
        }}
      </RemoteBlock>
    </div>
  );
}
