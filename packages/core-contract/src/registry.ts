// Component registries of the two OpenAPI documents (core.openapi.yaml, networks.openapi.yaml).
// Every schema that the YAML names under `components/schemas` is registered here with the same id,
// in the registry of each document that uses it; `npm run core:contract` renders each registry as
// JSON Schema 2020-12 and compares it, component by component, with its YAML.
import { z } from "zod";

export interface ComponentMeta {
  readonly id: string;
}

export type ComponentRegistry = z.core.$ZodRegistry<ComponentMeta>;

export const coreRegistry: ComponentRegistry = z.registry<ComponentMeta>();
export const networksRegistry: ComponentRegistry = z.registry<ComponentMeta>();

const registeredIds = new WeakMap<ComponentRegistry, Set<string>>();

function register<T extends z.ZodType>(id: string, schema: T, registries: readonly ComponentRegistry[]): T {
  for (const registry of registries) {
    const ids = registeredIds.get(registry) ?? new Set<string>();
    // zod keeps the last schema registered under an id without complaining; two schemas with one
    // name would make the rendered component depend on import order.
    if (ids.has(id)) throw new Error(`contract component "${id}" registered twice`);
    ids.add(id);
    registeredIds.set(registry, ids);
    registry.add(schema, { id });
  }
  return schema;
}

/** A component of both documents. */
export function shared<T extends z.ZodType>(id: string, schema: T): T {
  return register(id, schema, [coreRegistry, networksRegistry]);
}

/** A component of core.openapi.yaml only. */
export function core<T extends z.ZodType>(id: string, schema: T): T {
  return register(id, schema, [coreRegistry]);
}

/** A component of networks.openapi.yaml only. */
export function networks<T extends z.ZodType>(id: string, schema: T): T {
  return register(id, schema, [networksRegistry]);
}

/** Id under which `schema` is a component of `registry`, if it is one. */
export function componentId(registry: ComponentRegistry, schema: z.core.$ZodType): string | undefined {
  return registry.get(schema)?.id;
}
