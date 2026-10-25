// The head of a case: the number on record, type, status, where it stands against its 10-business-day
// deadline, who it waits for, who holds the conversation, the next milestone and "Avanzar al próximo
// hito de este reclamo" (`clock.advanceToNext({complaintId})`), which moves only this world's clock,
// firing everything due on the way, in order.
import { COMPLAINT_OUTCOME_LABEL, COMPLAINT_STATUS_LABEL, COMPLAINT_STATUS_GLOSS, COMPLAINT_TYPE_GLOSS, COMPLAINT_TYPE_LABEL, HANDOFF_REASON_LABEL, beyondLabel, capitalize } from "@reclamo/bff/copy/index";
import { formatSimInstant } from "@reclamo/shared";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { SlaChip } from "../../components/SlaChip";
import { useSession } from "../../context/SessionContext";
import type { ApiError } from "../../lib/api-error";
import { Link } from "../../lib/router";
import { useAction } from "../../lib/use-remote";
import { inboxCopy } from "../inbox/copy";
import { BlockedByBadge } from "../inbox/BlockedByBadge";
import { announceClockMoved } from "../../lib/clock-events";
import type { CaseBundle } from "./api";
import { complaintCopy } from "./copy";
import { customerPath } from "./paths";

const text = complaintCopy.header;

/** A refusal of a case action, with the view's words for the reasons it knows. */
export function CaseError({ error }: { readonly error: ApiError }) {
  const extra = error.reason !== null ? complaintCopy.byReason[error.reason] : undefined;
  return <ApiErrorNotice error={error} {...(extra !== undefined ? { details: [extra] } : {})} />;
}

/** The earliest milestone of the case still scheduled, from its timeline. */
export function nextMilestoneOf(bundle: CaseBundle) {
  return bundle.timeline.items
    .filter((item) => item.type === "MILESTONE" && item.status === "SCHEDULED")
    .sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim))
    .find((item) => item.type === "MILESTONE");
}

interface CaseHeaderProps {
  readonly bundle: CaseBundle;
  readonly canWork: boolean;
  readonly onChange: () => void;
}

export function CaseHeader({ bundle, canWork, onChange }: CaseHeaderProps) {
  const { trpc } = useSession();
  const { complaint, conversation } = bundle.view;
  const advance = useAction(async () => {
    const moved = await trpc.clock.advanceToNext.mutate({ complaintId: complaint.complaintId });
    announceClockMoved();
    onChange();
    return moved;
  });
  const next = nextMilestoneOf(bundle);
  const customerName = bundle.customer ? `${bundle.customer.customer.firstName} ${bundle.customer.customer.lastName}` : undefined;

  return (
    <header className="space-y-4 rounded-card border border-mist bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-mono text-2xl font-semibold tracking-tight text-seal-deep">{complaint.complaintNumber}</h2>
          <p className="text-sm text-ink">
            {inboxCopy.kind[complaint.kind]} · {capitalize(COMPLAINT_TYPE_LABEL[complaint.type])}
            <span lang="en" className="text-xs text-slate">
              {" "}
              · {COMPLAINT_TYPE_GLOSS[complaint.type]}
            </span>
          </p>
          {beyondLabel(COMPLAINT_TYPE_LABEL[complaint.type], complaint.summary) === undefined ? null : <p className="max-w-2xl text-sm text-slate">{complaint.summary}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={complaint.status === "HUMAN_REVIEW" ? "warning" : complaint.status === "ANSWERED" || complaint.status === "CLOSED" ? "success" : "info"}>
            {COMPLAINT_STATUS_LABEL[complaint.status]} · {COMPLAINT_STATUS_GLOSS[complaint.status]}
          </Badge>
          {complaint.outcome ? <Badge>{COMPLAINT_OUTCOME_LABEL[complaint.outcome]}</Badge> : null}
          {complaint.priority === "HIGH" ? <Badge tone="danger">{inboxCopy.highPriority}</Badge> : null}
        </div>
      </div>
      <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{text.deadline}</dt>
          <dd className="mt-1 space-y-1">
            <SlaChip state={complaint.slaState} businessDaysLeft={Math.max(0, complaint.businessDaysLeft)} />
            <p className="text-xs text-slate">
              {complaint.deadlineText} · {text.filed} {formatSimInstant(complaint.filedAtSim)}
            </p>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{text.blockedBy}</dt>
          <dd className="mt-1">
            <BlockedByBadge blockedBy={complaint.blockedBy} />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{text.control}</dt>
          <dd className="mt-1 text-ink">{inboxCopy.control[conversation?.control ?? complaint.control]}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{text.next}</dt>
          <dd className="mt-1 text-xs text-ink">
            {next && next.type === "MILESTONE" && next.milestone && next.milestone in inboxCopy.milestone ? (
              <>
                {inboxCopy.milestone[next.milestone as keyof typeof inboxCopy.milestone]} · {formatSimInstant(next.atSim)}
              </>
            ) : (
              inboxCopy.noMilestone
            )}
          </dd>
        </div>
      </dl>
      {complaint.handoff ? (
        <p className="text-xs text-warning">
          {text.handoff}: {HANDOFF_REASON_LABEL[complaint.handoff.reason]}
          {complaint.handoff.summary ? ` · ${complaint.handoff.summary}` : ""}
        </p>
      ) : null}
      {complaint.answer?.sentAtSim ? (
        <p className="text-xs text-success">
          {text.answered}: {formatSimInstant(complaint.answer.sentAtSim)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {canWork ? (
          <Button variant="secondary" disabled={advance.state.status === "running"} onClick={() => void advance.run(undefined)}>
            {complaintCopy.advance}
          </Button>
        ) : null}
        {customerName && canWork ? (
          <Link to={customerPath(complaint.customerId)} className="text-sm font-semibold text-seal-deep underline">
            {text.customer}: {customerName}
          </Link>
        ) : null}
      </div>
      {canWork ? <p className="text-xs text-slate">{complaintCopy.advanceHint}</p> : null}
      {advance.state.status === "done" ? <Callout tone="success">{complaintCopy.advanced(formatSimInstant(advance.state.data.simNow))}</Callout> : null}
      {advance.state.status === "error" ? <CaseError error={advance.state.error} /> : null}
    </header>
  );
}
