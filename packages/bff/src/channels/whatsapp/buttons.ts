// What a resolved button does (docs/architecture-integrations.md §3.3, FL-060, FL-006, FL-005).
// Some actions are decided by code without a turn — talking to a person, opting out, the email
// consent of the acknowledgement — and the rest reach the agent's turn with the button's meaning
// attached (the loan chosen, the complaint to withdraw or to see). A title is never trusted: only the
// nonce decides, and a tapped title whose nonce no longer resolves is read as free text.
import type { HandoffReason, WaButtonAction } from "@reclamo/shared";
import type { Nonce } from "../../domain/runtime-claims";

/** Deterministic outcome of a button, or a turn with the button's context. */
export type ButtonCommand =
  | { readonly kind: "HANDOFF"; readonly reason: Extract<HandoffReason, "CUSTOMER_ASKED">; readonly complaintId?: string }
  | { readonly kind: "OPT_OUT"; readonly via: "BUTTON" }
  | { readonly kind: "EMAIL_CONSENT"; readonly accepted: boolean; readonly complaintId?: string }
  | { readonly kind: "TURN"; readonly action: WaButtonAction; readonly complaintId?: string; readonly loanId?: string };

const refs = (nonce: Nonce): { complaintId?: string; loanId?: string } => ({
  ...(nonce.complaintId === undefined ? {} : { complaintId: nonce.complaintId }),
  ...(nonce.loanId === undefined ? {} : { loanId: nonce.loanId }),
});

/** The command of a nonce that resolved for this customer and phone. */
export function commandOf(nonce: Nonce): ButtonCommand {
  switch (nonce.action) {
    case "TALK_TO_HUMAN":
      return { kind: "HANDOFF", reason: "CUSTOMER_ASKED", ...(nonce.complaintId === undefined ? {} : { complaintId: nonce.complaintId }) };
    case "OPT_OUT":
      return { kind: "OPT_OUT", via: "BUTTON" };
    case "ACCEPT_EMAIL":
    case "DECLINE_EMAIL":
      return { kind: "EMAIL_CONSENT", accepted: nonce.action === "ACCEPT_EMAIL", ...(nonce.complaintId === undefined ? {} : { complaintId: nonce.complaintId }) };
    case "CHOOSE_LOAN":
    case "CONFIRM_CLOSURE":
    case "WITHDRAW":
    case "SEE_DETAIL":
    case "HAVE_A_QUESTION":
      return { kind: "TURN", action: nonce.action, ...refs(nonce) };
  }
}
