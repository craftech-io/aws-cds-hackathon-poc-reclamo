// `POST /customers/{customerId}/data-change`: a change of contact data, registered and never
// applied on the spot (`T-8.1`…`T-8.3`):
//
//   EMAIL, ADDRESS  → `PENDING_CONFIRMATION`; the confirmation goes to the address on file
//                     (`confirmationToMasked`), never to the new one (FL-054)
//   PHONE           → `REFERRED`: the phone is changed only after a human verification (FL-055)
//   account blocked → `REFERRED` whatever the field (an account under review)
//
// The new value (extracted by code from the customer's message, never written by the model) is
// kept masked and, for an email, hashed; the contact data of the customer does not change. The
// same idempotency key replays the first answer; a new request for a field supersedes the pending one.
import type { DataChangeRequest, DataChangeResult } from "@reclamo/core-contract";
import { putChanged } from "../store/codec";
import type { DataChangeRecord } from "../store/items";
import { loadCustomer } from "./bundle";
import { commitWithRetry } from "./claims";
import { type LedgerContext, LedgerError, deterministicId } from "./context";

const MAX_RECORDS = 20;

/** `v***@dominio.test` for an email; the last four characters for anything else. */
export function maskNewValue(field: DataChangeRequest["field"], value: string): string {
  const trimmed = value.trim();
  if (field === "EMAIL") {
    const at = trimmed.lastIndexOf("@");
    if (at > 0) return `${trimmed.slice(0, 1)}***@${trimmed.slice(at + 1).toLowerCase()}`.slice(0, 120);
  }
  return `•••${trimmed.slice(-4)}`;
}

function toResult(record: DataChangeRecord): DataChangeResult {
  return {
    actionId: record.actionId,
    field: record.field,
    status: record.status === "REFERRED" ? "REFERRED" : "PENDING_CONFIRMATION",
    ...(record.confirmationToMasked === undefined ? {} : { confirmationToMasked: record.confirmationToMasked }),
  };
}

export async function requestDataChange(ctx: LedgerContext, customerId: string, request: DataChangeRequest): Promise<DataChangeResult> {
  return commitWithRetry(async () => {
    const bundle = await loadCustomer(ctx, customerId);
    const account = bundle.account.value;
    const earlier = account.dataChanges.find((record) => record.idempotencyKey === request.idempotencyKey);
    if (earlier !== undefined) return { writes: [], result: toResult(earlier) };
    if (account.status === "CLOSED") throw new LedgerError("CONFLICT", "the account is closed");

    const referred = request.field === "PHONE" || account.status === "BLOCKED";
    const newValue = request.newValue?.trim();
    const record: DataChangeRecord = {
      actionId: deterministicId("act", ctx.worldId, "DATA_CHANGE", customerId, request.idempotencyKey),
      complaintId: request.complaintId,
      idempotencyKey: request.idempotencyKey,
      field: request.field,
      status: referred ? "REFERRED" : "PENDING_CONFIRMATION",
      ...(newValue === undefined || newValue === "" ? {} : { newValueMasked: maskNewValue(request.field, newValue) }),
      ...(request.field === "EMAIL" && newValue !== undefined && newValue !== "" && ctx.hashEmail !== undefined ? { newValueHash: ctx.hashEmail(newValue) } : {}),
      ...(referred ? {} : { confirmationToMasked: bundle.meta.value.emailMasked }),
      requestedAtSim: ctx.simNow,
    };
    const dataChanges = [
      ...account.dataChanges.map((existing) =>
        existing.field === request.field && existing.status === "PENDING_CONFIRMATION" && !referred ? { ...existing, status: "SUPERSEDED" as const } : existing,
      ),
      record,
    ].slice(-MAX_RECORDS);
    return { writes: [putChanged(bundle.account, { ...account, dataChanges }, bundle.stamp)], result: toResult(record) };
  }, ctx);
}
