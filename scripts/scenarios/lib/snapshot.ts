// What the `QaDriver`'s `snapshot` answers (packages/bff/src/qa-driver/actions-inspect.ts) and the small
// reads every scenario repeats over it. The driver declares its answer `unknown`; this is its shape, kept
// next to the readers so a changed field breaks here, once. No phone, no address, no record content.
import type { ComplaintStatus, ComplaintType, MessageKind, TimerKind } from "@reclamo/shared";

export interface SnapshotMessage {
  readonly messageId: string;
  readonly direction: "IN" | "OUT";
  readonly channel: "WHATSAPP" | "EMAIL";
  readonly kind: MessageKind | null;
  readonly status: string;
  readonly body: string;
  readonly templateName: string | null;
  readonly atSim: string;
  readonly turnId: string | null;
  /** `flags.disclosure`: the message carried the automation disclosure (FL-001). */
  readonly disclosure: boolean;
  /** The actions of its buttons (never their nonces). */
  readonly buttons: ReadonlyArray<{ readonly action: string; readonly title: string | null }>;
  /** An inbound image's scan registry, while it lives (FL-101: `RESULT_FIRST` / `BIND_FIRST`). */
  readonly scan: {
    readonly status: string | null;
    readonly result: string | null;
    readonly resolution: "RESULT_FIRST" | "BIND_FIRST" | null;
    readonly resultAtReal: string | null;
    readonly boundAtReal: string | null;
    readonly resolvedAtReal: string | null;
  } | null;
}

export interface SnapshotComplaint {
  readonly complaint: {
    readonly complaintId: string;
    readonly complaintNumber: string;
    readonly customerId: string;
    readonly kind: "CONSULTA" | "RECLAMO";
    readonly type: ComplaintType;
    readonly status: ComplaintStatus;
    readonly outcome?: string;
    readonly priority: "NORMAL" | "HIGH";
    readonly filedAtSim: string;
    readonly deadlineSim: string;
    readonly emailAnswerConsent: { readonly status: "PENDING" | "ACCEPTED" | "DECLINED" };
    readonly answer?: { readonly mailId?: string; readonly deliveryProof?: string };
    readonly handoff?: { readonly reason: string };
    readonly statusHistory: ReadonlyArray<{ readonly from: ComplaintStatus | null; readonly to: ComplaintStatus; readonly atSim: string; readonly cause: string; readonly actor: string }>;
  } | null;
  readonly evidence: ReadonlyArray<{ readonly evidenceId: string; readonly kind: string; readonly actor: string }>;
  readonly actions: ReadonlyArray<{ readonly actionId: string; readonly kind: string; readonly status: string; readonly amountCents?: number; readonly claimKey?: string; readonly approvalId?: string; readonly dataChangeField?: "EMAIL" | "ADDRESS" | "PHONE" }>;
  readonly approvals: ReadonlyArray<{ readonly approvalId: string; readonly action: string; readonly amountCents: number; readonly capTier: string; readonly decision: string; readonly executedAt?: string }>;
  readonly register: ReadonlyArray<{ readonly seq: number; readonly eventType: string; readonly atSim: string }>;
  readonly tape: ReadonlyArray<{ readonly tapeId: string; readonly decision: string; readonly ruleIds: readonly string[]; readonly kind: string | null; readonly channel: string }>;
}

export interface SnapshotTimer {
  readonly kind: TimerKind;
  readonly timerId: string;
  readonly dueAtSim: string;
  readonly status: string;
  readonly ownerKey: string | null;
}

export interface Snapshot {
  readonly worldId: string;
  readonly epoch: number;
  readonly clock: { readonly mode: "PAUSED" | "RUNNING"; readonly pausedSimNow: string | null };
  readonly conversation: { readonly sessionEpoch: number; readonly disclosedEpochs: readonly number[]; readonly control: string; readonly openComplaintIds: readonly string[] } | null;
  readonly processError: unknown;
  readonly messages: readonly SnapshotMessage[];
  readonly complaints: readonly SnapshotComplaint[];
  /** The world's pending timers (index `ClockDue`: only `SCHEDULED` ones). */
  readonly timers: readonly SnapshotTimer[];
  readonly emails: ReadonlyArray<{ readonly mailId: string; readonly kind: string; readonly customerId: string; readonly events: readonly string[]; readonly deliveryProof: boolean }>;
  readonly inFlight: number;
  readonly turnsToday: number;
}

export type Complaint = NonNullable<SnapshotComplaint["complaint"]>;

/** Every complaint of the snapshot (the snapshot of one customer lists them all, open or not). */
export function complaintsOf(snapshot: Snapshot): Array<SnapshotComplaint & { readonly complaint: Complaint }> {
  return snapshot.complaints.filter((view): view is SnapshotComplaint & { readonly complaint: Complaint } => view.complaint !== null);
}

/** The newest complaint of the snapshot, or one of `type`. */
export function latestComplaint(snapshot: Snapshot, type?: ComplaintType): (SnapshotComplaint & { readonly complaint: Complaint }) | undefined {
  return complaintsOf(snapshot)
    .filter((view) => type === undefined || view.complaint.type === type)
    .sort((a, b) => b.complaint.complaintNumber.localeCompare(a.complaint.complaintNumber))[0];
}

export function complaintById(snapshot: Snapshot, complaintId: string): (SnapshotComplaint & { readonly complaint: Complaint }) | undefined {
  return complaintsOf(snapshot).find((view) => view.complaint.complaintId === complaintId);
}

export interface MessageFilter {
  readonly direction?: "IN" | "OUT";
  readonly channel?: "WHATSAPP" | "EMAIL";
  readonly kind?: MessageKind | readonly MessageKind[];
  readonly status?: readonly string[];
  /** Only messages at or after this simulated instant. */
  readonly sinceSim?: string;
}

/** Outbound messages that left: sent and anything after it. */
export const SENT: readonly string[] = ["SENT", "DELIVERED", "READ"];

export function messages(snapshot: Snapshot, filter: MessageFilter = {}): SnapshotMessage[] {
  const kinds = filter.kind === undefined ? undefined : Array.isArray(filter.kind) ? filter.kind : [filter.kind];
  return snapshot.messages.filter(
    (message) =>
      (filter.direction === undefined || message.direction === filter.direction) &&
      (filter.channel === undefined || message.channel === filter.channel) &&
      (kinds === undefined || (message.kind !== null && kinds.includes(message.kind))) &&
      (filter.status === undefined || filter.status.includes(message.status)) &&
      (filter.sinceSim === undefined || Date.parse(message.atSim) >= Date.parse(filter.sinceSim)),
  );
}

export function timersOf(snapshot: Snapshot, kind: TimerKind, ownerKey?: string): SnapshotTimer[] {
  return snapshot.timers.filter((timer) => timer.kind === kind && (ownerKey === undefined || timer.ownerKey === ownerKey)).sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim));
}

/** `CMP#<complaintId>`: the owner of a complaint's milestones. */
export const complaintOwner = (complaintId: string): string => `CMP#${complaintId}`;

/** `W#<world>#TIMER#<kind>#<timerId>`: the key `clock.unfreeze` and `schedule.fireStale` take. */
export const timerKeyOf = (worldId: string, kind: string, timerId: string): string => `W#${worldId}#TIMER#${kind}#${timerId}`;

/** Same instant, whatever the offset it is written with. */
export const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

/** `R-AAAA-NNNNNN`. */
export const COMPLAINT_NUMBER = /^R-\d{4}-\d{6}$/;
