// Arguments of `seed:load` (docs/seed-spec.md §15). CI runs it with none (`npm run seed:load`, inside
// `sst shell --stage poc`); an operator may pass `--force` to rebuild the seed worlds, and `--stage poc`
// is accepted for the documented form. Anything else stops before a single write.
import { parseFlags } from "../../channels/cli-args";

export interface LoadArgs {
  readonly force: boolean;
}

export const USAGE = "usage: npm run seed:load [-- --stage poc] [--force]";

export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  let force = false;
  parseFlags(argv, {
    "--force": () => {
      force = true;
    },
    "--stage": (value) => {
      if (value() !== "poc") throw new RangeError("seed:load runs only against the stage poc");
    },
  });
  return { force };
}
