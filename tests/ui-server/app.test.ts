// The local UI server's back half over a real HTTP socket: the Bff handler as the stage composes it
// (edge header added by the server, real verifier pinned to the run's keys), the public routes closed
// while no self-signup is wired, and the S3 emulator checking a presigned POST the way S3 does.
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTokenIssuer, newSigningKey } from "../flows/support/issuer";
import { type UiApp, createUiApp } from "./app";
import { emulatorUploadPresigner } from "./s3-emulator";
import { staffClaims } from "./run-keys";

vi.setConfig({ testTimeout: 30_000 });

const runKey = newSigningKey();
const run = createTokenIssuer({ key: runKey });
let app: UiApp;
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    void app.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = await createUiApp({ origin, jwks: run.jwks });
}, 60_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("the Bff behind the local Router", () => {
  it("serves the real appRouter to a session signed with the run's key, and refuses one without or with another key", async () => {
    const operator = await fetch(`${origin}/api/inbox.list`, { headers: bearer(run.idToken(staffClaims("demo", "OPERATOR"))) });
    expect(operator.status).toBe(200);
    expect(operator.headers.get("cache-control")).toBe("no-store");
    const body = (await operator.json()) as { result: { data: { items: { complaintNumber: string }[] } } };
    expect(body.result.data.items.length).toBeGreaterThan(0);
    expect((await fetch(`${origin}/api/inbox.list`)).status).toBe(401);
    const stranger = createTokenIssuer({ key: newSigningKey() });
    expect((await fetch(`${origin}/api/inbox.list`, { headers: bearer(stranger.idToken(staffClaims("demo", "OPERATOR"))) })).status).toBe(401);
  });

  it("adds the edge header itself: whatever x-reclamo-* the browser sends is dropped first", async () => {
    const forged = await fetch(`${origin}/api/inbox.list`, { headers: { ...bearer(run.idToken(staffClaims("g03", "GUEST"))), "x-reclamo-edge": "forged", "x-reclamo-viewer-ip": "203.0.113.9" } });
    expect(forged.status).toBe(200);
  });

  it("keeps a guest in its own world: the demo's inbox is refused to the guest of g03", async () => {
    const guest = staffClaims("g03", "GUEST");
    const response = await fetch(`${origin}/api/inbox.list`, { headers: bearer(run.idToken({ ...guest, worldId: "demo" })) });
    expect([401, 403]).toContain(response.status);
  });

  it("answers the public procedures with the fixed closed answer while no self-signup is wired, and never under /api", async () => {
    const closed = await fetch(`${origin}/api/public/signup.availability`);
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({ error: "SIGNUP_UNAVAILABLE" });
    expect((await fetch(`${origin}/api/signup.availability`)).status).toBe(404);
  });

  it("drains the world's queues on request (a spec settles before it asserts)", async () => {
    const response = await fetch(`${origin}/__e2e/settle`, { method: "POST" });
    expect(await response.json()).toEqual({ deliveries: 0 });
  });
});

describe("the S3 emulator", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  async function post(fields: Record<string, string>, bytes: Uint8Array = png, url?: string): Promise<Response> {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append("file", new Blob([bytes], { type: "image/png" }), "receipt.png");
    return fetch(url ?? `${origin}/s3/Media`, { method: "POST", body: form });
  }

  it("stores a presigned upload with its exact key and type, and serves it back", async () => {
    const presigned = await emulatorUploadPresigner(origin)("up/demo/ui-test-1.png", "image/png");
    expect(presigned.url).toBe(`${origin}/s3/Media`);
    expect((await post(presigned.fields, png, presigned.url)).status).toBe(204);
    expect(app.world.s3.get("Media", "up/demo/ui-test-1.png")?.bytes).toEqual(png);
    const back = await fetch(`${origin}/s3/Media/up/demo/ui-test-1.png`);
    expect(back.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(png);
  });

  it("refuses another key, another type, an empty file, a field no condition names and a tampered policy", async () => {
    const { fields } = await emulatorUploadPresigner(origin)("up/demo/ui-test-2.png", "image/png");
    expect((await post({ ...fields, key: "up/demo/other.png" })).status).toBe(403);
    expect((await post({ ...fields, "Content-Type": "image/jpeg" })).status).toBe(403);
    expect((await post(fields, new Uint8Array())).status).toBe(400);
    expect((await post({ ...fields, "x-amz-meta-extra": "1" })).status).toBe(403);
    const policy = JSON.parse(Buffer.from(fields.Policy ?? "", "base64").toString("utf8")) as { conditions: unknown[] };
    policy.conditions.push(["content-length-range", 1, 99_999_999]);
    expect((await post({ ...fields, Policy: Buffer.from(JSON.stringify(policy)).toString("base64") })).status).toBe(403);
    expect(app.world.s3.keys("Media", "up/demo/ui-test-2")).toEqual([]);
  });
});
