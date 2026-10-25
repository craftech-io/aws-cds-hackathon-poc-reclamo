// What the effect targets build in the stage, shared by their handler.ts entries: complaints/
// dependencies over the tool's own connector (the linked `RegisterChainKey`, read through lib/secrets.ts,
// and the `AnchorWriter` requester) and the `LAM-SCOPE` ownership a target answers when none of its tools
// names a core-owned id. Nothing is built at import time.
import { lambdaAnchorRequester } from "../../complaints/anchors";
import type { ComplaintsDeps, MilestoneScheduler } from "../../complaints/deps";
import type { Connector } from "../../connector/port";
import type { Logger } from "../../lib/log";
import { keySecret } from "../../lib/secrets";
import type { CoreOwnership } from "../common/scope";

/** complaints/ over the tool's connector; the chain key is read per call so a missing secret fails that call. */
export function stageComplaintsDeps(connector: Connector, milestones?: MilestoneScheduler): (log: Logger) => ComplaintsDeps {
  return (log) => ({
    connector,
    chainKey: keySecret("RegisterChainKey"),
    anchors: lambdaAnchorRequester(log),
    log,
    ...(milestones === undefined ? {} : { milestones }),
  });
}

/**
 * For a target whose tools declare no loan, charge, transfer or movement id: nothing is the customer's
 * by the core's word, so a call that somehow asked would be refused (fail closed).
 */
export const NO_CORE_OWNERSHIP: CoreOwnership = { owns: async () => false };
