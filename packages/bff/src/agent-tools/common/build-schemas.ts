// `npm run tools:build-schemas` (docs/architecture.md §18, "Schemas del Gateway"): generates the seven
// Gateway payloads from the zod definitions and fails when a tool has no schema, a target has a tool that
// is not its own, or a node carries a word the Gateway does not support. The same payloads are what the
// GatewayTargets get, so what CI checks is what gets deployed.
//
//   npm run tools:build-schemas              summary: tools and digest per target
//   npm run tools:build-schemas -- --print   the seven payloads as JSON
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type GatewayBuild, buildGatewayPayloads, payloadDigest } from "./gateway-schema";
import { EXPECTED_TOOL_COUNT, GATEWAY_TOOLS, ToolTarget } from "./targets";

/** Everything that keeps a build from being deployed; empty when it is sound. */
export function checkGatewayBuild(build: GatewayBuild): string[] {
  const problems = [...build.problems];
  let total = 0;
  for (const target of ToolTarget.options) {
    const payload = build.payloads[target] ?? [];
    const names = payload.map((tool) => tool.name);
    const expected: readonly string[] = GATEWAY_TOOLS[target];
    total += payload.length;
    for (const tool of expected) if (!names.includes(tool)) problems.push(`${target}___${tool}: tool without schema`);
    for (const name of names) if (!expected.includes(name)) problems.push(`${target}___${name}: not a tool of the ${target} target`);
    if (new Set(names).size !== names.length) problems.push(`${target}: a tool appears twice`);
  }
  if (total !== EXPECTED_TOOL_COUNT) problems.push(`the Gateway has ${total} tools, expected ${EXPECTED_TOOL_COUNT}`);
  return problems;
}

export function buildSummary(build: GatewayBuild): string[] {
  return ToolTarget.options.map((target) => `  ${target.padEnd(13)} ${String(build.payloads[target].length).padStart(2)} tool(s)  digest ${payloadDigest(build.payloads[target])}`);
}

function main(args: readonly string[]): void {
  const build = buildGatewayPayloads();
  const problems = checkGatewayBuild(build);
  if (problems.length > 0) {
    console.error(`tools:build-schemas: ${problems.length} problem(s) in the Gateway schemas:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  if (args.includes("--print")) {
    console.log(JSON.stringify(build.payloads, null, 2));
    return;
  }
  console.log(`tools:build-schemas: ${ToolTarget.options.length} payloads, ${EXPECTED_TOOL_COUNT} tools, only supported words.`);
  for (const line of buildSummary(build)) console.log(line);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
