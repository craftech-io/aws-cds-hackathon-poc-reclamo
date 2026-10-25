// The definitions of the 28 Gateway tools by target, in the order of `GATEWAY_TOOLS`: what the Gateway
// payloads are generated from (gateway-schema.ts) and what the tests walk. Pure, like the schemas: the
// SST program loads it.
import { ACCOUNT_TOOLS } from "../account/schema";
import { ACTIONS_TOOLS } from "../actions/schema";
import { COMPLAINTS_TOOLS } from "../complaints/schema";
import { HANDOFF_TOOLS } from "../handoff/schema";
import { IDENTITY_TOOLS } from "../identity/schema";
import { INVESTIGATION_TOOLS } from "../investigation/schema";
import { MESSAGING_TOOLS } from "../messaging/schema";
import type { ToolDefinition } from "./define";
import { GATEWAY_TOOLS, ToolTarget } from "./targets";

export const TOOL_DEFINITIONS = {
  identity: IDENTITY_TOOLS,
  account: ACCOUNT_TOOLS,
  investigation: INVESTIGATION_TOOLS,
  actions: ACTIONS_TOOLS,
  complaints: COMPLAINTS_TOOLS,
  messaging: MESSAGING_TOOLS,
  handoff: HANDOFF_TOOLS,
} as const satisfies { readonly [T in ToolTarget]: { readonly [K in (typeof GATEWAY_TOOLS)[T][number]]: ToolDefinition<K> } };

/** The definitions of a target in `GATEWAY_TOOLS` order. */
export function definitionsOf(target: ToolTarget): readonly ToolDefinition[] {
  const tools: Readonly<Record<string, ToolDefinition>> = TOOL_DEFINITIONS[target];
  return GATEWAY_TOOLS[target].map((tool) => {
    const definition = tools[tool];
    if (definition === undefined) throw new Error(`no definition for ${target}___${tool}`);
    return definition;
  });
}

/** Every definition, target by target. */
export function allDefinitions(): readonly { readonly target: ToolTarget; readonly definition: ToolDefinition }[] {
  return ToolTarget.options.flatMap((target) => definitionsOf(target).map((definition) => ({ target, definition })));
}
