// Lambda entry of `ToolIdentity` (docs/architecture.md §9.2): infra points the function at `handler`.
// The ports are the ones linked into the Lambda (core, complaints/ with the register chain key and the
// anchors, the outbound gate), resolved on the first call that needs them, never at import.
import { type ComplaintsDeps, stageComplaintsDeps } from "../../complaints/deps";
import { sendThroughGate } from "../../outbound/gate";
import { lambdaEntry } from "../common/deps";
import type { GatewayTargetRuntime, ToolDeps } from "../common/handler";
import { productionCore } from "../account/core";
import { productionOwnership } from "../account/ownership";
import { createIdentityTarget } from "./target";
import type { IdentityPorts } from "./tools";

let complaintsDeps: ComplaintsDeps | undefined;

export function productionIdentityPorts(): IdentityPorts {
  return { core: productionCore, complaints: () => (complaintsDeps ??= stageComplaintsDeps()), gate: sendThroughGate };
}

/** The target over the linked ports (the worker's preload in the stage). */
export function stageIdentityTarget(deps: ToolDeps): GatewayTargetRuntime {
  return createIdentityTarget(deps, productionIdentityPorts());
}

export const handler = lambdaEntry(stageIdentityTarget, productionOwnership);
