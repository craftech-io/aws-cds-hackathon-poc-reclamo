import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_FILE, conflicts, expandBraces, isRepositoryPath, overlaps, parsePlan } from "./wp-ownership";

const plan = (wave1: string, wave2 = "") => `
## 2. Paquetes de trabajo

### Ola 1 · Test

**WP-01 · One** — devops · —
Objetivo: x. Archivos: ${wave1}. Aceptación: \`npm test\`.

**WP-02 · Two** — typescript-dev · WP-01
Objetivo: y. Archivos: \`packages/bff/src/lib/{log,mask}.ts\`, \`docs/architecture.md\` (read). Aceptación: ok.

### Ola 2 · Other

**WP-03 · Three** — qa · —
Objetivo: z. Archivos: ${wave2 || "`packages/bff/src/lib/log.ts`"}. Aceptación: ok.

## 3. Dependencias
`;

describe("parsePlan", () => {
  it("reads the backticked repository paths of every WP, per wave, with braces expanded", () => {
    const waves = parsePlan(plan("`packages/web/src/**`, `aws-cds-hackathon-poc-reclamo`, `infra/`"));
    expect(waves.map((wave) => wave.title)).toEqual(["Ola 1 · Test", "Ola 2 · Other"]);
    expect(waves[0]?.packages).toEqual([
      { id: "WP-01", files: ["packages/web/src/**"] },
      { id: "WP-02", files: ["packages/bff/src/lib/log.ts", "packages/bff/src/lib/mask.ts"] },
    ]);
  });

  it("expands nested brace lists", () => {
    expect(expandBraces("packages/{a,b}/{x,y}.ts")).toEqual(["packages/a/x.ts", "packages/a/y.ts", "packages/b/x.ts", "packages/b/y.ts"]);
  });

  it("keeps root files and repository roots, drops identifiers, commands and docs the WP reads", () => {
    expect(isRepositoryPath("package.json")).toBe(true);
    expect(isRepositoryPath("docs/viewer.html")).toBe(true);
    expect(isRepositoryPath("docs/architecture.md")).toBe(false);
    expect(isRepositoryPath("OperationWorker")).toBe(false);
    expect(isRepositoryPath("qa-*@sim…")).toBe(false);
    expect(isRepositoryPath("infra/")).toBe(false);
  });
});

describe("conflicts", () => {
  it("finds a file listed by two WPs of the same wave, also through a directory glob", () => {
    expect(conflicts(parsePlan(plan("`packages/bff/src/lib/log.ts`")))).toHaveLength(1);
    const glob = conflicts(parsePlan(plan("`packages/bff/src/lib/**`")));
    expect(glob.map((conflict) => [conflict.a, conflict.b])).toEqual([
      ["WP-01", "WP-02"],
      ["WP-01", "WP-02"],
    ]);
  });

  it("ignores the same file in different waves and disjoint globs", () => {
    expect(conflicts(parsePlan(plan("`packages/bff/src/lib/clock.ts`")))).toEqual([]);
    expect(overlaps("packages/bff/src/agent-tools/messaging/**", "packages/bff/src/agent-tools/complaints/**")).toBe(false);
    expect(overlaps("packages/bff/src/agent-tools/**", "packages/bff/src/agent-tools/complaints/**")).toBe(true);
    expect(overlaps("packages/web/src/lib/**", "packages/web/src/lib/http.ts")).toBe(true);
    expect(overlaps("packages/web/src/lib/*.ts", "packages/web/src/lib/auth/tokens.ts")).toBe(false);
  });

  it("finds no conflict in the committed build plan", () => {
    const waves = parsePlan(readFileSync(resolve(process.cwd(), PLAN_FILE), "utf8"));
    expect(waves.length).toBeGreaterThanOrEqual(7);
    expect(conflicts(waves)).toEqual([]);
  });
});
