// The connector is the only door to DynamoDB for the BFF tables: no tool, worker, gate or router
// imports the DynamoDB SDK (docs/build-plan.md WP-10). lib/clients.ts builds the client the
// connector uses; everything else goes through the `Connector` port.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const DYNAMO_SDK = /from\s+["']@aws-sdk\/(lib-dynamodb|client-dynamodb|util-dynamodb)["']/;
const ALLOWED = [/^connector\//, /^lib\/clients\.ts$/];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(relative(SRC, path));
  }
  return out;
}

describe("DynamoDB boundary", () => {
  it("keeps the DynamoDB SDK inside the connector and the client factory", () => {
    const offenders = sources(SRC).filter((file) => !ALLOWED.some((pattern) => pattern.test(file)) && DYNAMO_SDK.test(readFileSync(join(SRC, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("never lets a tool import the DynamoDB SDK", () => {
    const tools = sources(SRC).filter((file) => file.startsWith("agent-tools/") && DYNAMO_SDK.test(readFileSync(join(SRC, file), "utf8")));
    expect(tools).toEqual([]);
  });
});
