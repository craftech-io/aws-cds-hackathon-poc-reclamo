// The outside world of the `complaints` target (docs/architecture.md §9.2): the core (the presenter's
// masked document and email, the loan of a written answer), the outbound gate (the acknowledgement and
// the written answer), complaints/ (number, register, state machine, answer) and the `Documents` bucket
// where every PDF of an answer is stored before the gate sends it (`<root>/complaints/<complaintId>/
// <docKind>-<n>.pdf`, docs/architecture.md §6).
import type { CoreClient } from "../../core/client";
import type { ComplaintsDeps } from "../../complaints/deps";
import type { EmailObjectStore } from "../../channels/email/store";
import { worldObjectRoot } from "../../channels/email/config";
import type { Logger } from "../../lib/log";
import type { DocKind, OutboundGate } from "../../outbound/types";

/** `PutObject` of one PDF; the stage's is the `Emails` store helper pointed at the linked `Documents` bucket. */
export type DocumentStore = EmailObjectStore;

export interface ComplaintPorts {
  readonly core: () => CoreClient;
  /** `sendThroughGate` in the stage. */
  readonly gate: OutboundGate;
  readonly complaints: (log: Logger) => ComplaintsDeps;
  readonly documents: () => DocumentStore;
}

/** `<root>/complaints/<complaintId>/<docKind>-<n>.pdf`, `n` from the document's own hash (same bytes, same key). */
export function documentKey(worldId: string, complaintId: string, docKind: DocKind, sha256: string): string {
  return `${worldObjectRoot(worldId)}complaints/${complaintId}/${docKind}-${sha256.slice(0, 16)}.pdf`;
}
