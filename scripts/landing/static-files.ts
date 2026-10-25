// A production build of the web app served as files on 127.0.0.1, as the Router serves it: a file of the
// build by its path, the SPA's `index.html` for any route (a path with no extension), and text compressed
// with Brotli or gzip when the browser accepts it, as CloudFront compresses it. Shared by the capture
// server and the landing's performance check.
import { existsSync, readFileSync, statSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

/** The file of the build a path names, or the SPA's `index.html` for a route; undefined outside the build. */
export function staticFileOf(root: string, pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return extname(decoded) === "" ? join(root, "index.html") : undefined;
}

export function serveStatic(root: string, request: IncomingMessage, response: ServerResponse): void {
  const file = request.method === "GET" || request.method === "HEAD" ? staticFileOf(root, new URL(request.url ?? "/", "http://capture.local").pathname) : undefined;
  if (file === undefined) {
    response.writeHead(404).end();
    return;
  }
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  const accepted = String(request.headers["accept-encoding"] ?? "");
  const text = /^(text\/|application\/json|image\/svg)/.test(type);
  const encoding = !text ? undefined : accepted.includes("br") ? "br" : accepted.includes("gzip") ? "gzip" : undefined;
  const raw = readFileSync(file);
  const body = encoding === "br" ? brotliCompressSync(raw) : encoding === "gzip" ? gzipSync(raw) : raw;
  response.writeHead(200, { "content-type": type, "cache-control": "no-store", ...(encoding ? { "content-encoding": encoding, vary: "accept-encoding" } : {}) });
  response.end(request.method === "HEAD" ? undefined : body);
}

/** The build in `root` alone on a free port of 127.0.0.1; answers its origin and how to stop it. */
export async function startStaticServer(root: string): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const base = normalize(root);
  const server = createServer((request, response) => serveStatic(base, request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
