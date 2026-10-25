import { describe, expect, it } from "vitest";
import { parseFlags } from "./cli-args";

describe("parseFlags", () => {
  it("hands each flag its value and repeats a flag as often as it is given", () => {
    const worlds: string[] = [];
    let apply = false;
    parseFlags(["--world", "g01", "--apply", "--world", "g02"], {
      "--world": (value) => {
        worlds.push(value());
      },
      "--apply": () => {
        apply = true;
      },
    });
    expect(worlds).toEqual(["g01", "g02"]);
    expect(apply).toBe(true);
  });

  it("refuses a flag without its value and a flag it does not know", () => {
    const handlers = { "--stage": (value: () => string) => void value() };
    expect(() => parseFlags(["--stage"], handlers)).toThrow('--stage needs a value');
    expect(() => parseFlags(["--stage", "--apply"], handlers)).toThrow('--stage needs a value');
    expect(() => parseFlags(["--stag", "poc"], handlers)).toThrow('unknown argument "--stag"');
    expect(() => parseFlags(["toString"], handlers)).toThrow('unknown argument "toString"');
  });
});
