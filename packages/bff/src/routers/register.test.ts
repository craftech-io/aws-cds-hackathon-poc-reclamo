// `register.*` (FL-096, ADR-0014): the register of the principal's world verified against its anchors
// (`ok`, `partial`, `broken`), and the export a third party re-verifies without the stage.
import { beforeEach, describe, expect, it } from "vitest";
import { exitCodeOf, verifyExport } from "../../../../scripts/register/verify";
import { csvCell, parseCsv, toCsv, unguard } from "./csv";
import { COMPLIANCE, type ConsoleRig, GUEST, OPERATOR, consoleRig } from "./testing";

const FILED = { eventType: "FILED", atSim: "2026-10-07T10:10:05-03:00", complaintId: "cmp-0001", complaintNumber: "R-2026-000123", kind: "RECLAMO", type: "PAYMENT_NOT_REFLECTED", channel: "WHATSAPP", origin: "LIVE" } as const;

function entry(seq: number, extra: Record<string, unknown> = {}) {
  return { ...FILED, eventType: seq === 1 ? "FILED" : "STATUS", reason: `step-${seq}`, ...extra } as typeof FILED & { reason: string };
}

let rig: ConsoleRig;

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("demo");
  await rig.seedWorld("g03");
  for (const seq of [1, 2, 3]) await rig.append("REG", "demo", entry(seq));
});

describe("register.verify [FL-096]", () => {
  it("[FL-096] answers ok when every entry has its first ingested anchor, and audits REGISTER_VERIFIED", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const result = await caller.register.verify();
    expect(result).toMatchObject({ chain: "REG", epoch: 1, result: "ok", entries: 3, unanchored: [], anchorConflicts: [], brokenAt: null });
    const audits = await rig.connector.audit.listByAction("demo", "REGISTER_VERIFIED");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ refs: { chain: "REG", result: "ok" }, actor: "OPERATOR:stf-compliance-01" });
  });

  it("[FL-096] answers partial with the seq that has no anchor, never ok", async () => {
    await rig.append("REG", "demo", entry(4), { anchor: false });
    const { caller } = await rig.as(OPERATOR);
    expect(await caller.register.verify({ chain: "REG" })).toMatchObject({ result: "partial", unanchored: [4], brokenAt: null });
  });

  it("[FL-096] detects an overwrite of an anchored entry (an unconditional PutItem) as broken at its seq", async () => {
    const items = rig.store.dump("Register");
    const second = items.find((item) => item.seq === 2);
    if (!second) throw new Error("seed");
    rig.store.load("Register", [{ ...second, reason: "rewritten" }]);
    const { caller } = await rig.as(OPERATOR);
    expect(await caller.register.verify()).toMatchObject({ result: "broken", brokenAt: 2 });
    expect(rig.lines.some((line) => line.includes('"metric":"ChainBroken"'))).toBe(true);
  });

  it("verifies the refund register and the tape on request, each against its own stream", async () => {
    const { caller } = await rig.as(OPERATOR);
    expect(await caller.register.verify({ chain: "RRI" })).toMatchObject({ chain: "RRI", result: "ok", entries: 0 });
    expect(await caller.register.verify({ chain: "TAPE" })).toMatchObject({ chain: "TAPE", entries: 0 });
  });
});

describe("register.list", () => {
  it("lists the entries of the current epoch in seq order, by page or by complaint number", async () => {
    const { caller } = await rig.as(GUEST);
    expect((await caller.register.list()).entries).toEqual([]);
    const operator = (await rig.as(OPERATOR)).caller;
    const page = await operator.register.list({ limit: 2 });
    expect(page.entries.map((item) => item.seq)).toEqual([1, 2]);
    expect(page.cursor).not.toBeNull();
    const next = await operator.register.list({ limit: 2, cursor: page.cursor ?? undefined });
    expect(next.entries.map((item) => item.seq)).toEqual([3]);
    expect((await operator.register.list({ complaintNumber: "R-2026-000123" })).entries).toHaveLength(3);
    expect((await operator.register.list({ chain: "RRI" })).entries).toEqual([]);
  });

  it("refuses keys it does not know", async () => {
    const { caller } = await rig.as(OPERATOR);
    await expect(caller.register.list({ worldId: "g03" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("CSV cells of every export", () => {
  it("[FL-096] puts a single quote before =, +, -, @, a tab or a CR and quotes what needs it", () => {
    expect(["=1+1", "+54", "-2", "@cmd", "\tx", "\rx", "plain", 'say "hi", ok'].map(csvCell)).toEqual(["'=1+1", "'+54", "'-2", "'@cmd", "'\tx", "\"'\rx\"", "plain", '"say ""hi"", ok"']);
    expect(parseCsv(toCsv(["a", "b"], [["=x", 'q"x\r\ny']])).map((row) => row.map(unguard))).toEqual([["a", "b"], ["=x", 'q"x\r\ny']]);
  });
});

describe("register.export [FL-096]", () => {
  it("[FL-096] verifies first and writes CSV, JSON and .sha256 under the world's root, with result, head hash, key and anchors in the header", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const result = await caller.register.export();
    expect(result).toMatchObject({ result: "ok", entries: 3 });
    for (const file of [result.files.csv, result.files.json, result.files.sha256]) {
      expect(file.key.startsWith("W/demo/register/")).toBe(true);
      expect(rig.exports.objects.has(file.key)).toBe(true);
      expect(file.url).toContain("expires=300");
    }
    const json = JSON.parse(rig.exports.objects.get(result.files.json.key)?.body ?? "{}") as { header: Record<string, unknown>; anchors: { ingestionTime: number; stream: string }[] };
    expect(json.header).toMatchObject({ result: "ok", chain: "REG", worldId: "demo", epoch: 1, unanchored: [], key: expect.any(String) });
    expect(json.header.headHash).toBe(result.headHash);
    expect(json.anchors).toHaveLength(3);
    expect(json.anchors.every((anchor) => anchor.stream === "demo-e1-REG" && anchor.ingestionTime > 0)).toBe(true);
    const audits = await rig.connector.audit.listByAction("demo", "REGISTER_EXPORTED");
    expect(audits[0]?.refs).toMatchObject({ chain: "REG", result: "ok", key: result.files.csv.key });
  });

  it("[FL-096] guards every cell that starts like a formula, and the file still verifies independently", async () => {
    await rig.append("REG", "demo", entry(4, { reason: "=HYPERLINK(\"http://example.test\",\"x\")" }));
    await rig.append("REG", "demo", entry(5, { reason: "+1-555 @here\tdone" }));
    const { caller } = await rig.as(OPERATOR);
    const { files } = await caller.register.export();
    const csv = rig.exports.objects.get(files.csv.key)?.body ?? "";
    const cells = parseCsv(csv).flat();
    expect(cells.some((cell) => /^[=+\-@\t\r]/.test(cell))).toBe(false);
    expect(cells).toContain("'=HYPERLINK(\"http://example.test\",\"x\")");
    expect(cells).toContain("'+1-555 @here\tdone");
    for (const key of [files.csv.key, files.json.key]) {
      const report = verifyExport(rig.exports.objects.get(key)?.body ?? "");
      expect(report).toMatchObject({ recomputed: "ok", declared: "ok", consistent: true, entries: 5 });
      expect(exitCodeOf(report, undefined)).toBe(0);
    }
  });

  it("[FL-096] exports a partial register as partial with the unanchored seq in the header", async () => {
    await rig.append("REG", "demo", entry(4), { anchor: false });
    const { caller } = await rig.as(OPERATOR);
    const { files, result } = await caller.register.export();
    expect(result).toBe("partial");
    const report = verifyExport(rig.exports.objects.get(files.json.key)?.body ?? "");
    expect(report).toMatchObject({ recomputed: "partial", unanchored: [4], consistent: true });
  });

  it("exports only the principal's world", async () => {
    await rig.append("REG", "g03", entry(1));
    const { caller } = await rig.as(GUEST);
    const result = await caller.register.export();
    expect(result.entries).toBe(1);
    expect(result.files.csv.key.startsWith("W/g03/register/")).toBe(true);
  });
});
