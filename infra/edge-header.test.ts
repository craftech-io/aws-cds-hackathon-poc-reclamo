import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EDGE_HEADER, EDGE_HEADER_PREFIX, EDGE_KVS_KEY, VIEWER_IP_HEADER, edgeHeaderInjection } from "./web-spec";

// The injection of the Router's viewer-request function (docs/architecture-guests.md §4), run as
// CloudFront runs it: inside `async function handler(event)`, with `cf` (the CloudFront runtime module
// with the Router's key-value store) in scope.

interface Header {
  value: string;
}
interface ViewerEvent {
  viewer: { ip: string };
  request: { uri: string; headers: Record<string, Header> };
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (event: ViewerEvent, cf: unknown) => Promise<void>;
const injected = new AsyncFunction("event", "cf", edgeHeaderInjection());

const STORED_KEY = "k".repeat(44);
const store = (entries: Record<string, string>) => ({
  kvs: () => ({
    get: async (key: string): Promise<string> => {
      const value = entries[key];
      if (value === undefined) throw new Error("KeyNotFound");
      return value;
    },
  }),
});

async function viewerRequest(uri: string, headers: Record<string, string>, kvs = store({ [EDGE_KVS_KEY]: STORED_KEY })): Promise<Record<string, string>> {
  const event: ViewerEvent = { viewer: { ip: "203.0.113.9" }, request: { uri, headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, { value }])) } };
  await injected(event, kvs);
  return Object.fromEntries(Object.entries(event.request.headers).map(([name, header]) => [name, header.value]));
}

describe("viewer-request edge header (docs/architecture-guests.md §4) [FL-119]", () => {
  it("drops every x-reclamo-* header a viewer sends, on every path", async () => {
    const spoofed = { "x-reclamo-edge": "guessed", "x-reclamo-viewer-ip": "10.0.0.1", "x-reclamo-anything": "x", "X-Reclamo-Mixed": "x", authorization: "Bearer t", host: "reclamo.demo.craftech.io" };
    for (const uri of ["/", "/signup", "/legal/privacy.html", "/apix"]) {
      const headers = await viewerRequest(uri, spoofed);
      expect(Object.keys(headers).sort(), uri).toEqual(["authorization", "host"]);
    }
  });

  it("adds the key of the store and the address CloudFront saw on every API route, health and public ones included", async () => {
    for (const uri of ["/api", "/api/health", "/api/inbox.list", "/api/public/signup.start", "/api/guest.status,signup.start"]) {
      const headers = await viewerRequest(uri, { [EDGE_HEADER]: "guessed", [VIEWER_IP_HEADER]: "10.0.0.1" });
      expect(headers[EDGE_HEADER], uri).toBe(STORED_KEY);
      expect(headers[VIEWER_IP_HEADER], uri).toBe("203.0.113.9");
    }
  });

  it("fails closed when the store has no key: no edge header, the request still routes (the Bff answers EDGE_REQUIRED)", async () => {
    const headers = await viewerRequest("/api/public/signup.start", { [EDGE_HEADER]: "guessed" }, store({}));
    expect(headers).not.toHaveProperty(EDGE_HEADER);
    expect(headers[VIEWER_IP_HEADER]).toBe("203.0.113.9");
  });

  it("names the same headers the Bff checks, under the edge prefix", () => {
    for (const name of [EDGE_HEADER, VIEWER_IP_HEADER]) expect(name.startsWith(EDGE_HEADER_PREFIX)).toBe(true);
    const guard = resolve(process.cwd(), "packages/bff/src/routers/edge-guard.ts");
    expect(existsSync(guard), "the Bff's edge guard").toBe(true);
    const source = readFileSync(guard, "utf8");
    expect(source).toContain(`"${EDGE_HEADER}"`);
    expect(source).toContain(`"${VIEWER_IP_HEADER}"`);
  });

  it("stays small and in the cloudfront-js-2.0 subset, and the Router runs it with the bootstrap store", () => {
    const code = edgeHeaderInjection();
    expect(code.length).toBeLessThan(1_024);
    expect(code).not.toMatch(/\bfor\s*\(|\?\.|\?\?|\bimport\b|\brequire\b/);
    const web = readFileSync(resolve(process.cwd(), "infra/web.ts"), "utf8");
    expect(web).toContain("edge: { viewerRequest: { injection: edgeHeaderInjection(), kvStore: bootstrapKvStoreArn } }");
    expect(web).toMatch(/new aws\.cloudfront\.KeyvaluestoreKey\("EdgeOriginKeyEntry", \{\n\s+keyValueStoreArn: bootstrapKvStoreArn,\n\s+key: EDGE_KVS_KEY,\n\s+value: \$util\.secret\(EdgeOriginKey\.value\),/);
  });
});
