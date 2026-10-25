// The confirmation emails the code owes after a turn (docs/flows-catalog.md FL-053 and FL-054): an
// account closure the core took (`ACCOUNT_CLOSURE` `EXECUTED`) gets its `CLOSURE_CONFIRMATION`, and a
// data change waiting for the customer (`DATA_CHANGE` `PENDING_CONFIRMATION`) gets its
// `DATA_CHANGE_CONFIRMATION` at the address on file today. `ToolActions` has no outbound pipeline, so the
// worker sends them after the turn (obligations.ts), never the model. One message per action: its id
// derives from the action, so a redelivered event or a later turn never sends it twice.
import type { MessageKind } from "@reclamo/shared";
import type { Action } from "../domain/case-items";
import { derivedMessageId } from "./notices";

export type ConfirmationKind = Extract<MessageKind, "CLOSURE_CONFIRMATION" | "DATA_CHANGE_CONFIRMATION">;

/** The confirmation an action owes, if any. */
export function confirmationKind(action: Pick<Action, "kind" | "status">): ConfirmationKind | undefined {
  if (action.kind === "ACCOUNT_CLOSURE" && action.status === "EXECUTED") return "CLOSURE_CONFIRMATION";
  if (action.kind === "DATA_CHANGE" && action.status === "PENDING_CONFIRMATION") return "DATA_CHANGE_CONFIRMATION";
  return undefined;
}

/** The message id of an action's confirmation (the gate's `SEND#` claim makes it one send). */
export function confirmationMessageId(action: Pick<Action, "actionId">, kind: ConfirmationKind): string {
  return derivedMessageId(action.actionId, kind);
}
