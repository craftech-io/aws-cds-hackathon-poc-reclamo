// A route of the contract: the zod side of one OpenAPI operation. The key of a route in its table
// is the `operationId`. The client builds the path with `fillPath` and parses the answer with `ok`
// or `ErrorBody`; the mock finds the route with `findRoute` and parses params, query, headers and
// body with the same schemas. Success is always 200; every error status answers `ErrorBody`.
import type { z } from "zod";
import type { ErrorStatus } from "./common";

export type HttpMethod = "get" | "post";

export interface RouteSpec {
  readonly method: HttpMethod;
  /** OpenAPI path template, `{name}` for each path parameter. */
  readonly path: string;
  readonly params: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly headers?: z.ZodObject;
  readonly body?: z.ZodType;
  readonly ok: z.ZodType;
  readonly errors: readonly ErrorStatus[];
}

export type RouteTable = Readonly<Record<string, RouteSpec>>;

/** Identity with a precise type, so a table keeps each route's schemas. */
export function defineRoute<const R extends RouteSpec>(route: R): R {
  return route;
}

const PLACEHOLDER = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;

function segments(path: string): string[] {
  return path.split("/").slice(1);
}

/** Names of the `{placeholders}` of a path template, in order. */
export function pathParamNames(template: string): string[] {
  return segments(template).flatMap((segment) => {
    const name = PLACEHOLDER.exec(segment)?.[1];
    return name === undefined ? [] : [name];
  });
}

/** Concrete path of a template; every value is percent-encoded as one segment. */
export function fillPath(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") throw new Error(`missing path parameter "${name}" for ${template}`);
    return encodeURIComponent(value);
  });
}

/** Path parameters of `path` when it has the shape of `template` (values decoded, not validated). */
export function matchPath(template: string, path: string): Record<string, string> | undefined {
  const expected = segments(template);
  const actual = segments(path);
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] ?? "";
    const name = PLACEHOLDER.exec(segment)?.[1];
    if (name === undefined) {
      if (segment !== value) return undefined;
      continue;
    }
    if (value === "") return undefined;
    try {
      params[name] = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return params;
}

export interface RouteMatch<T extends RouteTable> {
  readonly operationId: keyof T & string;
  readonly route: T[keyof T];
  readonly params: Record<string, string>;
}

/** The route of a table that answers `method` on `path` (the tables have no ambiguous pair). */
export function findRoute<T extends RouteTable>(routes: T, method: string, path: string): RouteMatch<T> | undefined {
  const wanted = method.toLowerCase();
  for (const operationId of Object.keys(routes) as Array<keyof T & string>) {
    const route = routes[operationId] as T[keyof T];
    if (route.method !== wanted) continue;
    const params = matchPath(route.path, path);
    if (params !== undefined) return { operationId, route, params };
  }
  return undefined;
}
