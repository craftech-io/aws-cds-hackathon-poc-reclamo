// The agent's runtime kill switch (docs/architecture.md §13, ADR-0017, FL-109): `Runtime/KILL#AGENT`
// (every world) and `Runtime/W#<w>#KILL` (one world), read strongly consistent before every turn, before
// the caps, G1 and the Harness. A `SUPERVISOR` of `demo` (`ops.setAgentKill`), the QaDriver for its own
// worlds (`kill.setWorld`) or `BudgetBreaker` at 100 % of the budget turn it on, without a deploy. While
// it is on no turn runs and nothing calls Bedrock from the worker: the complaint number and the
// acknowledgement already went out by rules, and the customer gets the handoff notice and a person.
// `CED-KILL-SWITCH` in Cedar is the second layer, by IaC.
import type { Connector } from "../connector/port";

export type KillScope = "GLOBAL" | "WORLD";

/** Which switch cuts the agent for this world, or `undefined` when none does. */
export async function agentKillScope(data: Pick<Connector, "runtime">, worldId: string): Promise<KillScope | undefined> {
  const [global, world] = await Promise.all([data.runtime.getKill(), data.runtime.getKill(worldId)]);
  if (global !== undefined) return "GLOBAL";
  return world === undefined ? undefined : "WORLD";
}

/** `AgentKilled`: the metric filter of the alarm (docs/architecture.md §12). */
export const AGENT_KILLED_METRIC = "AgentKilled";
