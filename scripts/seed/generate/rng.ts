// Seeded PRNG of the generator (sfc32 seeded by splitmix32): the same seed gives the same sequence on
// every machine and Node version, because it only uses 32-bit integer arithmetic. Each part of the
// seed forks its own stream by name, so adding a draw in one part never shifts another part's data.
import { SEED } from "../lib/constants";

function splitmix32(state: number): () => number {
  let value = state >>> 0;
  return () => {
    value = (value + 0x9e3779b9) >>> 0;
    let z = value;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max], both included. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** Standard normal (Box-Muller), for the receipts' noise. */
  normal(): number;
}

/** The stream of one part of the seed (`payers`, `receipt:eval-legible-03`, `history`). */
export function rngFor(name: string, seed: number = SEED): Rng {
  const init = splitmix32((seed ^ hashName(name)) >>> 0);
  let a = init();
  let b = init();
  let c = init();
  let d = init();
  const raw = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let index = 0; index < 12; index += 1) raw();
  const next = (): number => raw() / 4294967296;
  return {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError(`invalid range ${min}..${max}`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new RangeError("cannot pick from nothing");
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    shuffle(items) {
      const out = [...items];
      for (let index = out.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [out[index], out[other]] = [out[other] as (typeof out)[number], out[index] as (typeof out)[number]];
      }
      return out;
    },
    normal() {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}
