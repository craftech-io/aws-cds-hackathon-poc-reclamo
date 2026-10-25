// Keys, retention and the codec: every world key starts with `W#<worldId>#`, no id escapes its
// segment, sort keys order by UTC, TTLs follow docs/architecture.md §5, and a row is stripped of its
// storage attributes before its schema parses it.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@reclamo/shared";
import { Staff } from "../domain/world";
import { decode, encode } from "./codec";
import { keys, paddedSeq, segment, sortInstant, worldIndexAttributes, worldKey } from "./keys";
import { STORAGE_ATTRIBUTES } from "./tables";
import { expiry, retentionSeconds } from "./ttl";

const DAY = 86_400;

describe("keys", () => {
  it("puts every world key under W#<worldId>#", () => {
    const worldKeys = [
      keys.worldMeta("demo").pk,
      keys.staff("g01", "stf-guest-01").pk,
      keys.complaint("qa-r1-sc01", "cmp-1").pk,
      keys.register("demo", 1, 1).pk,
      keys.refund("demo", 1, 1).pk,
      keys.tape("demo", "2026-10-07", "2026-10-07T10:10:00-03:00", "t1").pk,
      keys.audit("demo", 2, "2026-10-07T13:10:00Z", "a1").pk,
      keys.timer("demo", "SLA", "x").pk,
      keys.conversation("demo", "cus-0001").pk,
      keys.counter("demo", "EPOCH").pk,
      keys.pending("demo", "MAIL", "m1").pk,
      keys.turnResult("demo", "turn-1", "get_loan", 1).pk,
      keys.metric("demo", "WORLD", "run-1", "cmp-1").pk,
    ];
    for (const key of worldKeys) expect(key).toMatch(/^W#(demo|g01|qa-r1-sc01)#/);
    expect(keys.global("KILL", "AGENT").pk).toBe("KILL#AGENT");
    expect(keys.reference("HOLIDAY", "AR", "2026-10-12")).toEqual({ pk: "REF#HOLIDAY#AR", sk: "2026-10-12" });
  });

  it("refuses a world id that is not one and an id that could escape its segment", () => {
    for (const worldId of ["", "Demo", "demo#x", "g100", "qa-", "other"]) expect(() => worldKey(worldId, "WORLD"), worldId).toThrow(ConnectorError);
    for (const id of ["", "a#b", "a/b", "a b", "#", "-x", "x\n"]) expect(() => segment(id, "id"), JSON.stringify(id)).toThrow(ConnectorError);
    expect(segment("NTE-20261006-004817-7", "code")).toBe("NTE-20261006-004817-7");
    expect(segment("wamid.HBgNNTQ5MTEwMDAwMTAwMRUCABIYFjNFQjA=", "id")).toMatch(/^wamid/);
  });

  it("orders instants as UTC strings whatever offset they were written with, and pads sequence numbers", () => {
    expect(sortInstant("2026-10-07T23:30:00-03:00")).toBe("2026-10-08T02:30:00.000Z");
    expect(sortInstant("2026-10-08T01:00:00Z") < sortInstant("2026-10-07T23:30:00-03:00")).toBe(true);
    expect(() => sortInstant("yesterday")).toThrow(ConnectorError);
    expect(paddedSeq(42)).toBe("000000042");
    expect(() => paddedSeq(0)).toThrow(ConnectorError);
    expect(keys.audit("demo", 1, "2026-10-31T23:30:00-03:00", "a1")).toEqual({ pk: "W#demo#AUD#e1#2026-11", sk: "2026-11-01T02:30:00.000Z#a1" });
    expect(worldIndexAttributes("demo", { pk: "W#demo#CMP#c1", sk: "META" })).toEqual({ worldIndexKey: "W#demo#", worldIndexSort: "W#demo#CMP#c1|META" });
  });
});

describe("retention", () => {
  const now = new Date("2026-10-07T13:10:00Z");
  const base = now.getTime() / 1000;

  it("fixes append-only expiry by world class at write time", () => {
    expect(retentionSeconds("register", "demo")).toBe(180 * DAY);
    expect(retentionSeconds("register", "g05")).toBe(30 * DAY);
    expect(retentionSeconds("register", "qa-r1-sc01")).toBe(2 * DAY);
    expect(retentionSeconds("audit", "demo")).toBe(365 * DAY);
    expect(retentionSeconds("audit", "sim-001")).toBe(2 * DAY);
  });

  it("keeps demo world rows, bounds guest rows, and expires QA rows in two days", () => {
    expect(expiry("world", "demo", now)).toEqual({});
    expect(expiry("world", "gtest", now)).toEqual({ expiresAt: base + 90 * DAY });
    expect(expiry("complaint", "qamin", now)).toEqual({ expiresAt: base + 2 * DAY });
    expect(expiry("timer", "g01", now)).toEqual({});
    expect(expiry("conversation", "demo", now)).toEqual({ expiresAt: base + 90 * DAY });
    expect(expiry("worldRuntime", "demo", now)).toEqual({});
  });

  it("uses the fixed real-time TTLs of Runtime items", () => {
    expect(expiry("session", "demo", now)).toEqual({ expiresAt: base + 3_600 });
    expect(expiry("nonce", "demo", now)).toEqual({ expiresAt: base + 7 * DAY });
    expect(expiry("cap", undefined, now)).toEqual({ expiresAt: base + 2 * DAY });
    expect(expiry("purgeTicket", "g01", now)).toEqual({ expiresAt: base + 3_600 });
    expect(expiry("resetTicket", "g01", now)).toEqual({ expiresAt: base + 7 * DAY });
    expect(expiry("lease", undefined, now)).toEqual({ expiresAt: base + 2 * 3_600 });
    expect(expiry("challenge", "demo", now)).toEqual({ expiresAt: base + DAY });
  });
});

describe("codec", () => {
  it("adds and strips the storage attributes around a domain value", () => {
    const staff = { worldId: "demo", staffId: "stf-lucia", role: "OPERATOR", displayName: "Lucía", cognitoSubKey: "SUB#abc", active: true, version: 1 };
    const item = encode(staff, { entity: "Staff", key: keys.staff("demo", "stf-lucia"), worldId: "demo", retention: "world", now: new Date("2026-10-07T13:10:00Z"), indexes: { unused: undefined } });
    expect(item).toMatchObject({ pk: "W#demo#WORLD", sk: "STAFF#stf-lucia", entity: "Staff", createdAt: "2026-10-07T13:10:00.000Z", updatedAt: "2026-10-07T13:10:00.000Z" });
    expect("unused" in item).toBe(false);
    const decoded = decode(Staff, item, "Worlds");
    expect(decoded).toMatchObject({ staffId: "stf-lucia", cognitoSubKey: "SUB#abc" });
    for (const attribute of ["pk", "sk", "entity", "expiresAt"]) expect(Object.keys(decoded)).not.toContain(attribute);
    expect(STORAGE_ATTRIBUTES.has("cognitoSubKey")).toBe(false);
    expect(STORAGE_ATTRIBUTES.has("inboxKey")).toBe(true);
  });
});
