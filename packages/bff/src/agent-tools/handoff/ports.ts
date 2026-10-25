// The outside world of the `handoff` target (docs/architecture.md §9.2): the outbound gate (the handoff
// notice, the safety guidance, the approval update) and complaints/ (the transition to `HUMAN_REVIEW` or
// `AWAITING_APPROVAL` with its register entry). No core: the approval request takes the action and the
// amount the `actions` target fixed when it answered `ABOVE_CAP`.
import type { ComplaintsDeps } from "../../complaints/deps";
import type { Logger } from "../../lib/log";
import type { OutboundGate } from "../../outbound/types";

export interface HandoffPorts {
  /** `sendThroughGate` in the stage. */
  readonly gate: OutboundGate;
  readonly complaints: (log: Logger) => ComplaintsDeps;
}
