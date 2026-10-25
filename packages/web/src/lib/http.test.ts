import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./http";

const fast = { baseDelayMs: 1, timeoutMs: 1_000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithRetry", () => {
  it("retries network failures with backoff and returns the first response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await fetchWithRetry("/api", { method: "POST" }, fast);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 503 only on GET, never on POST", async () => {
    const getMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", getMock);
    expect((await fetchWithRetry("/api", undefined, fast)).status).toBe(200);
    expect(getMock).toHaveBeenCalledTimes(2);

    const postMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", postMock);
    expect((await fetchWithRetry("/api", { method: "POST" }, fast)).status).toBe(503);
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("down"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("/api", undefined, { ...fast, attempts: 2 })).rejects.toThrow("down");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes a timeout signal to fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithRetry("/api", undefined, fast);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
