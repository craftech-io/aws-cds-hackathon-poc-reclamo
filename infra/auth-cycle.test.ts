// The user pool needs the ARNs of its triggers, so nothing a trigger links may wait for the pool. A
// linked sst.aws.Function contributes its ARN and name to the trigger's policy and bundle, so the
// trigger waits for that Function and for everything it links: a Function that links `auth` or names
// `userPool` closes a cycle Pulumi never resolves (the deploy hangs). The recording stand-ins resolve
// every Output on its own and cannot see it, so this reads the modules' import graph: every module a
// trigger link comes from (static or late) must not reach infra/auth.ts through static imports.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fake, installGlobals } from "./workers-spec.fakes";

const INFRA = resolve(process.cwd(), "infra");
const source = (module: string): string => readFileSync(resolve(INFRA, `${module}.ts`), "utf8");
const MODULES = new Set(readdirSync(INFRA).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).map((file) => file.replace(/\.ts$/, "")));

/** `from "./x"` imports of a module (type-only ones carry no resource). */
function staticImports(module: string): string[] {
  return [...source(module).matchAll(/^import (?!type )[^;]*? from "\.\/([\w.-]+)";$/gms)].flatMap((match) => (match[1] && MODULES.has(match[1]) ? [match[1]] : []));
}

function reachesStatically(module: string, target: string, seen = new Set<string>()): boolean {
  if (module === target) return true;
  if (seen.has(module)) return false;
  seen.add(module);
  return staticImports(module).some((next) => reachesStatically(next, target, seen));
}

/** The `link` of one Function in infra/auth.ts, and the modules its identifiers and `import()`s come from. */
function linkSources(functionName: string): { readonly link: string; readonly modules: string[] } {
  const auth = source("auth");
  const start = auth.indexOf(`new sst.aws.Function("${functionName}"`);
  expect(start, functionName).toBeGreaterThanOrEqual(0);
  const link = /^\s*link: (.*),$/m.exec(auth.slice(start, auth.indexOf("\n});", start)))?.[1] ?? "";
  const importedFrom = new Map<string, string>();
  for (const match of auth.matchAll(/^import \{([^}]*)\} from "\.\/([\w.-]+)";$/gm)) {
    for (const name of (match[1] ?? "").split(",").map((item) => item.trim().replace(/^type /, ""))) if (name && match[2]) importedFrom.set(name, match[2]);
  }
  const named = [...link.matchAll(/\b([A-Za-z_]\w*)\b/g)].flatMap((match) => (match[1] && importedFrom.has(match[1]) ? [importedFrom.get(match[1]) as string] : []));
  const late = [...link.matchAll(/import\("\.\/([\w.-]+)"\)/g)].flatMap((match) => (match[1] ? [match[1]] : []));
  return { link, modules: [...new Set([...named, ...late])] };
}

describe("what the user pool's triggers link (no dependency cycle with the pool)", () => {
  it("links into PostConfirmationTrigger nothing from a module that reaches infra/auth.ts", () => {
    const { link, modules } = linkSources("PostConfirmationTrigger");
    expect(link).toContain("WorldJanitorInvoke");
    expect(modules).toEqual(expect.arrayContaining(["storage-tables", "leads", "world-janitor-link"]));
    for (const module of modules) expect(reachesStatically(module, "auth"), `infra/${module}.ts reaches infra/auth.ts`).toBe(false);
  });

  it("would catch the late link of WorldJanitor's component (infra/bff.ts links the pool)", () => {
    expect(reachesStatically("bff", "auth")).toBe(true);
    expect(source("bff")).toMatch(/link: \[[^\]]*\bauth\b/);
  });

  it("gives the trigger the janitor's fixed name and lambda:InvokeFunction on that ARN only", async () => {
    installGlobals();
    const state = Reflect.get(globalThis, "__wp20Fakes") as { created: Array<{ kind: string; name: string; args: Record<string, unknown> }> };
    state.created = [];
    const module = await import("./world-janitor-link");
    const linkable = state.created.find((item) => item.kind === "sst.Linkable" && item.name === "WorldJanitorInvoke");
    const name = module.worldJanitorFunctionName("aws-cds-hackathon-poc-reclamo", "poc");
    expect(linkable?.args.properties).toEqual({ name });
    expect(await fake.deep(linkable?.args.include)).toEqual([{ actions: ["lambda:InvokeFunction"], resources: [`arn:aws:lambda:us-east-1:776805327629:function:${name}`] }]);
    expect(staticImports("world-janitor-link")).toEqual([]);
  });
});
