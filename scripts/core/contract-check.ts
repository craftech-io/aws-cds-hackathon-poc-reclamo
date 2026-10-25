// `npm run core:contract` (docs/architecture.md §18): fails when the zod schemas of
// @reclamo/core-contract and packages/core-contract/{core,networks}.openapi.yaml differ.
//
// For each document it compares
//   - components: the registry of the document rendered as JSON Schema 2020-12 (input side, so a
//     strict object is `additionalProperties: false` and a loose one is not) against
//     `components/schemas`, one by one, after dropping annotations (description, examples, x-*) and
//     sorting `required` and `enum`;
//   - operations: every route of the table against `paths`: operationId, path parameters, query
//     parameters, headers (name, required, schema), request body and the set of response statuses
//     with their schemas; and every YAML operation must have its route;
//   - the document: `openapi` 3.1.x and `info.version` = CONTRACT_VERSION.
// It also fails on a zod refinement or transform inside a component (the YAML cannot express it),
// on a route whose path placeholders and params differ, on a world route without `X-Sim-Now`, and
// when `PaymentNetwork` stops mirroring `Network` of @reclamo/shared.
//
// Usage: `npm run core:contract` (from the repository root). Exit 1 on any difference.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_DOCUMENTS,
  CONTRACT_VERSION,
  type ContractDocument,
  ErrorBody,
  PaymentNetwork,
  type RouteSpec,
  SIM_NOW_HEADER,
  componentId,
  pathParamNames,
} from "@reclamo/core-contract";
import { Network } from "@reclamo/shared";
import { parse } from "yaml";
import { z } from "zod";

export const CONTRACT_DIR = "packages/core-contract";

type JsonObject = Record<string, unknown>;

export interface Difference {
  readonly file: string;
  /** JSON pointer inside the YAML (or the zod route) where the two sides differ. */
  readonly at: string;
  readonly message: string;
}

const ANNOTATIONS = new Set(["description", "title", "summary", "examples", "example", "$comment", "deprecated", "externalDocs", "readOnly", "writeOnly"]);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const SCHEMA_REF = "#/components/schemas/";
const SET_KEYWORD = /\/(enum|required|type)$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops annotations and orders what JSON Schema treats as a set, so only semantics remain. */
export function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const key of Object.keys(node).sort()) {
    if (ANNOTATIONS.has(key) || key.startsWith("x-") || key === "$schema" || key === "$id") continue;
    const value = node[key];
    const setLike = (key === "required" || key === "enum" || key === "type") && Array.isArray(value);
    out[key] = setLike ? [...(value as unknown[])].map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : normalize(value);
  }
  return out;
}

/** One JSON pointer token (RFC 6901). */
const token = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");

const show = (value: unknown): string => (value === undefined ? "(absent)" : JSON.stringify(value));

/** Every place where two normalized JSON values differ, as `[pointer, message]`. */
export function diffJson(zodSide: unknown, yamlSide: unknown, at: string): Array<[string, string]> {
  if (isObject(zodSide) && isObject(yamlSide)) {
    const keys = [...new Set([...Object.keys(zodSide), ...Object.keys(yamlSide)])].sort();
    return keys.flatMap((key) => diffJson(zodSide[key], yamlSide[key], `${at}/${token(key)}`));
  }
  // Sets (enum, required, type) are reported whole: their sorted indexes mean nothing in the YAML.
  if (Array.isArray(zodSide) && Array.isArray(yamlSide) && zodSide.length === yamlSide.length && !SET_KEYWORD.test(at)) {
    return zodSide.flatMap((item, index) => diffJson(item, yamlSide[index], `${at}/${index}`));
  }
  if (JSON.stringify(zodSide) === JSON.stringify(yamlSide)) return [];
  return [[at, `zod ${show(zodSide)} · yaml ${show(yamlSide)}`]];
}

interface Rendered {
  readonly schemas: Record<string, unknown>;
  readonly unrepresentable: readonly string[];
}

/** The components of a document as the YAML must state them. */
export function renderComponents(doc: ContractDocument): Rendered {
  const unrepresentable: string[] = [];
  const rendered = z.toJSONSchema(doc.registry, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    uri: (id) => `${SCHEMA_REF}${id}`,
    override: (ctx) => {
      const def = ctx.zodSchema._zod.def as { type: string; checks?: ReadonlyArray<{ _zod: { def: { check: string } } }> };
      const refined = (def.checks ?? []).some((check) => check._zod.def.check === "custom");
      if (!refined && def.type !== "pipe" && def.type !== "transform") return;
      const owner = doc.registry.get(ctx.zodSchema)?.id;
      const where = owner ?? `a schema at ${(ctx.path ?? []).join("/") || "(root)"} rendered as ${JSON.stringify(ctx.jsonSchema)}`;
      unrepresentable.push(`${where}: a zod refinement or transform has no OpenAPI form; express it with a schema keyword`);
    },
  }) as { schemas: Record<string, unknown> };
  const schemas = Object.fromEntries(Object.entries(rendered.schemas).map(([id, schema]) => [id, normalize(schema)]));
  return { schemas, unrepresentable };
}

function pointerGet(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    node = isObject(node) ? node[key] : undefined;
  }
  return node;
}

/** Follows local `$ref`s of parameters, request bodies and responses (not of schemas). */
function deref(root: unknown, node: unknown): unknown {
  let current = node;
  for (let hops = 0; hops < 10 && isObject(current) && typeof current.$ref === "string"; hops += 1) {
    current = pointerGet(root, current.$ref);
  }
  return current;
}

const refTo = (id: string): JsonObject => ({ $ref: `${SCHEMA_REF}${id}` });

type Expected = { readonly required: boolean; readonly schema: unknown } | { readonly error: string };

function componentRef(doc: ContractDocument, schema: z.ZodType, what: string): Expected {
  const optional = schema instanceof z.ZodOptional;
  const inner = optional ? (schema.unwrap() as z.ZodType) : schema;
  const id = componentId(doc.registry, inner);
  if (id === undefined) return { error: `${what}: its schema is not a registered component of ${doc.file}` };
  return { required: !optional, schema: refTo(id) };
}

function expectedParameters(doc: ContractDocument, operationId: string, route: RouteSpec): Map<string, Expected> {
  const expected = new Map<string, Expected>();
  const add = (location: string, object: z.ZodObject | undefined) => {
    for (const [name, schema] of Object.entries(object?.shape ?? {})) {
      const key = `${location}:${location === "header" ? name.toLowerCase() : name}`;
      const entry = componentRef(doc, schema as z.ZodType, `${operationId} ${key}`);
      expected.set(key, location === "path" && "required" in entry && !entry.required ? { error: `${operationId} ${key}: a path parameter cannot be optional` } : entry);
    }
  };
  add("path", route.params);
  add("query", route.query);
  add("header", route.headers);
  return expected;
}

function yamlParameters(root: unknown, pathItem: JsonObject, operation: JsonObject): Map<string, { required: boolean; schema: unknown }> {
  const found = new Map<string, { required: boolean; schema: unknown }>();
  const listed = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  for (const raw of listed) {
    const parameter = deref(root, raw);
    if (!isObject(parameter)) continue;
    const location = String(parameter.in);
    const name = String(parameter.name);
    found.set(`${location}:${location === "header" ? name.toLowerCase() : name}`, { required: parameter.required === true, schema: normalize(parameter.schema) });
  }
  return found;
}

/** `{ "application/json": { schema } }` → the normalized schema, or a message. */
function jsonContent(content: unknown): { schema: unknown } | { error: string } {
  if (!isObject(content) || Object.keys(content).join() !== "application/json") return { error: `content must be exactly application/json, got ${show(content && Object.keys(content))}` };
  const media = content["application/json"];
  return { schema: normalize(isObject(media) ? media.schema : undefined) };
}

function compareOperation(doc: ContractDocument, root: unknown, operationId: string, route: RouteSpec, pathItem: JsonObject, operation: JsonObject): Array<[string, string]> {
  const at = `#/paths/${token(route.path)}/${route.method}`;
  const out: Array<[string, string]> = [];
  if (operation.operationId !== operationId) out.push([`${at}/operationId`, `zod "${operationId}" · yaml ${show(operation.operationId)}`]);

  const zodParams = expectedParameters(doc, operationId, route);
  const yamlParams = yamlParameters(root, pathItem, operation);
  for (const key of [...new Set([...zodParams.keys(), ...yamlParams.keys()])].sort()) {
    const expected = zodParams.get(key);
    const actual = yamlParams.get(key);
    const where = `${at}/parameters(${key})`;
    if (expected && "error" in expected) out.push([where, expected.error]);
    else if (!expected) out.push([where, "parameter in the YAML only"]);
    else if (!actual) out.push([where, "parameter in zod only"]);
    else out.push(...diffJson(expected, actual, where));
  }

  const body = deref(root, operation.requestBody);
  if (route.body === undefined) {
    if (body !== undefined) out.push([`${at}/requestBody`, "request body in the YAML only"]);
  } else if (!isObject(body)) {
    out.push([`${at}/requestBody`, "request body in zod only"]);
  } else {
    const expected = componentRef(doc, route.body, `${operationId} request body`);
    const content = jsonContent(body.content);
    if ("error" in expected) out.push([`${at}/requestBody`, expected.error]);
    else if ("error" in content) out.push([`${at}/requestBody/content`, content.error]);
    else out.push(...diffJson({ required: expected.required, schema: expected.schema }, { required: body.required === true, schema: content.schema }, `${at}/requestBody`));
  }

  const errorId = componentId(doc.registry, ErrorBody) ?? "ErrorBody";
  const zodResponses = new Map<string, unknown>([["200", route.ok], ...route.errors.map((status): [string, unknown] => [String(status), ErrorBody])]);
  const yamlResponses = isObject(operation.responses) ? operation.responses : {};
  for (const status of [...new Set([...zodResponses.keys(), ...Object.keys(yamlResponses)])].sort()) {
    const where = `${at}/responses/${status}`;
    const schema = zodResponses.get(status) as z.ZodType | undefined;
    const response = deref(root, yamlResponses[status]);
    if (!schema) out.push([where, "status in the YAML only"]);
    else if (!isObject(response)) out.push([where, "status in zod only"]);
    else {
      const id = schema === ErrorBody ? errorId : componentId(doc.registry, schema);
      const content = jsonContent(response.content);
      if (id === undefined) out.push([where, `${operationId} ${status}: its schema is not a registered component of ${doc.file}`]);
      else if ("error" in content) out.push([`${where}/content`, content.error]);
      else out.push(...diffJson(refTo(id), content.schema, `${where}/content/application~1json/schema`));
    }
  }
  return out;
}

/** Rules of the zod side alone: placeholders = params, and every world route carries `X-Sim-Now`. */
function checkRoute(operationId: string, route: RouteSpec): string[] {
  const errors: string[] = [];
  const placeholders = pathParamNames(route.path).sort();
  const params = Object.keys(route.params.shape).sort();
  if (placeholders.join() !== params.join()) errors.push(`${operationId}: path ${route.path} has {${placeholders.join(", ")}} but params {${params.join(", ")}}`);
  const simNow = route.headers?.shape[SIM_NOW_HEADER] as z.ZodType | undefined;
  if (route.path.startsWith("/v1/{worldId}/") && (simNow === undefined || simNow instanceof z.ZodOptional)) {
    errors.push(`${operationId}: a world route must require the ${SIM_NOW_HEADER} header`);
  }
  return errors;
}

/** Compares one document with the text of its YAML. */
export function checkDocument(doc: ContractDocument, yamlText: string): Difference[] {
  const file = `${CONTRACT_DIR}/${doc.file}`;
  const found: Difference[] = [];
  const push = (at: string, message: string) => found.push({ file, at, message });
  let root: unknown;
  try {
    root = parse(yamlText);
  } catch (error) {
    push("#", `not valid YAML: ${(error as Error).message.split("\n")[0]}`);
    return found;
  }
  if (!isObject(root)) {
    push("#", "not an OpenAPI document");
    return found;
  }
  if (typeof root.openapi !== "string" || !/^3\.1\.\d+$/.test(root.openapi)) push("#/openapi", `must be 3.1.x, got ${show(root.openapi)}`);
  const info = isObject(root.info) ? root.info : {};
  if (info.version !== CONTRACT_VERSION) push("#/info/version", `zod CONTRACT_VERSION "${CONTRACT_VERSION}" · yaml ${show(info.version)}`);

  const { schemas, unrepresentable } = renderComponents(doc);
  for (const message of unrepresentable) push("#/components/schemas", message);
  const components = isObject(root.components) ? root.components : {};
  const yamlSchemas = isObject(components.schemas) ? components.schemas : {};
  for (const id of [...new Set([...Object.keys(schemas), ...Object.keys(yamlSchemas)])].sort()) {
    const at = `#/components/schemas/${id}`;
    if (!(id in schemas)) push(at, "component in the YAML only");
    else if (!(id in yamlSchemas)) push(at, "component in zod only");
    else for (const [pointer, message] of diffJson(schemas[id], normalize(yamlSchemas[id]), at)) push(pointer, message);
  }

  const paths = isObject(root.paths) ? root.paths : {};
  const covered = new Set<string>();
  for (const [operationId, route] of Object.entries(doc.routes)) {
    for (const message of checkRoute(operationId, route)) push(`zod route ${operationId}`, message);
    const pathItem = paths[route.path];
    const operation = isObject(pathItem) ? pathItem[route.method] : undefined;
    covered.add(`${route.method} ${route.path}`);
    if (!isObject(pathItem) || !isObject(operation)) {
      push(`#/paths/${token(route.path)}/${route.method}`, `operation ${operationId} in zod only`);
      continue;
    }
    for (const [pointer, message] of compareOperation(doc, root, operationId, route, pathItem, operation)) push(pointer, message);
  }
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of METHODS) {
      if (isObject(pathItem) && pathItem[method] !== undefined && !covered.has(`${method} ${path}`)) {
        push(`#/paths/${token(path)}/${method}`, "operation in the YAML only");
      }
    }
  }
  return found;
}

/** Enums the contract mirrors from @reclamo/shared instead of importing it (the package is self-contained). */
export function checkMirrors(): Difference[] {
  const zodSide = [...PaymentNetwork.options].sort().join();
  const shared = [...Network.options].sort().join();
  if (zodSide === shared) return [];
  return [{ file: `${CONTRACT_DIR}/src/core-loans.ts`, at: "PaymentNetwork", message: `must equal Network of @reclamo/shared: ${zodSide} · ${shared}` }];
}

export function checkContract(repoRoot: string): Difference[] {
  const found = CONTRACT_DOCUMENTS.flatMap((doc) => checkDocument(doc, readFileSync(resolve(repoRoot, CONTRACT_DIR, doc.file), "utf8")));
  return [...found, ...checkMirrors()];
}

function main(): void {
  const differences = checkContract(process.cwd());
  if (differences.length > 0) {
    console.error(`core:contract: ${differences.length} difference(s) between the zod schemas and the OpenAPI documents:`);
    for (const { file, at, message } of differences) console.error(`  ${file} ${at}: ${message}`);
    process.exit(1);
  }
  const summary = CONTRACT_DOCUMENTS.map((doc) => `${doc.file} (${Object.keys(doc.routes).length} operations, ${Object.keys(renderComponents(doc).schemas).length} schemas)`);
  console.log(`core:contract: ok · ${summary.join(" · ")} match their zod schemas.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
