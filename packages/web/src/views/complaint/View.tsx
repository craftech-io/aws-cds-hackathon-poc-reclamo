// `/app/complaints/:id` (docs/design-brief.md §9 "Caso"; FL-017, FL-067, FL-069, FL-084, FL-085,
// FL-089): the case as one moment of the world — head with the deadline and "Avanzar al próximo hito
// de este reclamo", the unified timeline, the evidence (receipt image by `blob:`), actions and
// approvals, the conversation in human mode and the written answer. COMPLIANCE reads it; the roles
// that work cases act on it. Every action reads the case again.
import type { StaffRole } from "@reclamo/shared";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { Link, useRouter } from "../../lib/router";
import { useRemoteInput } from "../../lib/use-remote";
import { CONSOLE_HOME } from "../../routes";
import { AnswerForm } from "./AnswerForm";
import { type CaseInput, fetchCase } from "./api";
import { CaseHeader } from "./CaseHeader";
import { CaseWork } from "./CaseWork";
import { ConversationPanel } from "./ConversationPanel";
import { complaintCopy } from "./copy";
import { EvidenceSection } from "./EvidenceSection";
import { complaintIdOf } from "./paths";
import { TimelineSection } from "./TimelineSection";

const CASE_WORK: ReadonlySet<StaffRole> = new Set(["OPERATOR", "SUPERVISOR", "GUEST"]);
/** Roles that decide above the operator's cap (routers/roles.ts `capTierOf`). */
const ABOVE_OPERATOR_CAP: ReadonlySet<StaffRole> = new Set(["SUPERVISOR", "GUEST"]);

function NotFound() {
  return (
    <Callout tone="warning" title={complaintCopy.notFound}>
      <Link to={CONSOLE_HOME} className="font-semibold text-seal-deep underline">
        {complaintCopy.backToInbox}
      </Link>
    </Callout>
  );
}

export function ComplaintView() {
  const { trpc } = useSession();
  const principal = usePrincipal();
  const { path } = useRouter();
  const complaintId = complaintIdOf(path);
  const canWork = principal.role !== undefined && CASE_WORK.has(principal.role);
  const mayDecideAbove = principal.role !== undefined && ABOVE_OPERATOR_CAP.has(principal.role);
  const input: CaseInput | undefined = complaintId === undefined ? undefined : { complaintId, handsOn: canWork };
  const remote = useRemoteInput("complaints.case", input, (value, signal) => fetchCase(trpc, value, signal));
  const { reload } = remote;

  return (
    <div className="space-y-4">
      <PageHeader title={copy.views.complaint.title} description={copy.views.complaint.description} />
      <RemoteBlock state={remote.state} onRetry={reload} idle={<NotFound />}>
        {(bundle) => (
          <div className="space-y-4">
            <CaseHeader bundle={bundle} canWork={canWork} onChange={reload} />
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
              <div className="min-w-0 space-y-4">
                <TimelineSection timeline={bundle.timeline} customerId={bundle.view.complaint.customerId} canWork={canWork} onChange={reload} />
                <EvidenceSection view={bundle.view} />
              </div>
              <div className="min-w-0 space-y-4">
                {canWork ? <ConversationPanel bundle={bundle} staffId={principal.staffId} onChange={reload} /> : null}
                <CaseWork bundle={bundle} canWork={canWork} mayDecide={mayDecideAbove} onChange={reload} />
                {canWork ? <AnswerForm bundle={bundle} onChange={reload} /> : null}
              </div>
            </div>
          </div>
        )}
      </RemoteBlock>
    </div>
  );
}
