// Approve or reject one approval (`approvals.decide`, FL-024, FL-035, FL-036, FL-087), in the
// approvals list and in the case. Approving needs a recent sign-in: the password prompt opens in
// place and the approval goes on once it is confirmed. Rejecting asks for its reason. A role below the
// approval's tier sees why it cannot decide; the BFF refuses it anyway (`CAP_TIER`, audited).
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { useSession } from "../../context/SessionContext";
import type { ApiError } from "../../lib/api-error";
import type { RouterOutputs } from "../../lib/trpc-router";
import { approvalsCopy } from "./copy";
import { useRecentLoginAction } from "./use-recent-login-action";

export type Decided = RouterOutputs["approvals"]["decide"];

export interface DecidableApproval {
  readonly complaintId: string;
  readonly approvalId: string;
  readonly capTier: "OPERATOR" | "SUPERVISOR";
  readonly lapsed: boolean;
  /** Whether this principal's tier may decide it (the BFF checks again). */
  readonly decidableByMe: boolean;
}

interface Decision {
  readonly decision: "APPROVED" | "REJECTED";
  readonly reason?: string;
}

/** The refusal of a decision in the view's words, under the generic headline. */
export function DecisionError({ error }: { readonly error: ApiError }) {
  const extra = error.reason !== null ? approvalsCopy.byReason[error.reason] : undefined;
  return <ApiErrorNotice error={error} {...(extra !== undefined ? { details: [extra] } : {})} />;
}

/** What a decision did, for the view that hosts the controls (the row itself goes away on reload). */
export function DecisionOutcome({ decided }: { readonly decided: Decided }) {
  if (decided.decision === "REJECTED") return <Callout tone="info">{approvalsCopy.rejected}</Callout>;
  return <Callout tone="success">{decided.replay ? approvalsCopy.approvedAgain : approvalsCopy.approved}</Callout>;
}

interface DecisionControlsProps {
  readonly approval: DecidableApproval;
  /** Read the list or the case again after a decision, and say what it did. */
  readonly onDecided: (decided: Decided) => void;
}

export function DecisionControls({ approval, onDecided }: DecisionControlsProps) {
  const { trpc } = useSession();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const action = useRecentLoginAction<Decision, Decided>(
    (decision) => trpc.approvals.decide.mutate({ complaintId: approval.complaintId, approvalId: approval.approvalId, ...decision }),
    (decided) => {
      setRejecting(false);
      onDecided(decided);
    },
  );
  const running = action.state.status === "running";
  const done = action.state.status === "done";

  if (approval.lapsed) return <p className="text-xs font-semibold text-warning">{approvalsCopy.lapsed}</p>;
  if (!approval.decidableByMe) return <p className="text-xs font-semibold text-slate">{approvalsCopy.needsTier[approval.capTier]}</p>;

  return (
    <div className="flex min-w-56 flex-col gap-2">
      {done ? null : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={running} onClick={() => void action.run({ decision: "APPROVED" })}>
            {approvalsCopy.approve}
          </Button>
          <Button variant="secondary" disabled={running} aria-expanded={rejecting} onClick={() => setRejecting((open) => !open)}>
            {approvalsCopy.reject}
          </Button>
        </div>
      )}
      {rejecting && !done ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() !== "") void action.run({ decision: "REJECTED", reason: reason.trim() });
          }}
        >
          <label className={LABEL_CLASS}>
            {approvalsCopy.rejectReason}
            <textarea className={FIELD_CLASS} rows={2} maxLength={500} required value={reason} onChange={(event) => setReason(event.target.value)} />
            <span className={HINT_CLASS}>{approvalsCopy.rejectReasonHint}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={running || reason.trim() === ""}>
              {approvalsCopy.confirmReject}
            </Button>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              {approvalsCopy.cancel}
            </Button>
          </div>
        </form>
      ) : null}
      {action.state.status === "error" ? <DecisionError error={action.state.error} /> : null}
    </div>
  );
}
