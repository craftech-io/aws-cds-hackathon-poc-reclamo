import { describe, expect, it } from "vitest";
import { WorldId, guestOriginOf, mayRunLive, worldKeyPrefix, worldKindOf } from "./world-kind";

describe("worldKindOf", () => {
  it("derives the class of every world of docs/architecture.md §10 from its id only", () => {
    expect(worldKindOf("demo")).toBe("DEMO");
    for (const id of ["g01", "g15", "g99", "gtest", "gprobe", "gs-abcdefgh27"]) expect(worldKindOf(id), id).toBe("GUEST");
    for (const id of ["qamin", "qa-r7k2-sc01", "qa-live-r7k2", "qa-r7k2-sc22j"]) expect(worldKindOf(id), id).toBe("QA");
    expect(worldKindOf("sim-001")).toBe("SIM");
  });

  it("refuses anything else, including look-alikes of another class", () => {
    for (const id of ["", "Demo", "demo2", "g1", "g100", "guest-01", "gs-", "gs-abcdefgh2", "gs-abcdefgh271", "gs-ABCDEFGH27", "gs-abcdefgh18", "qa", "qa-", "qa_x", "sim", "sim-", "W#demo", "qa-x".padEnd(49, "x")]) {
      expect(worldKindOf(id), id).toBeUndefined();
      expect(WorldId.safeParse(id).success, id).toBe(false);
    }
  });
});

describe("guestOriginOf", () => {
  it("tells a pre-provisioned guest world from a self-signup one, by id only", () => {
    for (const id of ["g01", "g99", "gtest", "gprobe"]) expect(guestOriginOf(id), id).toBe("INVITED");
    expect(guestOriginOf("gs-abcdefgh27")).toBe("SIGNUP");
    for (const id of ["demo", "qamin", "qa-r7k2-sc01", "sim-001", "g100", "gs-abc", "guest-01"]) expect(guestOriginOf(id), id).toBeUndefined();
  });
});

describe("mayRunLive and worldKeyPrefix", () => {
  it("allows live WhatsApp only in demo and the QA live worlds", () => {
    expect(mayRunLive("demo")).toBe(true);
    expect(mayRunLive("qa-live-r7k2")).toBe(true);
    for (const id of ["g01", "gtest", "gprobe", "gs-abcdefgh27", "qamin", "qa-r7k2-sc01", "sim-001"]) expect(mayRunLive(id), id).toBe(false);
  });

  it("prefixes every key of a world", () => {
    expect(worldKeyPrefix("g03")).toBe("W#g03#");
  });
});
