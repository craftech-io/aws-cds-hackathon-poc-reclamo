// What every world route works with once the caller and the world are known: the world's network
// configuration, its faults and the simulated instant of the request (`X-Sim-Now`).
import type { Fault } from "./faults";
import type { NetworkWorld } from "./store/items";

export interface WorldContext {
  readonly worldId: string;
  /** The world's simulated instant the caller read from its clock; the mock never reads a clock. */
  readonly simNow: string;
  readonly world: NetworkWorld;
  readonly faults: readonly Fault[];
}
