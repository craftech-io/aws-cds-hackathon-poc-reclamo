// The local servers of the landing's pipeline (WP-44): the capture server turns the in-process world's
// object links into the S3 emulator's addresses on their way to the browser, and the build is served as
// the Router serves it — files by path, the SPA for a route, nothing outside the build.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rewriteLocalLinks, withEmulatorLinks } from "./capture-server";
import { startStaticServer, staticFileOf } from "./static-files";

const ORIGIN = "http://127.0.0.1:5000";

describe("capture server links", () => {
  it("rewrites every local-s3 link of an answer into the emulator's, keys encoded by segment", () => {
    const body = JSON.stringify({ url: "local-s3://Media/receipts/norte/rcp 1.png", other: "local-s3://Exports/g03/export.csv" });
    expect(JSON.parse(rewriteLocalLinks(body, ORIGIN))).toEqual({ url: `${ORIGIN}/s3/Media/receipts/norte/rcp%201.png`, other: `${ORIGIN}/s3/Exports/g03/export.csv` });
  });

  it("decodes a base64 answer before rewriting it and leaves the others alone", () => {
    const encoded = { statusCode: 200, isBase64Encoded: true, body: Buffer.from('{"u":"local-s3://Documents/a.pdf"}').toString("base64") };
    expect(withEmulatorLinks(encoded, ORIGIN)).toEqual({ statusCode: 200, isBase64Encoded: false, body: `{"u":"${ORIGIN}/s3/Documents/a.pdf"}` });
    const plain = { statusCode: 200, body: '{"ok":true}' };
    expect(withEmulatorLinks(plain, ORIGIN)).toBe(plain);
  });
});

describe("static build server", () => {
  const root = mkdtempSync(join(tmpdir(), "reclamo-static-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(root, "assets", "app.js"), "console.log('x');".repeat(50));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("serves files by path, the SPA for a route and nothing outside the build", () => {
    expect(staticFileOf(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
    expect(staticFileOf(root, "/app/inbox")).toBe(join(root, "index.html"));
    expect(staticFileOf(root, "/missing.png")).toBeUndefined();
    expect(staticFileOf(root, "/../../etc/passwd")).toBeUndefined();
    expect(staticFileOf(root, "/%2e%2e/%2e%2e/etc/hosts")).toBeUndefined();
  });

  it("compresses text as CloudFront does when the browser accepts it", async () => {
    const server = await startStaticServer(root);
    try {
      const brotli = await fetch(`${server.origin}/assets/app.js`, { headers: { "accept-encoding": "br" } });
      expect(brotli.headers.get("content-encoding")).toBe("br");
      expect(await brotli.text()).toContain("console.log");
      const route = await fetch(`${server.origin}/signup`, { headers: { "accept-encoding": "identity" } });
      expect(route.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(route.headers.get("content-encoding")).toBeNull();
    } finally {
      await server.close();
    }
  });
});
