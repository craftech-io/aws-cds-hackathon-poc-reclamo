// leads:export (FL-127): escaped CSV, contact consent unless --all, never QA, never inside the repo
// unless *.local.csv.
import { describe, expect, it } from "vitest";
import type { Lead } from "../../packages/bff/src/leads/records";
import { assertOutsideRepo, csvCell, exportLeads, leadsCsv, parseExportArgs } from "./export";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    sub: "s1",
    email: "ana@empresa-ficticia.ar",
    consents: { terms: { acceptedAtReal: "2026-10-07T13:10:00.000Z", textVersion: "signup-v1" }, contact: { accepted: true, atReal: "2026-10-07T13:10:00.000Z", textVersion: "signup-v1" } },
    sourcePoc: "reclamo-en-regla",
    locale: "es",
    emailHash: "0".repeat(64),
    worldId: "gs-abcdefgh23",
    signupAtReal: "2026-10-07T13:10:00.000Z",
    confirmedAtReal: "2026-10-07T13:12:00.000Z",
    ...overrides,
  };
}

describe("leads:export [FL-127]", () => {
  it("escapes every cell and neutralizes formulas", () => {
    expect(csvCell('Acme "Sur"')).toBe('"Acme ""Sur"""');
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("a\nb")).toBe('"a b"');
    expect(csvCell(undefined)).toBe('""');
  });

  it("exports only leads that accepted contact, all with --all, and never a QA lead", () => {
    const leads = [lead(), lead({ sub: "s2", email: "b@empresa-ficticia.ar", consents: { ...lead().consents, contact: { accepted: false, textVersion: "signup-v1" } } }), lead({ sub: "s3", qa: { runId: "r1", key: "su1" } })];
    expect(leadsCsv(leads, false).count).toBe(1);
    const all = leadsCsv(leads, true);
    expect(all.count).toBe(2);
    expect(all.csv.split("\n")[0]).toContain('"email","name","company"');
  });

  it("refuses a path inside the repository unless it is *.local.csv, and needs --out", () => {
    expect(() => assertOutsideRepo("/repo/leads.csv", "/repo")).toThrow(RangeError);
    expect(assertOutsideRepo("/repo/scripts/leads/leads.local.csv", "/repo")).toBe("/repo/scripts/leads/leads.local.csv");
    expect(assertOutsideRepo("/tmp/leads.csv", "/repo")).toBe("/tmp/leads.csv");
    expect(() => parseExportArgs([])).toThrow(RangeError);
    expect(parseExportArgs(["--out", "/tmp/x.csv", "--all"])).toEqual({ out: "/tmp/x.csv", all: true });
  });

  it("writes the file with mode 600 and returns only the count and the path", async () => {
    const written: Array<{ path: string; data: string; mode: number }> = [];
    async function* source() {
      yield lead();
    }
    const result = await exportLeads({ out: "/tmp/leads.csv", all: false }, source, "/repo", ((path: string, data: string, options: { mode: number }) => void written.push({ path, data, mode: options.mode })) as never);
    expect(result).toEqual({ path: "/tmp/leads.csv", count: 1 });
    expect(written[0]?.mode).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain("@");
  });
});
