// The one client of the Harness (docs/architecture.md §7 and §9.1): the request it sends, how it reads
// the stream, and the retry of a `ThrottlingException` (at most 3 times, within the turn's deadline).
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { describe, expect, it } from "vitest";
import { HARNESS_THROTTLE_RETRIES, HarnessError, type HarnessLink, type HarnessSend, createHarnessClient, harnessRequest, outcomeOf, readHarnessStream } from "./harness-client";
import { buildSystemPrompt } from "./system-prompt";

const LINK: HarnessLink = { harnessArn: "arn:aws:bedrock-agentcore:us-east-1:000000000000:harness/test", endpointName: "live", timeoutSeconds: 120, maxIterations: 12 };
const NOW = Date.parse("2026-10-07T13:10:00.000Z");
const DELIMITER = "inbound-7f3a9c0b1d2e";

const turnRequest = (deadlineMs = NOW + 330_000) => ({
  runtimeSessionId: "a".repeat(48),
  actorId: "w-demo-cus-0001-e1",
  envelope: '<session token="x"/>',
  systemPrompt: buildSystemPrompt({ delimiter: DELIMITER }),
  deadlineMs,
});

async function* stream(events: readonly InvokeHarnessStreamOutput[]): AsyncGenerator<InvokeHarnessStreamOutput> {
  for (const event of events) yield event;
}

const usage = (inputTokens: number, outputTokens: number, cache = 0) =>
  ({ metadata: { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadInputTokens: cache, cacheWriteInputTokens: 0 }, metrics: { latencyMs: 1 } } }) as InvokeHarnessStreamOutput;

/** Two model calls: one tool use, then the final text. */
const TURN = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Le pido el comprobante." } } },
  { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "t1", name: "messaging___send_whatsapp" } } } },
  { messageStop: { stopReason: "tool_use" } },
  usage(1_000, 100, 400),
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Pedí el comprobante " } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "al cliente." } } },
  { messageStop: { stopReason: "end_turn" } },
  usage(1_500, 200, 900),
] as InvokeHarnessStreamOutput[];

function throttled(): Error {
  return Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } });
}

function client(send: HarnessSend, nowMs: () => number = () => NOW, sleeps: number[] = []) {
  return createHarnessClient({ link: () => LINK, send, nowMs, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
}

describe("the request", () => {
  it("names the Harness, its live endpoint, the turn's session and actor, the envelope and the prompt; never a model or tools", () => {
    const input = harnessRequest(LINK, turnRequest());
    expect(input).toEqual({
      harnessArn: LINK.harnessArn,
      qualifier: "live",
      runtimeSessionId: "a".repeat(48),
      actorId: "w-demo-cus-0001-e1",
      messages: [{ role: "user", content: [{ text: '<session token="x"/>' }] }],
      systemPrompt: [{ text: buildSystemPrompt({ delimiter: DELIMITER }) }],
      maxIterations: 12,
      timeoutSeconds: 120,
    });
    expect(input).not.toHaveProperty("model");
    expect(input).not.toHaveProperty("tools");
    expect(input.systemPrompt?.[0]?.text).toContain(DELIMITER);
  });
});

describe("reading the stream", () => {
  it("keeps the last assistant message as the note, sums the usage of every model call and counts tool uses", async () => {
    const result = await readHarnessStream(stream(TURN));
    expect(result).toEqual({
      outcome: "COMPLETED",
      stopReason: "end_turn",
      note: "Pedí el comprobante al cliente.",
      usage: { inputTokens: 2_500, outputTokens: 300, cacheReadTokens: 1_300, cacheWriteTokens: 0 },
      toolUses: 1,
    });
  });

  it("maps the stop reasons: guardrails, completions and everything else (max_tokens is incomplete)", () => {
    expect(outcomeOf("end_turn")).toBe("COMPLETED");
    expect(outcomeOf("stop_sequence")).toBe("COMPLETED");
    expect(outcomeOf("content_filtered")).toBe("GUARDRAIL");
    expect(outcomeOf("guardrail_intervened")).toBe("GUARDRAIL");
    expect(outcomeOf("max_tokens")).toBe("INCOMPLETE");
    expect(outcomeOf("max_iterations_exceeded")).toBe("INCOMPLETE");
    expect(outcomeOf("none")).toBe("INCOMPLETE");
  });

  it("a stream without a stop is incomplete, and an exception inside the stream fails it", async () => {
    expect((await readHarnessStream(stream([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "a medias" } } } as InvokeHarnessStreamOutput]))).outcome).toBe("INCOMPLETE");
    await expect(readHarnessStream(stream([{ internalServerException: { name: "InternalServerException", message: "boom" } } as unknown as InvokeHarnessStreamOutput]))).rejects.toMatchObject({ kind: "STREAM" });
  });

  it("caps the note at 4,000 characters", async () => {
    const long = [{ messageStart: { role: "assistant" } }, { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x".repeat(5_000) } } }, { messageStop: { stopReason: "end_turn" } }] as InvokeHarnessStreamOutput[];
    expect((await readHarnessStream(stream(long))).note).toHaveLength(4_000);
  });
});

describe("ThrottlingException", () => {
  it("retries with backoff and jitter, at most 3 times, then answers THROTTLED for the queue", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const harness = client(
      async () => {
        calls += 1;
        throw throttled();
      },
      () => NOW,
      sleeps,
    );
    const error = await harness.invoke(turnRequest(NOW + 3_600_000)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).kind).toBe("THROTTLED");
    expect(calls).toBe(HARNESS_THROTTLE_RETRIES + 1);
    expect(sleeps).toEqual([500, 1_000, 2_000]);
  });

  it("a throttled call that then succeeds returns the turn with its attempts", async () => {
    let calls = 0;
    const harness = client(async () => {
      calls += 1;
      if (calls < 3) throw throttled();
      return { stream: stream(TURN) };
    });
    expect(await harness.invoke(turnRequest(NOW + 3_600_000))).toMatchObject({ outcome: "COMPLETED", attempts: 3 });
  });

  it("does not retry when the turn's deadline leaves no room for a whole attempt", async () => {
    let calls = 0;
    const harness = client(async () => {
      calls += 1;
      throw throttled();
    });
    await expect(harness.invoke(turnRequest(NOW + 150_400))).rejects.toMatchObject({ kind: "THROTTLED" });
    expect(calls).toBe(1);
  });

  it("never retries any other error: a call that reached the model may already have used tools", async () => {
    let calls = 0;
    const harness = client(async () => {
      calls += 1;
      throw Object.assign(new Error("bad"), { name: "ValidationException" });
    });
    await expect(harness.invoke(turnRequest())).rejects.toMatchObject({ kind: "REQUEST" });
    expect(calls).toBe(1);
  });

  it("a turn past its deadline is a TIMEOUT, and an answer without a stream is a STREAM error", async () => {
    await expect(client(async () => ({ stream: stream(TURN) })).invoke(turnRequest(NOW - 1))).rejects.toMatchObject({ kind: "TIMEOUT" });
    await expect(client(async () => ({})).invoke(turnRequest())).rejects.toMatchObject({ kind: "STREAM" });
  });
});
