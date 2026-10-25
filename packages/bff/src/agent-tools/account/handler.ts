// Lambda entry of `ToolAccount` (docs/architecture.md §9.2): infra points the function at `handler`.
// The core is the one linked into the Lambda, resolved on the first call, never at import.
import { lambdaEntry } from "../common/deps";
import type { GatewayTargetRuntime, ToolDeps } from "../common/handler";
import { productionCore } from "./core";
import { productionOwnership } from "./ownership";
import { createAccountTarget } from "./target";

/** The target over the linked core (the worker's preload in the stage). */
export function stageAccountTarget(deps: ToolDeps): GatewayTargetRuntime {
  return createAccountTarget(deps, { core: productionCore });
}

export const handler = lambdaEntry(stageAccountTarget, productionOwnership);
