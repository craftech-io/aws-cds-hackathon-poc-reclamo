// `npm run register:verify` (FL-096, ADR-0014): an export re-verified without the stage, with the rules
// of the console (first ingested anchor, conflicts, `partial` for an entry without anchor), the header
// checked against the recomputation and the `.sha256` manifest checked against the file.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type ConsoleRig, OPERATOR, consoleRig } from "../../packages/bff/src/routers/testing";
import { checkManifest, parseVerifyArgs, run, verifyExport } from "./verify";

const ENTRY = { atSim: "2026-10-07T10:10:05-03:00", complaintId: "cmp-0001", complaintNumber: "R-2026-000123", kind: "RECLAMO", type: "PAYMENT_NOT_REFLECTED", channel: "WHATSAPP", origin: "LIVE" } as const;

let rig: ConsoleRig;

async function exported(): Promise<{ csv: string; json: string; manifest: string; base: string }> {
  const { caller } = await rig.as(OPERATOR);
  const { files } = await caller.register.export();
  const body = (key: string) => rig.exports.objects.get(key)?.body ?? "";
  return { csv: body(files.csv.key), json: body(files.json.key), manifest: body(files.sha256.key), base: files.csv.key.slice(files.csv.key.lastIndexOf("/") + 1, -".csv".length) };
}

/** Writes the export as the operator downloaded it: `<base>.csv`, `<base>.json`, `<base>.sha256`. */
function onDisk(files: { csv: string; json: string; manifest: string; base: string }): { dir: string; csv: string; json: string } {
  const dir = mkdtempSync(join(tmpdir(), "register-verify-"));
  const csv = join(dir, `${files.base}.csv`);
  const json = join(dir, `${files.base}.json`);
  writeFileSync(csv, files.csv);
  writeFileSync(json, files.json);
  writeFileSync(join(dir, `${files.base}.sha256`), files.manifest);
  return { dir, csv, json };
}

function runQuiet(argv: string[]): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = run(argv, (line) => void lines.push(line));
  return { code, lines };
}

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("demo");
  await rig.append("REG", "demo", { ...ENTRY, eventType: "FILED" });
  await rig.append("REG", "demo", { ...ENTRY, eventType: "STATUS", status: "INVESTIGATING", reason: "=SUM(A1)" });
  await rig.append("REG", "demo", { ...ENTRY, eventType: "FINAL_ANSWER", bodySha256: "b".repeat(64) });
});

describe("register:verify [FL-096]", () => {
  it("[FL-096] verifies both forms of an export ok, with its .sha256, and never prints the key", async () => {
    const files = await exported();
    const paths = onDisk(files);
    for (const path of [paths.csv, paths.json]) {
      const { code, lines } = runQuiet([path]);
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("result: ok (declared: ok) · header consistent");
      expect(lines.join("\n")).toContain("sha256 manifest: matches");
      expect(lines.join("\n")).not.toContain(JSON.parse(files.json).header.key as string);
    }
  });

  it("[FL-096] finds an entry changed after the export as broken, and the header no longer consistent", async () => {
    const files = await exported();
    const file = JSON.parse(files.json) as { entries: Record<string, unknown>[] };
    const [, second] = file.entries;
    if (!second) throw new Error("seed");
    second.reason = "rewritten";
    const report = verifyExport(JSON.stringify(file));
    expect(report).toMatchObject({ recomputed: "broken", brokenAt: 2, declared: "ok", consistent: false });
    const paths = onDisk({ ...files, json: JSON.stringify(file) });
    const { code, lines } = runQuiet([paths.json]);
    expect(code).toBe(1);
    expect(lines).toContain("sha256 manifest: DOES NOT MATCH");
  });

  it("[FL-096] refuses a header that claims more than the anchors prove", async () => {
    const files = await exported();
    const file = JSON.parse(files.json) as { anchors: unknown[] };
    file.anchors.pop();
    const report = verifyExport(JSON.stringify(file));
    expect(report).toMatchObject({ recomputed: "partial", declared: "ok", unanchored: [3], consistent: false });
  });

  it("[FL-096] answers 3 for a partial export that says so", async () => {
    await rig.append("REG", "demo", { ...ENTRY, eventType: "DELIVERY_PROOF" }, { anchor: false });
    const paths = onDisk(await exported());
    const { code, lines } = runQuiet([paths.csv]);
    expect(code).toBe(3);
    expect(lines.join("\n")).toContain("without anchor (unverified): seq 4");
  });

  it("answers 2 for anything that is not an export, and checks a manifest only for the file it names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "register-verify-"));
    const junk = join(dir, "junk.csv");
    writeFileSync(junk, "a,b\r\n1,2\r\n");
    expect(runQuiet([junk]).code).toBe(2);
    expect(runQuiet([]).code).toBe(2);
    expect(checkManifest(`${"0".repeat(64)}  other.csv\n`, "mine.csv", "x")).toBeUndefined();
    expect(parseVerifyArgs(["f.json", "--sha256", "f.sha256"])).toEqual({ file: "f.json", sha256: "f.sha256" });
    expect(() => parseVerifyArgs(["f.json", "--key", "x"])).toThrow(RangeError);
  });
});
