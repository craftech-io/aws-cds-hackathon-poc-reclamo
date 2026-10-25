import { describe, expect, it, vi } from "vitest";
import type { fetchWithRetry } from "../http";
import { PublicApiError, createPublicApi } from "./public-api";

const SIGNUP_ID = "abcdefghijklmnopqrstuvwxyz";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(answer: Response) {
  return vi.fn<typeof fetchWithRetry>().mockResolvedValue(answer);
}

describe("public procedures of the self-signup, one per request [FL-112] [FL-118] [FL-122]", () => {
  it("asks the availability with a GET of its own path, never a batch", async () => {
    const fetch = fakeFetch(json({ result: { data: { status: "open" } } }));
    expect(await createPublicApi({ fetch }).availability()).toEqual({ status: "open" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/public/signup.availability");
    expect(init?.method).toBe("GET");
    expect(String(url)).not.toContain("batch");
  });

  it("posts a mutation's bare input once, without retries", async () => {
    const fetch = fakeFetch(json({ result: { data: { status: "CODE_SENT", signupId: SIGNUP_ID } } }));
    const input = { email: "success+qa-run1-su1@simulator.amazonses.com", password: "UnaClaveLarga2026", acceptTerms: true, acceptContact: false, locale: "es" as const };
    expect(await createPublicApi({ fetch }).start(input)).toEqual({ status: "CODE_SENT", signupId: SIGNUP_ID });
    const [url, init, options] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/public/signup.start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(options?.attempts).toBe(1);
  });

  it("reads the edge's rate rule as RATE_LIMITED and a closed answer when the availability is throttled", async () => {
    const throttled = () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } });
    expect(await createPublicApi({ fetch: fakeFetch(throttled()) }).forgot({ email: "x@y.ar", locale: "en" })).toEqual({ status: "RATE_LIMITED" });
    expect(await createPublicApi({ fetch: fakeFetch(throttled()) }).availability()).toEqual({ status: "closed" });
  });

  it("tells a WAF challenge from the BFF's own refusals", async () => {
    const challenge = new Response("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    await expect(createPublicApi({ fetch: fakeFetch(challenge) }).resend(SIGNUP_ID)).rejects.toMatchObject({ kind: "challenge" });
    const blocked = new Response("<html>blocked</html>", { status: 403, headers: { "content-type": "text/html" } });
    await expect(createPublicApi({ fetch: fakeFetch(blocked) }).forgot({ email: "x@y.ar", locale: "es" })).rejects.toMatchObject({ kind: "challenge" });
    const bffRefusal = json({ error: { message: "bad", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400 } } }, 400);
    await expect(createPublicApi({ fetch: fakeFetch(bffRefusal) }).resend(SIGNUP_ID)).rejects.toMatchObject({ kind: "server" });
  });

  it("refuses an answer of an unexpected shape and reports a network failure as such", async () => {
    await expect(createPublicApi({ fetch: fakeFetch(json({ result: { data: { status: "MAYBE" } } })) }).availability()).rejects.toBeInstanceOf(PublicApiError);
    const offline = vi.fn<typeof fetchWithRetry>().mockRejectedValue(new TypeError("network"));
    await expect(createPublicApi({ fetch: offline }).confirm({ signupId: SIGNUP_ID, code: "123456" })).rejects.toMatchObject({ kind: "network" });
  });
});
