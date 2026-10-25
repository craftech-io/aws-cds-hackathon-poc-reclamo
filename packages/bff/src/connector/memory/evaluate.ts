// DynamoDB's semantics for the in-memory engine: how a condition reads a missing attribute, how an
// update clause changes an item, how a sort key compares. Kept apart from the engine so the rules
// are small, pure and testable one by one (memory/engine.test.ts).
import { ConnectorError } from "@reclamo/shared";
import type { AttributeType, Condition, SortCondition, UpdateSpec } from "../store";

type MutableRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Set);
}

/** Value at a dotted path, `undefined` when any segment is missing. */
export function readPath(item: unknown, path: string): unknown {
  let current: unknown = item;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((value) => b.has(value));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    const other = Object.keys(b).filter((key) => b[key] !== undefined);
    return keys.length === other.length && keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function typeOf(value: unknown): AttributeType | undefined {
  if (typeof value === "string") return "S";
  if (typeof value === "number") return "N";
  if (Array.isArray(value)) return "L";
  if (value instanceof Set) return "SS";
  return isRecord(value) ? "M" : undefined;
}

// DynamoDB compares only values of the same type; any other comparison is false.
function compare(left: unknown, right: string | number): number | undefined {
  if (typeof left !== typeof right) return undefined;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  return undefined;
}

/** Evaluates a condition against an item (`undefined` when the item does not exist). */
export function evaluate(condition: Condition, item: unknown): boolean {
  switch (condition.op) {
    case "exists":
      return readPath(item, condition.path) !== undefined;
    case "notExists":
      return readPath(item, condition.path) === undefined;
    case "eq": {
      const value = readPath(item, condition.path);
      return value !== undefined && deepEqual(value, condition.value);
    }
    case "lt":
    case "le":
    case "gt":
    case "ge": {
      const order = compare(readPath(item, condition.path), condition.value);
      if (order === undefined) return false;
      if (condition.op === "lt") return order < 0;
      if (condition.op === "le") return order <= 0;
      if (condition.op === "gt") return order > 0;
      return order >= 0;
    }
    case "in": {
      const value = readPath(item, condition.path);
      return value !== undefined && condition.values.some((candidate) => deepEqual(value, candidate));
    }
    case "beginsWith": {
      const value = readPath(item, condition.path);
      return typeof value === "string" && value.startsWith(condition.value);
    }
    case "contains": {
      const value = readPath(item, condition.path);
      if (typeof value === "string" && typeof condition.value === "string") return value.includes(condition.value);
      if (value instanceof Set) return value.has(condition.value);
      if (Array.isArray(value)) return value.some((element) => deepEqual(element, condition.value));
      return false;
    }
    case "attributeType":
      return typeOf(readPath(item, condition.path)) === condition.type;
    case "and":
      return condition.conditions.every((child) => evaluate(child, item));
    case "or":
      return condition.conditions.some((child) => evaluate(child, item));
    case "not":
      return !evaluate(condition.condition, item);
  }
}

// The map that holds the last segment of a path; DynamoDB refuses a nested SET whose parent is missing.
function parentOf(item: MutableRecord, path: string): { parent: MutableRecord; leaf: string } {
  const segments = path.split(".");
  const leaf = segments.pop() as string;
  let parent: unknown = item;
  for (const segment of segments) {
    parent = isRecord(parent) ? parent[segment] : undefined;
    if (!isRecord(parent)) throw new ConnectorError("VALIDATION", `the document path "${path}" is invalid for update`);
  }
  return { parent: parent as MutableRecord, leaf };
}

/**
 * A deep copy without `undefined` members, which is what DynamoDB stores for a value the
 * DocumentClient marshals with `removeUndefinedValues`.
 */
export function stored<T>(value: T): T {
  if (value instanceof Set) return new Set(value) as T;
  if (Array.isArray(value)) return value.filter((element) => element !== undefined).map((element) => stored(element)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, member]) => (member === undefined ? [] : [[key, stored(member)]]))) as T;
  }
  return value;
}

function setPath(item: MutableRecord, path: string, value: unknown): void {
  const { parent, leaf } = parentOf(item, path);
  parent[leaf] = stored(value);
}

function removePath(item: MutableRecord, path: string): void {
  const segments = path.split(".");
  const leaf = segments.pop() as string;
  const parent = segments.length === 0 ? item : readPath(item, segments.join("."));
  if (isRecord(parent)) delete parent[leaf];
}

function addTo(item: MutableRecord, path: string, value: number | readonly string[]): void {
  const current = item[path];
  if (typeof value === "number") {
    if (current !== undefined && typeof current !== "number") throw new ConnectorError("VALIDATION", `ADD of a number to a non-number "${path}"`);
    item[path] = (current ?? 0) + value;
    return;
  }
  if (current !== undefined && !(current instanceof Set)) throw new ConnectorError("VALIDATION", `ADD of a set to a non-set "${path}"`);
  item[path] = new Set([...(current ?? []), ...value]);
}

function deleteFrom(item: MutableRecord, path: string, values: readonly string[]): void {
  const current = item[path];
  if (current === undefined) return;
  if (!(current instanceof Set)) throw new ConnectorError("VALIDATION", `DELETE from a non-set "${path}"`);
  const next = new Set([...current].filter((value) => !values.includes(value as string)));
  if (next.size === 0) delete item[path];
  else item[path] = next;
}

/** Applies an update to a copy of the item (or to a new item with only its key), DynamoDB-style. */
export function applyUpdate(base: MutableRecord, update: UpdateSpec): MutableRecord {
  const item = stored(base);
  for (const [path, value] of Object.entries(update.set ?? {})) setPath(item, path, value);
  for (const [path, value] of Object.entries(update.setIfNotExists ?? {})) if (readPath(item, path) === undefined) setPath(item, path, value);
  for (const [path, values] of Object.entries(update.append ?? {})) {
    const current = readPath(item, path);
    if (current !== undefined && !Array.isArray(current)) throw new ConnectorError("VALIDATION", `list_append on a non-list "${path}"`);
    setPath(item, path, [...((current as unknown[] | undefined) ?? []), ...values]);
  }
  for (const [path, value] of Object.entries(update.add ?? {})) addTo(item, path, value);
  for (const [path, values] of Object.entries(update.deleteFromSet ?? {})) deleteFrom(item, path, values);
  for (const path of update.remove ?? []) removePath(item, path);
  return item;
}

/** Whether a sort attribute value satisfies a key condition. */
export function matchesSort(value: unknown, sort: SortCondition | undefined): boolean {
  if (!sort) return true;
  if (sort.op === "beginsWith") return typeof value === "string" && value.startsWith(sort.value);
  if (sort.op === "between") {
    const low = compare(value, sort.low);
    const high = compare(value, sort.high);
    return low !== undefined && high !== undefined && low >= 0 && high <= 0;
  }
  const order = compare(value, sort.value);
  if (order === undefined) return false;
  if (sort.op === "eq") return order === 0;
  if (sort.op === "lt") return order < 0;
  if (sort.op === "le") return order <= 0;
  if (sort.op === "gt") return order > 0;
  return order >= 0;
}

/** Ascending order of two sort attribute values of the same index. */
export function compareSortValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
