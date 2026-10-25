import { describe, expect, it } from "vitest";
import { matchPath } from "./match-path";

describe("matchPath", () => {
  it("matches static paths ignoring trailing slashes", () => {
    expect(matchPath("/", "/")).toEqual({});
    expect(matchPath("/cases", "/cases/")).toEqual({});
    expect(matchPath("/cases", "/")).toBeUndefined();
  });

  it("extracts and decodes params", () => {
    expect(matchPath("/cases/:id", "/cases/case-a%20b")).toEqual({ id: "case-a b" });
    expect(matchPath("/cases/:id", "/cases")).toBeUndefined();
    expect(matchPath("/cases/:id", "/cases/x/y")).toBeUndefined();
  });
});
