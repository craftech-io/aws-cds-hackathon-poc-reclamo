// zod → the `inlinePayload` of each Gateway target (docs/tool-catalog.md "Schemas del Gateway",
// docs/architecture.md §9.2). A Gateway schema node only has `type`, `properties`, `required`, `items` and
// `description`, so the JSON Schema zod generates is folded into that subset:
//
//   enum, const, maxLength, min/maxItems, minimum/maximum   → a sentence of the field's description
//                                                             (zod validates the real bound in the Lambda)
//   pattern, format, minLength, additionalProperties: false → dropped (zod validates them)
//   a field made with `deniedByPolicy`                      → declared with its type and "never set; denied
//                                                             by policy" (Cedar reads it, zod refuses it)
//   anything else (anyOf, not, $ref, a list of types, …)    → a problem: the build fails instead of
//                                                             publishing a schema that says less than zod
//
// Pure (zod and node:crypto): the SST program runs it and `npm run tools:build-schemas` checks it in CI.
import { createHash } from "node:crypto";
import { z } from "zod";
import { definitionsOf } from "./catalog";
import { type GatewayType, type ToolDefinition, deniedFieldOf } from "./define";
import { ToolTarget } from "./targets";

/** The only words a Gateway schema node may carry. */
export const SUPPORTED_WORDS = ["type", "description", "properties", "required", "items"] as const;

const GATEWAY_TYPES: readonly GatewayType[] = ["string", "number", "integer", "boolean", "object", "array"];

// Plain mutable data, so it can be handed as is to aws-native's `GatewayTarget` arguments.
export interface GatewaySchemaNode {
  type: GatewayType;
  description?: string;
  properties?: Record<string, GatewaySchemaNode>;
  required?: string[];
  items?: GatewaySchemaNode;
}

/** One entry of a target's `inlinePayload`. */
export interface GatewayToolDefinition {
  name: string;
  description: string;
  inputSchema: GatewaySchemaNode;
}

/** JSON Schema words that only validate; zod enforces them in the Lambda. */
const VALIDATION_ONLY = new Set(["$schema", "pattern", "format", "minLength", "contentEncoding"]);

type JsonNode = Readonly<Record<string, unknown>>;

function isNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGatewayType(value: unknown): value is GatewayType {
  return typeof value === "string" && (GATEWAY_TYPES as readonly string[]).includes(value);
}

function sentence(key: string, value: unknown): string | undefined {
  switch (key) {
    case "enum":
      return Array.isArray(value) ? `One of: ${value.map(String).join(", ")}.` : undefined;
    case "const":
      return `Always ${String(value)}.`;
    case "maxLength":
      return `At most ${String(value)} characters.`;
    case "minItems":
      return value === 1 ? "At least one item." : `At least ${String(value)} items.`;
    case "maxItems":
      return `At most ${String(value)} items.`;
    case "minimum":
    case "exclusiveMinimum":
      return `At least ${String(key === "exclusiveMinimum" ? Number(value) + 1 : value)}.`;
    case "maximum":
      return `At most ${String(value)}.`;
    default:
      return undefined;
  }
}

/** Folds one JSON Schema node into a Gateway node; every word it cannot say goes to `problems`. */
export function toGatewayNode(node: JsonNode, path: string, problems: string[]): GatewaySchemaNode {
  const type = node["type"];
  if (!isGatewayType(type)) problems.push(`${path}: "type" ${JSON.stringify(type)} is not a single Gateway type`);
  const notes: string[] = [];
  let properties: Record<string, GatewaySchemaNode> | undefined;
  let required: string[] | undefined;
  let items: GatewaySchemaNode | undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "description" || VALIDATION_ONLY.has(key)) continue;
    const note = sentence(key, value);
    if (note !== undefined) {
      notes.push(note);
      continue;
    }
    if (key === "properties" && isNode(value)) {
      properties = {};
      for (const [name, child] of Object.entries(value)) {
        if (isNode(child)) properties[name] = toGatewayNode(child, `${path}.${name}`, problems);
        else problems.push(`${path}.${name}: not a schema node`);
      }
    } else if (key === "required" && Array.isArray(value) && value.every((name) => typeof name === "string")) {
      required = [...value];
    } else if (key === "items" && isNode(value)) {
      items = toGatewayNode(value, `${path}[]`, problems);
    } else if (key === "additionalProperties" && value === false) {
      continue;
    } else {
      problems.push(`${path}: unsupported word "${key}"`);
    }
  }
  const description = [typeof node["description"] === "string" ? node["description"] : undefined, ...notes].filter((part) => part !== undefined && part !== "").join(" ");
  return {
    type: isGatewayType(type) ? type : "string",
    ...(description === "" ? {} : { description }),
    ...(properties === undefined ? {} : { properties }),
    ...(required === undefined || required.length === 0 ? {} : { required }),
    ...(items === undefined ? {} : { items }),
  };
}

/** JSON Schema of the Gateway input of a tool, with the Cedar-read fields declared as their type. */
export function jsonSchemaOf(definition: ToolDefinition): JsonNode {
  return z.toJSONSchema(definition.gatewayShape, {
    io: "input",
    unrepresentable: "throw",
    override: (ctx) => {
      const denied = deniedFieldOf(ctx.zodSchema);
      if (denied === undefined) return;
      const description = ctx.jsonSchema.description;
      for (const key of Object.keys(ctx.jsonSchema)) Reflect.deleteProperty(ctx.jsonSchema, key);
      Object.assign(ctx.jsonSchema, { type: denied.type, ...(description === undefined ? {} : { description }) });
    },
  }) as JsonNode;
}

export function gatewayToolDefinition(definition: ToolDefinition, problems: string[]): GatewayToolDefinition {
  const path = definition.name;
  if (definition.description.trim() === "") problems.push(`${path}: the tool has no description`);
  const inputSchema = toGatewayNode(jsonSchemaOf(definition), path, problems);
  if (inputSchema.type !== "object") problems.push(`${path}: the input schema must be an object`);
  if (!(inputSchema.required ?? []).includes("sessionToken")) problems.push(`${path}: sessionToken must be required`);
  for (const name of inputSchema.required ?? []) if (inputSchema.properties?.[name] === undefined) problems.push(`${path}: "${name}" is required but not declared`);
  for (const field of definition.deniedFields) {
    if (inputSchema.required?.includes(field)) problems.push(`${path}: "${field}" is denied by policy and cannot be required`);
    if (inputSchema.properties?.[field]?.description?.includes("never set; denied by policy") !== true) problems.push(`${path}: "${field}" must say it is never set`);
  }
  return { name: definition.name, description: definition.description, inputSchema };
}

/** Every word of a Gateway node outside `SUPPORTED_WORDS`, with its path: the final check of the build. */
export function unsupportedWords(node: unknown, path: string): string[] {
  if (!isNode(node)) return [`${path}: not a schema node`];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (!(SUPPORTED_WORDS as readonly string[]).includes(key)) found.push(`${path}: unsupported word "${key}"`);
    else if (key === "type" && !isGatewayType(value)) found.push(`${path}: "type" ${JSON.stringify(value)} is not a Gateway type`);
    else if (key === "properties" && isNode(value)) for (const [name, child] of Object.entries(value)) found.push(...unsupportedWords(child, `${path}.${name}`));
    else if (key === "items") found.push(...unsupportedWords(value, `${path}[]`));
  }
  return found;
}

export type GatewayPayloads = { readonly [T in ToolTarget]: GatewayToolDefinition[] };

export interface GatewayBuild {
  readonly payloads: GatewayPayloads;
  /** Empty when every tool of every target has a schema in the Gateway subset. */
  readonly problems: readonly string[];
}

/** The seven payloads, in `GATEWAY_TOOLS` order. */
export function buildGatewayPayloads(definitionsFor: (target: ToolTarget) => readonly ToolDefinition[] = definitionsOf): GatewayBuild {
  const problems: string[] = [];
  const entries = ToolTarget.options.map((target) => {
    let payload: GatewayToolDefinition[] = [];
    try {
      payload = definitionsFor(target).map((definition) => gatewayToolDefinition(definition, problems));
    } catch (error) {
      problems.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const tool of payload) problems.push(...unsupportedWords(tool.inputSchema, `${target}___${tool.name}`));
    return [target, payload] as const;
  });
  return { payloads: Object.fromEntries(entries) as unknown as GatewayPayloads, problems };
}

/** Digest of a target's payload; it travels in the `GatewayTarget` description (docs/architecture.md §9.2). */
export function payloadDigest(payload: readonly GatewayToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}
