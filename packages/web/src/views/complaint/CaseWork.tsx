// The work on a case besides the conversation (docs/design-brief.md §9 "Caso"): the actions on the
// core and their refunds, the approvals with their decision (approve / reject in place, the same
// controls as /app/approvals), "Derivar a una persona" with its reason, and internal notes (masked
// before they are stored, never seen by the customer).
import { useState } from "react";
import { type HandoffReason, HandoffReason as Reasons, formatSimInstant } from "@reclamo/shared";
import { HANDOFF_REASON_LABEL } from "@reclamo/bff/copy/index";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { MoneyText } from "../../components/MoneyText";
import { Section } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { useAction } from "../../lib/use-remote";
import { approvalsCopy } from "../approvals/copy";
import { type Decided, DecisionControls, DecisionOutcome } from "../approvals/DecisionControls";
import type { CaseBundle } from "./api";
import { CaseError } from "./CaseHeader";
import { complaintCopy } from "./copy";
import { SelectField } from "../../components/SelectField";

const text = complaintCopy.work;
const CLOSED: ReadonlySet<string> = new Set(["HUMAN_REVIEW", "ANSWERED", "CLOSED"]);

interface WorkProps {
  readonly bundle: CaseBundle;
  readonly canWork: boolean;
  readonly mayDecide: boolean;
  readonly onChange: () => void;
}

function Approvals({ bundle, canWork, mayDecide, onChange }: WorkProps) {
  const [decided, setDecided] = useState<Decided | undefined>(undefined);
  const { approvals } = bundle.view;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-pine">{text.approvals}</h3>
      {decided ? <DecisionOutcome decided={decided} /> : null}
      {approvals.length === 0 ? <p className="text-sm text-slate">{text.noApprovals}</p> : null}
      <ul className="space-y-2">
        {approvals.map((approval) => (
          <li key={approval.approvalId} className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-mist p-3">
            <div className="space-y-1 text-sm">
              <p className="font-medium text-ink">
                {approvalsCopy.action[approval.action]} · <MoneyText value={approval.amount} />
              </p>
              <p className="text-xs text-slate">
                {approvalsCopy.needsTier[approval.capTier]} · {approvalsCopy.columns.expires}: {formatSimInstant(approval.expiresAtSim)}
              </p>
              {approval.reason ? <p className="text-xs text-slate">{approval.reason}</p> : null}
            </div>
            {approval.decision === "PENDING" && canWork ? (
              <DecisionControls
                approval={{ complaintId: approval.complaintId, approvalId: approval.approvalId, capTier: approval.capTier, lapsed: Date.parse(approval.expiresAtSim) <= Date.parse(bundle.view.simNow), decidableByMe: mayDecide || approval.capTier === "OPERATOR" }}
                onDecided={(result) => {
                  setDecided(result);
                  onChange();
                }}
              />
            ) : (
              <Badge tone={approval.decision === "APPROVED" ? "success" : approval.decision === "PENDING" ? "warning" : "neutral"}>{text.decision[approval.decision] ?? approval.decision}</Badge>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Actions({ bundle }: { readonly bundle: CaseBundle }) {
  const { actions } = bundle.view;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-pine">{text.actions}</h3>
      {actions.length === 0 ? <p className="text-sm text-slate">{text.noActions}</p> : null}
      <ul className="space-y-1">
        {actions.map((action) => (
          <li key={action.actionId} className="flex flex-wrap items-center gap-2 text-sm">
            <code className="font-mono text-xs text-pine">{action.kind}</code>
            {action.amount ? <MoneyText value={action.amount} /> : null}
            <Badge tone={action.status === "EXECUTED" ? "success" : action.status === "FAILED" || action.status === "CONFLICT" ? "danger" : "neutral"}>{text.actionStatus[action.status] ?? action.status}</Badge>
            <span className="text-xs text-slate">{formatSimInstant(action.atSim)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Escalate({ bundle, onChange }: { readonly bundle: CaseBundle; readonly onChange: () => void }) {
  const { trpc } = useSession();
  const [reason, setReason] = useState<HandoffReason>("OTHER");
  const [summary, setSummary] = useState("");
  const escalate = useAction(async () => {
    const answer = await trpc.complaints.escalate.mutate({ complaintId: bundle.view.complaint.complaintId, reason, ...(summary.trim() === "" ? {} : { summary: summary.trim() }) });
    onChange();
    return answer;
  });
  if (escalate.state.status === "done") return <Callout tone="success">{escalate.state.data.already ? text.alreadyEscalated : text.escalated}</Callout>;
  if (CLOSED.has(bundle.view.complaint.status)) return null;
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void escalate.run(undefined);
      }}
    >
      <SelectField<HandoffReason> label={text.escalateReason} value={reason} options={Reasons.options.map((option) => ({ value: option, label: HANDOFF_REASON_LABEL[option] }))} onChange={setReason} />
      <label className={LABEL_CLASS}>
        {text.escalateSummary}
        <input className={FIELD_CLASS} maxLength={500} value={summary} onChange={(event) => setSummary(event.target.value)} />
      </label>
      <Button type="submit" variant="secondary" disabled={escalate.state.status === "running"}>
        {text.escalate}
      </Button>
      {escalate.state.status === "error" ? <CaseError error={escalate.state.error} /> : null}
    </form>
  );
}

function NoteForm({ bundle, onChange }: { readonly bundle: CaseBundle; readonly onChange: () => void }) {
  const { trpc } = useSession();
  const [note, setNote] = useState("");
  const add = useAction(async (value: string) => {
    const answer = await trpc.complaints.note.mutate({ complaintId: bundle.view.complaint.complaintId, text: value });
    setNote("");
    onChange();
    return answer;
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim() !== "") void add.run(note.trim());
      }}
    >
      <label className={LABEL_CLASS}>
        {text.note}
        <textarea className={FIELD_CLASS} rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
        <span className={HINT_CLASS}>{text.noteHint}</span>
      </label>
      <Button type="submit" variant="secondary" disabled={add.state.status === "running" || note.trim() === ""}>
        {text.addNote}
      </Button>
      {add.state.status === "done" ? <p className="text-xs text-success">{text.noteAdded}</p> : null}
      {add.state.status === "error" ? <CaseError error={add.state.error} /> : null}
    </form>
  );
}

export function CaseWork(props: WorkProps) {
  return (
    <Section id="work" title={complaintCopy.sections.actions}>
      <div className="space-y-5">
        <Approvals {...props} />
        <Actions bundle={props.bundle} />
        {props.canWork ? (
          <div className="space-y-4 border-t border-mist pt-4">
            <h3 className="text-sm font-semibold text-pine">{complaintCopy.sections.work}</h3>
            <Escalate bundle={props.bundle} onChange={props.onChange} />
            <NoteForm bundle={props.bundle} onChange={props.onChange} />
          </div>
        ) : null}
      </div>
    </Section>
  );
}
