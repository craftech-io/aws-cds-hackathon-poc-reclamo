// The `account` target as the worker's preload, the local flows and the tests build it: the seven
// tools behind `createToolHandler` over the core they are given. The deployed entry (handler.ts) passes
// the core linked into `ToolAccount`.
import type { Implementations } from "../common/context";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import type { CorePort } from "./core";
import { accountReads } from "./reads";
import { ACCOUNT_TOOLS } from "./schema";
import { getFeeRules, getTerms } from "./terms";

export interface AccountPorts {
  readonly core: CorePort;
}

export function accountImplementations(ports: AccountPorts): Implementations<typeof ACCOUNT_TOOLS> {
  return { ...accountReads(ports.core), get_fee_rules: getFeeRules, get_terms: getTerms };
}

export function createAccountTarget(deps: ToolDeps, ports: AccountPorts): GatewayTargetRuntime {
  return createToolHandler({ target: "account", tools: ACCOUNT_TOOLS, implementations: accountImplementations(ports) }, deps);
}
