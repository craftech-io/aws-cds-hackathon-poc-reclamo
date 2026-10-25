// Compiles the storage port's conditions, updates and key conditions (connector/store.ts) into
// DynamoDB expressions. Every attribute name goes through a placeholder (`#n0`) and every value
// through another (`:v0`), so no id or text can change an expression, and a reserved word
// (`status`, `data`, `ts`) never breaks one. Placeholders are numbered in order of appearance, so
// the same operation always compiles to the same text (dynamo/expressions.test.ts).
import type { Condition, SortCondition, UpdateSpec } from "../store";

export interface CompiledExpressions {
  readonly ExpressionAttributeNames?: Record<string, string>;
  readonly ExpressionAttributeValues?: Record<string, unknown>;
}

export class ExpressionBuilder {
  private readonly names = new Map<string, string>();
  private readonly values: Record<string, unknown> = {};
  private valueCount = 0;

  /** `#n0.#n1` for `answer.inFlight`; the same segment always gets the same placeholder. */
  path(path: string): string {
    return path
      .split(".")
      .map((segment) => {
        let placeholder = this.names.get(segment);
        if (!placeholder) {
          placeholder = `#n${this.names.size}`;
          this.names.set(segment, placeholder);
        }
        return placeholder;
      })
      .join(".");
  }

  value(value: unknown): string {
    const placeholder = `:v${this.valueCount}`;
    this.valueCount += 1;
    this.values[placeholder] = value;
    return placeholder;
  }

  /** The name and value maps, each left out when empty (DynamoDB rejects an empty map). */
  attributes(): CompiledExpressions {
    const names = Object.fromEntries([...this.names].map(([name, placeholder]) => [placeholder, name]));
    return {
      ...(this.names.size > 0 ? { ExpressionAttributeNames: names } : {}),
      ...(this.valueCount > 0 ? { ExpressionAttributeValues: { ...this.values } } : {}),
    };
  }
}

const COMPARATORS = { eq: "=", lt: "<", le: "<=", gt: ">", ge: ">=" } as const;

export function compileCondition(condition: Condition, builder: ExpressionBuilder): string {
  switch (condition.op) {
    case "exists":
      return `attribute_exists(${builder.path(condition.path)})`;
    case "notExists":
      return `attribute_not_exists(${builder.path(condition.path)})`;
    case "eq":
    case "lt":
    case "le":
    case "gt":
    case "ge":
      return `${builder.path(condition.path)} ${COMPARATORS[condition.op]} ${builder.value(condition.value)}`;
    case "in": {
      if (condition.values.length === 0) throw new RangeError("IN needs at least one value");
      const name = builder.path(condition.path);
      return `${name} IN (${condition.values.map((value) => builder.value(value)).join(", ")})`;
    }
    case "beginsWith":
      return `begins_with(${builder.path(condition.path)}, ${builder.value(condition.value)})`;
    case "contains":
      return `contains(${builder.path(condition.path)}, ${builder.value(condition.value)})`;
    case "attributeType":
      return `attribute_type(${builder.path(condition.path)}, ${builder.value(condition.type)})`;
    case "and":
    case "or": {
      if (condition.conditions.length === 0) throw new RangeError(`${condition.op.toUpperCase()} needs at least one condition`);
      const parts = condition.conditions.map((child) => compileCondition(child, builder));
      return parts.length === 1 ? (parts[0] as string) : `(${parts.join(` ${condition.op.toUpperCase()} `)})`;
    }
    case "not":
      return `(NOT ${compileCondition(condition.condition, builder)})`;
  }
}

/** `SET … ADD … DELETE … REMOVE …` in DynamoDB's clause order. */
export function compileUpdate(update: UpdateSpec, builder: ExpressionBuilder): string {
  const set: string[] = [];
  for (const [path, value] of Object.entries(update.set ?? {})) set.push(`${builder.path(path)} = ${builder.value(value)}`);
  for (const [path, value] of Object.entries(update.setIfNotExists ?? {})) {
    const name = builder.path(path);
    set.push(`${name} = if_not_exists(${name}, ${builder.value(value)})`);
  }
  for (const [path, values] of Object.entries(update.append ?? {})) {
    const name = builder.path(path);
    const empty = builder.value([]);
    set.push(`${name} = list_append(if_not_exists(${name}, ${empty}), ${builder.value([...values])})`);
  }
  const add = Object.entries(update.add ?? {}).map(
    ([path, value]) => `${builder.path(path)} ${builder.value(typeof value === "number" ? value : new Set(value))}`,
  );
  const remove = Object.entries(update.deleteFromSet ?? {}).map(([path, values]) => `${builder.path(path)} ${builder.value(new Set(values))}`);
  const drop = (update.remove ?? []).map((path) => builder.path(path));
  return [
    set.length > 0 ? `SET ${set.join(", ")}` : "",
    add.length > 0 ? `ADD ${add.join(", ")}` : "",
    remove.length > 0 ? `DELETE ${remove.join(", ")}` : "",
    drop.length > 0 ? `REMOVE ${drop.join(", ")}` : "",
  ]
    .filter((clause) => clause !== "")
    .join(" ");
}

/** `#pk = :v AND <sort condition>` for a query on a table or an index. */
export function compileKeyCondition(partitionAttribute: string, partition: string, sortAttribute: string | undefined, sort: SortCondition | undefined, builder: ExpressionBuilder): string {
  const parts = [`${builder.path(partitionAttribute)} = ${builder.value(partition)}`];
  if (sort) {
    if (!sortAttribute) throw new RangeError("this index has no sort key");
    const name = builder.path(sortAttribute);
    if (sort.op === "beginsWith") parts.push(`begins_with(${name}, ${builder.value(sort.value)})`);
    else if (sort.op === "between") parts.push(`${name} BETWEEN ${builder.value(sort.low)} AND ${builder.value(sort.high)}`);
    else parts.push(`${name} ${COMPARATORS[sort.op]} ${builder.value(sort.value)}`);
  }
  return parts.join(" AND ");
}
