/**
 * Matches `/cases/:id` style patterns against a path. Returns the params on match, `undefined`
 * otherwise. Trailing slashes are ignored.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? "";
    const actual = pathParts[index] ?? "";
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return undefined;
  }
  return params;
}
