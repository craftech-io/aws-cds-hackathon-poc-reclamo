import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Both files are read as text: infra/secrets.ts only evaluates inside the SST program ($app, sst)
// and the BFF secret reader imports the SST SDK, so neither can be imported from a plain vitest run.
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
// Line comments first: a path such as `/api/*` inside one must not open a block comment.
const stripComments = (source: string): string => source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const declared = (source: string): string[] => [...stripComments(source).matchAll(/new sst\.Secret\("([A-Za-z0-9]+)"/g)].map((match) => match[1] ?? "");

const infraSecrets = read("./secrets.ts");
const bffSecrets = read("../packages/bff/src/lib/secrets.ts");
const architecture = read("../docs/architecture.md");

describe("shared secrets", () => {
  it("declares exactly the names packages/bff/src/lib/secrets.ts reads", () => {
    const names = /SECRET_NAMES = \[([^\]]+)\]/.exec(stripComments(bffSecrets))?.[1]?.match(/"([A-Za-z0-9]+)"/g)?.map((name) => name.slice(1, -1)) ?? [];
    expect(names.length).toBeGreaterThan(0);
    expect([...declared(infraSecrets)].sort()).toEqual([...names].sort());
  });

  it("declares the ten secrets of docs/architecture.md §3, each once and never with a placeholder", () => {
    const names = declared(infraSecrets);
    expect([...names].sort()).toEqual([
      "EdgeOriginKey",
      "LeadNotifyEmail",
      "PhoneHashKey",
      "QaSimEnvelopeKey",
      "RegisterChainKey",
      "SeedOverrides",
      "SessionKey",
      "SimEnvelopeKey",
      "WabaId",
      "WhatsAppPhoneNumberId",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(stripComments(infraSecrets)).not.toMatch(/new sst\.Secret\("[A-Za-z0-9]+"\s*,/);
  });

  it("keeps one secret per purpose: no master key", () => {
    expect(stripComments(infraSecrets)).not.toMatch(/SessionTokenKey|MasterKey/);
    for (const name of declared(infraSecrets)) expect(architecture, name).toContain(`\`${name}\``);
  });

  it("documents how the operator loads each one, the guest-signup ones included (docs/architecture-guests.md §13)", () => {
    for (const name of declared(infraSecrets)) expect(infraSecrets, name).toContain(`npx sst secret set ${name} `);
    expect(infraSecrets).toContain("npx sst secret set LeadNotifyEmail not-configured --stage poc");
    expect(infraSecrets).toContain('npx sst secret set EdgeOriginKey "$(openssl rand -base64 32)" --stage poc');
    // The mailbox of the notices is configuration of the operator, never a literal of the code.
    expect(stripComments(infraSecrets)).not.toMatch(/@craftech\.io/);
  });

  it("is the only infra module that declares a secret", () => {
    const modules = readdirSync(fileURLToPath(new URL(".", import.meta.url))).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "secrets.ts",
    );
    expect(modules.length).toBeGreaterThan(10);
    for (const file of modules) expect(declared(read(`./${file}`)), `infra/${file}`).toEqual([]);
  });
});
