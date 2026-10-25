import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NEUTRAL_TERMS, findNeutralTerms, isSurface, scanSurfaceFile, surfaceFiles } from "./neutral-surfaces";

// One sample per word of ADR-0019's list, each with the label the report prints.
const SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ["hackathon", "Built for the Hackathon"],
  ["hackathon", "two hackathons"],
  ["hackatón", "Hecho para la hackatón"],
  ["hackatón", "HACKATON"],
  ["hackatón", "las hackatones"],
  ["Devpost", "see devpost"],
  ["concurso", "Demo para el Concurso"],
  ["concurso", "concursos"],
  ["premio", "un premio"],
  ["premio", "PREMIOS"],
  ["jurado", "Jurado: ingresar"],
  ["jurado", "para los jurados"],
  ["juez", "un Juez"],
  ["jueces", "los jueces"],
  ["judge", "Judges: sign in"],
  ["judge", "judge-03"],
  ["judge", "JUDGE"],
  ["judge", "judging criteria"],
  ["evaluación", "la evaluación"],
  ["evaluación", "EVALUACION"],
  ["evaluación", "evaluaciones"],
  ["AWS CDS", "AWS CDS Agentic AI Partner"],
  ["AWS CDS", "aws-cds-hackathon-poc-reclamo"],
  ["AWS CDS", "aws_cds_hackathon_poc_reclamo"],
  ["contest", "the contest"],
  ["prize", "Prizes"],
  ["jury", "the jury"],
  ["evaluation", "for evaluation"],
];

describe("findNeutralTerms [FL-128]", () => {
  it.each(SAMPLES)("flags %s in %j (any case, with or without accents)", (label, text) => {
    expect(findNeutralTerms("f", text).map(({ term }) => term)).toContain(label);
  });

  it("covers every word of the list", () => {
    expect(new Set(SAMPLES.map(([label]) => label))).toEqual(new Set(NEUTRAL_TERMS.map(({ label }) => label)));
  });

  it("reports the file, the line and the word", () => {
    expect(findNeutralTerms("copy.ts", "ok\nconst x = \"jurado\";")).toEqual([{ source: "copy.ts", line: 2, term: "jurado" }]);
  });

  it("flags the word inside JSX, a JSON of the seed and a minified bundle", () => {
    expect(findNeutralTerms("View.tsx", "<p>{copy.title} · Jurado</p>")).toHaveLength(1);
    expect(findNeutralTerms("persona.json", "{\"name\":\"Caso para el jurado\"}")).toHaveLength(1);
    expect(findNeutralTerms("index-abc.js", "const a={signIn:\"Judges: sign in\"},b=1;")).toHaveLength(1);
  });

  it("matches whole words only, so the product's own vocabulary passes", () => {
    const allowed = [
      "Invitado · Guest",
      "guest-03 en el mundo g03",
      "decisión de política",
      "evaluate(condition, item) and LastEvaluatedKey",
      "the condition was evaluated",
      "prejudged, judgement-free",
      "concursal",
      "premium",
      "aws-sdk and the CDS of the core",
      "Reclamo en regla · Powered by Craftech",
    ];
    for (const text of allowed) expect(findNeutralTerms("f", text), text).toEqual([]);
  });
});

describe("isSurface [FL-128]", () => {
  it("reads the visible sources", () => {
    for (const path of [
      "packages/web/src/views/landing/copy.ts",
      "packages/web/src/views/login/LoginView.tsx",
      "packages/web/public/legal/terms.html",
      "packages/web/index.html",
      "packages/bff/src/copy/es-AR.ts",
      "packages/bff/src/pdf/acknowledgement.ts",
      "packages/bff/src/auth-triggers/custom-message.ts",
      "infra/auth-email.ts",
      "scripts/seed/data/personas.json",
    ]) expect(isSurface(path), path).toBe(true);
  });

  it("skips tests, test helpers and every non-visible source", () => {
    for (const path of [
      "packages/web/src/routes.test.ts",
      "packages/web/src/lib/auth/testing/fake-cognito.ts",
      "packages/web/e2e/login.spec.ts",
      "packages/bff/src/copy/copy.test.ts",
      "packages/bff/src/copy/testing.ts",
      "packages/bff/src/auth-triggers/pre-token.ts",
      "packages/bff/src/auth/principal.ts",
      "infra/auth.ts",
      "scripts/console/invite.ts",
      "docs/adr/0019-superficies-neutrales-y-landing-comercial.md",
      "README.md",
    ]) expect(isSurface(path), path).toBe(false);
  });
});

describe("scanSurfaceFile [FL-128]", () => {
  const dir = mkdtempSync(join(tmpdir(), "neutral-surfaces-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails on a file of the web build and passes on a neutral one", async () => {
    const bad = join(dir, "index-abc.js");
    writeFileSync(bad, "const s=\"Hecho para la Hackatón\";\n");
    expect(await scanSurfaceFile(dir, bad)).toEqual([{ source: "index-abc.js", line: 1, term: "hackatón" }]);
    const good = join(dir, "index-def.js");
    writeFileSync(good, "const s=\"Probar la demo\";\n");
    expect(await scanSurfaceFile(dir, good)).toEqual([]);
  });

  it("skips binary files it cannot read as text", async () => {
    const binary = join(dir, "font.woff2");
    writeFileSync(binary, Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x6a, 0x75, 0x72, 0x61, 0x64, 0x6f]));
    expect(await scanSurfaceFile(dir, binary)).toEqual([]);
  });
});

describe("the repository today [FL-128]", () => {
  it("has neutral visible sources", async () => {
    const cwd = process.cwd();
    const files = surfaceFiles(cwd);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(isSurface)).toBe(true);
    const findings = (await Promise.all(files.map((file) => scanSurfaceFile(cwd, join(cwd, file))))).flat();
    expect(findings).toEqual([]);
  });
});
