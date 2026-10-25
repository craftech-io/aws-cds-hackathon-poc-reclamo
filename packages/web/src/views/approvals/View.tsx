// `/app/approvals` (docs/design-brief.md §9 "Aprobaciones"; FL-024, FL-034, FL-035, FL-036, FL-087):
// the agent's requests above its cap, oldest first, with the amount, the cap it went over, the
// evidence, the expiry and who may decide each one. Approving asks for a recent sign-in in place;
// the code executes the approved action, never this view.
import { useState } from "react";
import { type StaffRole, formatSimInstant } from "@reclamo/shared";
import { Callout } from "../../components/Callout";
import { EmptyState } from "../../components/EmptyState";
import { MoneyText } from "../../components/MoneyText";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { type Column, Table } from "../../components/Table";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { Link } from "../../lib/router";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useRemote } from "../../lib/use-remote";
import { complaintPath } from "../complaint/paths";
import { approvalsCopy } from "./copy";
import { type Decided, DecisionControls, DecisionOutcome } from "./DecisionControls";

export type ApprovalItem = RouterOutputs["approvals"]["list"]["items"][number];

function columns(onDecided: (decided: Decided) => void): Column<ApprovalItem>[] {
  return [
    {
      id: "complaint",
      header: approvalsCopy.columns.complaint,
      cell: (item) => (
        <div className="space-y-1">
          <Link to={complaintPath(item.complaintId)} className="whitespace-nowrap font-mono text-sm font-semibold text-seal-deep underline">
            {item.complaintNumber ?? item.complaintId}
          </Link>
          <p className="text-xs text-slate">
            {approvalsCopy.requestedBy} · {formatSimInstant(item.requestedAtSim)}
          </p>
        </div>
      ),
    },
    {
      id: "action",
      header: approvalsCopy.columns.action,
      cell: (item) => (
        <div className="max-w-xs space-y-1">
          <p className="font-medium text-ink">{approvalsCopy.action[item.action]}</p>
          {item.justification !== "" ? (
            <p className="text-xs text-slate">
              {approvalsCopy.justification}: {item.justification}
            </p>
          ) : null}
        </div>
      ),
    },
    { id: "amount", header: approvalsCopy.columns.amount, align: "right", cell: (item) => <MoneyText value={item.amount} /> },
    {
      id: "cap",
      header: approvalsCopy.columns.cap,
      cell: (item) => (
        <div className="space-y-1 text-xs">
          {item.capExceeded ? <p className="text-ink">{approvalsCopy.capOf[item.capExceeded.tier](item.capExceeded.cap.text)}</p> : null}
          <p className="font-semibold text-slate">{approvalsCopy.needsTier[item.capTier]}</p>
        </div>
      ),
    },
    {
      id: "evidence",
      header: approvalsCopy.columns.evidence,
      cell: (item) => (
        <Link to={`${complaintPath(item.complaintId)}#evidence`} className="text-xs font-semibold text-seal-deep underline">
          {approvalsCopy.evidenceLink}
        </Link>
      ),
    },
    { id: "expires", header: approvalsCopy.columns.expires, cell: (item) => <span className="whitespace-nowrap text-xs text-ink">{item.expiresText}</span> },
    {
      id: "decision",
      header: approvalsCopy.columns.decision,
      cell: (item) => <DecisionControls approval={item} onDecided={onDecided} />,
    },
  ];
}

function tierHint(role: StaffRole): string {
  return approvalsCopy.tierHint[role];
}

export function ApprovalsView() {
  const { trpc } = useSession();
  const principal = usePrincipal();
  const remote = useRemote("approvals.list", (signal) => trpc.approvals.list.query(undefined, { signal }));
  const [decided, setDecided] = useState<Decided | undefined>(undefined);
  const onDecided = (result: Decided) => {
    setDecided(result);
    remote.reload();
  };
  return (
    <div className="space-y-4">
      <PageHeader title={copy.views.approvals.title} description={approvalsCopy.lead} />
      <Callout tone="neutral">
        {principal.role ? <p>{tierHint(principal.role)}</p> : null}
        <p className="mt-1">{approvalsCopy.recentLogin}</p>
      </Callout>
      {decided ? <DecisionOutcome decided={decided} /> : null}
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={approvalsCopy.empty} lead={approvalsCopy.emptyLead} />
          ) : (
            <Table columns={columns(onDecided)} rows={data.items} keyOf={(item) => item.approvalId} caption={approvalsCopy.caption} emptyTitle={approvalsCopy.empty} />
          )
        }
      </RemoteBlock>
    </div>
  );
}
