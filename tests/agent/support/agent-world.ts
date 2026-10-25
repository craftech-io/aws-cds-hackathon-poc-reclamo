// The agent tests of Reclamo en regla (tests/agent, run by `agent-test run`): the local flow world of
// tests/flows (seed, fakes, clock, the stage's entries and worker, the Gateway with the stage's Cedar
// statements in front of the tool targets) with the kit's model-backed Harness in place of the scripted
// one. Only the model differs (Qwen on Ollama by default, USD 0). The worker builds the same request it
// sends to AgentCore — the turn's system prompt, the envelope with the preloaded reads of turns/preload.ts
// (identify_customer always; get_account and list_operations once identified) — and the stream is read
// by the production reader. Tool schemas, limits and the default prompt are imported from what infra
// deploys, never copied. The folder is outside `npm test`, the root tsconfig and CI.
//
// The input classifier, the receipt reader and the guardrails G1/G2 stay the flow world's fakes (the
// evaluation sets and a G2 that passes): what is under test here is the agent's own behaviour. The
// deterministic verification of the gate (VERIFY), the channel policy and every Lambda fence still run.
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { type AgentTestEnv, type CallTool, type LocalHarness, type LocalTurn, type ToolSpec, createLocalHarness, fromEnv } from "@craftech/agent-testkit";
import { type HarnessClient, type HarnessLink, harnessRequest, readHarnessStream } from "@reclamo/bff/agent/harness-client";
import { DEFAULT_SYSTEM_PROMPT } from "@reclamo/bff/agent/system-prompt";
import { GATEWAY_TOOL_SEPARATOR, ToolTarget, gatewayActionOf } from "@reclamo/bff/agent-tools/common/targets";
import { expect } from "vitest";
import { gatewayToolSchemas } from "../../../infra/agent-tool-schemas";
import { HARNESS_ENDPOINT_NAME, HARNESS_LIMITS } from "../../../infra/agentcore-spec";
import type { LocalGateway } from "../../flows/support/gateway";
import { type FlowWorld, type FlowWorldOptions, createFlowWorld } from "../../flows/support/world";

/** The Gateway's tools as the model sees them: `<target>___<tool>`, with the deployed inline schema. */
export const AGENT_TOOLS: readonly ToolSpec[] = ToolTarget.options.flatMap((target) =>
  gatewayToolSchemas[target].inlinePayload.map((tool) => ({ name: gatewayActionOf(target, tool.name), description: tool.description, inputSchema: tool.inputSchema as unknown as ToolSpec["inputSchema"] })),
);

/** The tool name without its target prefix. */
export const bareTool = (name: string): string => name.split(GATEWAY_TOOL_SEPARATOR).at(-1) ?? name;

/** One tool call through the world's Gateway: Cedar first; a DENY reaches the model as an error result. */
export function gatewayCaller(gateway: LocalGateway): CallTool {
  return async (name, input) => {
    const answer = await gateway.call(bareTool(name), input);
    if (answer.kind === "DENIED") return { status: "error", output: { error: "AccessDeniedException", policies: answer.determining } };
    if (answer.kind === "UNKNOWN_TOOL") return { status: "error", output: { error: "UnknownToolException", tool: name } };
    return { status: "success", output: answer.response };
  };
}

/**
 * The `Resource.Harness` link of a local world. No `timeoutSeconds` reaches the local loop: a local model
 * is slower than Bedrock, and a wall-clock cut would test the machine, not the agent.
 */
const LOCAL_LINK: HarnessLink = {
  harnessArn: "arn:aws:bedrock-agentcore:us-east-1:776805327629:harness/aws-cds-hackathon-poc-reclamo-poc-local",
  endpointName: HARNESS_ENDPOINT_NAME,
  timeoutSeconds: HARNESS_LIMITS.timeoutSeconds,
  maxIterations: HARNESS_LIMITS.maxIterations,
};

/** The worker's Harness client over the kit's Harness: the production request, read by the production reader. */
function localHarnessClient(agent: LocalHarness): HarnessClient {
  return {
    async invoke(request) {
      const { timeoutSeconds: _ignored, ...input } = harnessRequest(LOCAL_LINK, request);
      const { stream } = await agent.invoke(input);
      return { ...(await readHarnessStream(stream as AsyncIterable<InvokeHarnessStreamOutput>)), attempts: 1 };
    },
  };
}

/** The run's model, budget and recorder (`agent-test run --model …`); `undefined` on a scripted run. */
export const AGENT_ENV: AgentTestEnv | undefined = fromEnv({ label: () => expect.getState().currentTestName });

/** `describe.skipIf(SCRIPTED_RUN)`: these tests need a model, the scripted versions are tests/flows. */
export const SCRIPTED_RUN = AGENT_ENV === undefined;

export interface AgentWorld {
  readonly flow: FlowWorld;
  readonly agent: LocalHarness;
}

/** A fresh local world whose Harness is the run's model. */
export async function openAgentWorld(options: Omit<FlowWorldOptions, "agent" | "plans"> = {}): Promise<AgentWorld> {
  const env = AGENT_ENV;
  if (env === undefined) throw new Error("tests/agent need a model: run them with `agent-test run` (qwen by default).");
  let agent: LocalHarness | undefined;
  const flow = await createFlowWorld({
    ...options,
    agent: (gateway) => {
      agent = createLocalHarness({
        model: env.model,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        callTool: gatewayCaller(gateway),
        limits: { maxIterations: HARNESS_LIMITS.maxIterations, maxTokens: HARNESS_LIMITS.maxTokens, slidingWindowMessages: HARNESS_LIMITS.slidingWindowMessages },
        budget: env.budget,
        temperature: 0,
        ...(env.recorder === undefined ? {} : { recorder: env.recorder }),
      });
      return localHarnessClient(agent);
    },
  });
  if (agent === undefined) throw new Error("the world did not build its Harness");
  return { flow, agent };
}

/** Names of the tools the turns called, without the target prefix. */
export const toolsOf = (turns: readonly Pick<LocalTurn, "calls">[]): string[] => turns.flatMap((turn) => turn.calls.map((call) => bareTool(call.name)));

/** The calls of one tool across the turns, in order. */
export const callsOf = (turns: readonly Pick<LocalTurn, "calls">[], tool: string): LocalTurn["calls"][number][] => turns.flatMap((turn) => turn.calls.filter((call) => bareTool(call.name) === tool));

const answeredOk = (call: LocalTurn["calls"][number]): boolean => call.status === "success" && (call.output as { ok?: unknown } | null)?.ok === true;

/** The calls of `tool` that the target answered `ok`, in order. */
export const okCallsOf = (turns: readonly Pick<LocalTurn, "calls">[], tool: string): LocalTurn["calls"][number][] => callsOf(turns, tool).filter(answeredOk);

/**
 * Every successful result of `tool`, in order. An oracle that asks whether some call answered a fact
 * reads these, never the last one: a model that checks two charges may check the one that matters first.
 */
export const okResultsOf = (turns: readonly Pick<LocalTurn, "calls">[], tool: string): Readonly<Record<string, unknown>>[] =>
  okCallsOf(turns, tool).map((call) => call.output as Readonly<Record<string, unknown>>);

/** The successful result of the last call of `tool` that the target answered `ok`, if any. */
export const okResultOf = (turns: readonly Pick<LocalTurn, "calls">[], tool: string): Readonly<Record<string, unknown>> | undefined => okResultsOf(turns, tool).at(-1);

/**
 * The `send_whatsapp` calls of the turns whose message left (or will leave by itself): the gate answered
 * `ok` with `ALLOWED` or `DEFERRED` and it is not a replay of a message already sent. The kit marks every
 * answered call `success`, a refusal included, so the call status alone never says a message went out.
 */
export function sentWhatsAppCalls(turns: readonly Pick<LocalTurn, "calls">[]): LocalTurn["calls"][number][] {
  return callsOf(turns, "send_whatsapp").filter((call) => {
    const output = call.output as { ok?: unknown; decision?: unknown; replayOf?: unknown } | null;
    return call.status === "success" && output?.ok === true && (output.decision === "ALLOWED" || output.decision === "DEFERRED") && output.replayOf === undefined;
  });
}

/** The error code a target answered for the calls of `tool` (`ABOVE_CAP`, `NOT_ELIGIBLE`…). */
export const errorCodesOf = (turns: readonly Pick<LocalTurn, "calls">[], tool: string): string[] =>
  callsOf(turns, tool).flatMap((call) => {
    const code = (call.output as { ok?: unknown; error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" ? [code] : [];
  });

/** One line per turn for a failure message: stop reason and tools. */
export const turnsSummary = (turns: readonly LocalTurn[]): string => turns.map((turn, index) => `#${index + 1} ${turn.stopReason}: ${turn.calls.map((call) => `${bareTool(call.name)}${call.status === "error" ? "!" : ""}`).join(",") || "-"}`).join(" | ");
