// Explicit re-exports only (no automatic barrel).

export {
  CapAction,
  CapTier,
  Channel,
  ChannelMode,
  ChannelName,
  ClockMode,
  ComplaintOrigin,
  ComplaintOutcome,
  ComplaintStatus,
  ComplaintType,
  ContactWindow,
  DispatchResult,
  ErrorCode,
  FormOfAddress,
  GateDecision,
  HandoffReason,
  MessageKind,
  Network,
  PreferredChannel,
  PresentationKind,
  ReceiptResult,
  ReconciliationResult,
  Reroute,
  SlaMilestone,
  SlaState,
  Sender,
  StaffRole,
  TapeEntryKind,
  TimerFiredBy,
  TimerKind,
  TurnTrigger,
  WaButtonAction,
  Weekday,
  channelNameOf,
} from "./enums";

export {
  CalendarDate,
  IsoInstant,
  addBusinessDays,
  addCalendarDays,
  businessDaysBetween,
  compareDates,
  formatDate,
  formatSimInstant,
  isBusinessDay,
  isWeekend,
  nextBusinessDay,
  weekStart,
  weekdayOf,
} from "./dates";

export {
  addressHash,
  hmacSha256Hex,
  isHexHash,
  maskDocument,
  maskEmail,
  maskPhone,
  normalizeAddress,
  normalizeEmail,
  normalizePhone,
  sha256Hex,
} from "./hash";

export {
  ChannelError,
  ChannelErrorCode,
  ConnectorError,
  ConnectorErrorCode,
  ERROR_REASON,
  ToolError,
  ToolErrorSchema,
  ToolFailureSchema,
  fail,
  isRetryable,
  ok,
  toToolFailure,
} from "./errors";
export type { ErrorReason, ToolErrorShape, ToolFailure, ToolOk, ToolResult } from "./errors";

export { GuestOrigin, type SignupWorldClass, WORLD_ID_MAX_LENGTH, WorldId, WorldKind, guestOriginOf, mayRunLive, signupWorldClassOf, worldKeyPrefix, worldKindOf } from "./world-kind";

export { Money, formatPesos, pesosFromCents } from "./money";

export { ComplaintNumber, CustomerId, Id, LoanId, StaffId, complaintNumber, parseComplaintNumber } from "./ids";

export { Caller, CallerKind, carriesCaller } from "./caller";
