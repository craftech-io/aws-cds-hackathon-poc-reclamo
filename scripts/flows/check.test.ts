import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_FILE,
  TEST_PLAN_FILE,
  checkCitations,
  committedMatrix,
  matrixDiff,
  parseCatalog,
  parseProofLine,
  renderMatrix,
  resolveTestPath,
  scenarioPrefix,
  type FileAccess,
} from "./check";

const CATALOG = `
## Área A

### FL-001 · Consulta sin registro
- Pasos: …
- Prueba: U \`routers/inbox.test.ts\`, \`connector/dynamo/complaints.test.ts\` · UI \`inbox.spec.ts\` · SR \`SC-16/1\`.

### FL-002 · Cliente sin opt-in
- Prueba: LF \`customer.flow.test.ts\` · SMK \`SMK/3\`. Notas: Clon de \`C01\`.
`;

function files(contents: Record<string, string>, scenarios: string[] = []): FileAccess {
  return { exists: (path) => path in contents, read: (path) => contents[path] ?? "", scenarios: () => scenarios };
}

describe("catalog and matrix", () => {
  it("parses the proof line by level, with the notes apart", () => {
    const parsed = parseProofLine("- Prueba: U `a.test.ts`, `b.test.ts` · SR `SC-01/1..3`. Notas: Oráculo §4.3.");
    expect(parsed.tests).toEqual({ U: ["a.test.ts", "b.test.ts"], LF: [], UI: [], SR: ["SC-01/1..3"], SMK: [] });
    expect(parsed.notes).toBe("Oráculo §4.3");
  });

  it("renders one row per flow with dashes for empty levels", () => {
    const matrix = renderMatrix(parseCatalog(CATALOG));
    expect(matrix.split("\n").slice(2)).toEqual([
      "| FL-001 | Consulta sin registro | `routers/inbox.test.ts`, `connector/dynamo/complaints.test.ts` | — | `inbox.spec.ts` | `SC-16/1` | — | — |",
      "| FL-002 | Cliente sin opt-in | — | `customer.flow.test.ts` | — | — | `SMK/3` | Clon de `C01` |",
    ]);
  });

  it("reports the rows that differ", () => {
    expect(matrixDiff("a\nb", "a\nc")).toEqual(["line 2: expected b / found c"]);
    expect(matrixDiff("a", "a")).toEqual([]);
  });

  it("keeps the committed matrix of docs/test-plan.md in step with docs/flows-catalog.md", () => {
    const flows = parseCatalog(readFileSync(resolve(process.cwd(), CATALOG_FILE), "utf8"));
    expect(flows).toHaveLength(128);
    expect(committedMatrix(readFileSync(resolve(process.cwd(), TEST_PLAN_FILE), "utf8"))).toBe(renderMatrix(flows));
  });
});

describe("citations", () => {
  it("resolves the short paths of the matrix", () => {
    expect(resolveTestPath("U", "routers/inbox.test.ts")).toBe("packages/bff/src/routers/inbox.test.ts");
    expect(resolveTestPath("U", "core-mock/src/ledger/payments.test.ts")).toBe("packages/core-mock/src/ledger/payments.test.ts");
    expect(resolveTestPath("U", "network-mock/src/settlements/publish.test.ts")).toBe("packages/network-mock/src/settlements/publish.test.ts");
    expect(resolveTestPath("U", "views/landing/landing.test.ts")).toBe("packages/web/src/views/landing/landing.test.ts");
    expect(resolveTestPath("U", "infra/policy-rules.test.ts")).toBe("infra/policy-rules.test.ts");
    expect(resolveTestPath("UI", "inbox.spec.ts")).toBe("packages/web/e2e/inbox.spec.ts");
    expect(resolveTestPath("LF", "customer.flow.test.ts")).toBe("tests/flows/customer.flow.test.ts");
    expect(scenarioPrefix("SC-16/1")).toBe("sc-16-");
    expect(scenarioPrefix("SMK/3")).toBe("sc-00-");
  });

  it("fails a cited test without the flow's tag and only reports a missing one", () => {
    const flows = parseCatalog(CATALOG);
    const report = checkCitations(flows, files({ "packages/bff/src/routers/inbox.test.ts": 'describe("inbox", () => {})' }));
    expect(report.errors).toEqual(["FL-001: packages/bff/src/routers/inbox.test.ts has no test tagged [FL-001]"]);
    expect(report.pending).toContain("FL-001 U packages/bff/src/connector/dynamo/complaints.test.ts");
    expect(report.pending).toContain("FL-002 SMK/3");
  });

  it("accepts a tagged test and a scenario step that lists the flow", () => {
    const flows = parseCatalog(CATALOG);
    const report = checkCitations(
      flows,
      files(
        {
          "packages/bff/src/routers/inbox.test.ts": 'it("[FL-001] answers", () => {})',
          "scripts/scenarios/sc-16-inbox.ts": "step({ name: 'SC-16/1', flows: ['FL-001'] })",
          "scripts/scenarios/sc-00-smoke.ts": 'step({ name: "SMK/3", flows: ["FL-005"] })',
        },
        ["sc-16-inbox.ts", "sc-00-smoke.ts"],
      ),
    );
    expect(report.errors).toEqual(['FL-002: scripts/scenarios/sc-00-smoke.ts has no step with flows: [..."FL-002"...] (SMK/3)']);
  });
});
