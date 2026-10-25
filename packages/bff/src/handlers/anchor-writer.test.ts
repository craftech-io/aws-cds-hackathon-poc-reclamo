// AnchorWriter (docs/architecture.md §8.3, ADR-0014): it re-reads every committed entry and anchors
// the STORED hash in the stream built from the entry; a forged request can only repeat what is in the
// table, never choose a hash, a stream or another world.
import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand, ResourceAlreadyExistsException } from "@aws-sdk/client-cloudwatch-logs";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { SIM_NOW, TEST_NOW } from "../connector/testing";
import { type ChainBuild, appendChained } from "../complaints/register";
import { MemoryAnchorLog, complaintsKit, linesNamed } from "../complaints/testing";
import { type AnchorWriterDeps, cloudWatchAnchorSink, writeAnchors } from "./anchor-writer";

const filed = {
  eventType: "FILED" as const,
  atSim: SIM_NOW,
  complaintId: "cmp-0001",
  complaintNumber: "R-2026-000123",
  kind: "RECLAMO" as const,
  type: "PAYMENT_NOT_REFLECTED" as const,
  channel: "WHATSAPP" as const,
  origin: "LIVE" as const,
};

async function world() {
  const kit = complaintsKit();
  const anchors = new MemoryAnchorLog();
  const deps: AnchorWriterDeps = { connector: kit.connector, sink: anchors.sink(), log: kit.log, now: () => TEST_NOW };
  const reg = await appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: filed }) });
  const tape = await appendChained(kit.deps, {
    chain: "TAPE",
    worldId: "demo",
    epoch: 1,
    build: (): ChainBuild<"TAPE"> => ({ entry: { atSim: SIM_NOW, tapeId: "tape-0001", decision: "ALLOWED", ruleIds: [], evaluated: [], ruleSetVersion: "v1", sender: "SYSTEM", channel: "WHATSAPP", kind: "COMPLAINT_ACK" } }),
  });
  return { kit, anchors, deps, reg, tape };
}

describe("AnchorWriter [FL-014]", () => {
  it("[FL-014] re-reads the committed entry and anchors its stored hash in <worldId>-e<epoch>-<chain>", async () => {
    const { anchors, deps, reg, tape } = await world();
    const result = await writeAnchors({ worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 1, pk: reg.appended.pk, sk: reg.appended.sk }] }, deps);
    expect(result).toEqual({ anchored: [1], skipped: [] });
    await writeAnchors({ worldId: "demo", epoch: 1, chain: "TAPE", entries: [{ seq: 1, pk: tape.appended.pk, sk: tape.appended.sk }] }, deps);
    expect(anchors.events.map((event) => [event.stream, JSON.parse(event.message)])).toEqual([
      ["demo-e1-REG", { worldId: "demo", epoch: 1, chain: "REG", seq: 1, hash: reg.entry.hash, atReal: TEST_NOW.toISOString() }],
      ["demo-e1-TAPE", { worldId: "demo", epoch: 1, chain: "TAPE", seq: 1, hash: tape.entry.hash, atReal: TEST_NOW.toISOString() }],
    ]);
  });

  it("[FL-014] never takes a hash from the request: a request carrying one is refused", async () => {
    const { anchors, deps, reg } = await world();
    const result = await writeAnchors({ worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 1, pk: reg.appended.pk, sk: reg.appended.sk, hash: "f".repeat(64) }] }, deps);
    expect(result).toEqual({ anchored: [], skipped: [] });
    expect(anchors.events).toEqual([]);
  });

  it("[FL-014] skips keys of another world, another epoch or another seq, and entries that do not exist", async () => {
    const { kit, anchors, deps, reg, tape } = await world();
    const result = await writeAnchors(
      {
        worldId: "g01",
        epoch: 1,
        chain: "REG",
        entries: [
          { seq: 1, pk: reg.appended.pk, sk: reg.appended.sk },
          { seq: 2, pk: "W#g01#REG#e1", sk: "000000002" },
        ],
      },
      deps,
    );
    expect(result.skipped).toEqual([
      { seq: 1, reason: "KEY_MISMATCH" },
      { seq: 2, reason: "ENTRY_MISSING" },
    ]);
    const wrongSeq = await writeAnchors({ worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 2, pk: reg.appended.pk, sk: reg.appended.sk }] }, deps);
    expect(wrongSeq.skipped).toEqual([{ seq: 2, reason: "KEY_MISMATCH" }]);
    // The tape key carries no seq: the re-read entry decides.
    const tapeSeq = await writeAnchors({ worldId: "demo", epoch: 1, chain: "TAPE", entries: [{ seq: 7, pk: tape.appended.pk, sk: tape.appended.sk }] }, deps);
    expect(tapeSeq.skipped).toEqual([{ seq: 7, reason: "ENTRY_MISMATCH" }]);
    const otherEpoch = await writeAnchors({ worldId: "demo", epoch: 2, chain: "TAPE", entries: [{ seq: 1, pk: tape.appended.pk, sk: tape.appended.sk }] }, deps);
    expect(otherEpoch.skipped).toEqual([{ seq: 1, reason: "ENTRY_MISMATCH" }]);
    expect(anchors.events).toEqual([]);
    expect(linesNamed(kit.lines, "anchor.skipped")).toHaveLength(5);
  });

  it("anchors up to 100 entries of one request in seq order and refuses more", async () => {
    const { kit, anchors, deps } = await world();
    for (let index = 0; index < 3; index += 1) await appendChained(kit.deps, { chain: "REG", worldId: "demo", epoch: 1, build: () => ({ entry: { ...filed, eventType: "STATUS" as const } }) });
    const entries = [3, 1, 2, 4].map((seq) => ({ seq, pk: "W#demo#REG#e1", sk: String(seq).padStart(9, "0") }));
    expect((await writeAnchors({ worldId: "demo", epoch: 1, chain: "REG", entries }, deps)).anchored).toEqual([1, 2, 3, 4]);
    expect(anchors.events.map((event) => (JSON.parse(event.message) as { seq: number }).seq)).toEqual([1, 2, 3, 4]);
    const tooMany = Array.from({ length: 101 }, (_, index) => ({ seq: index + 1, pk: "W#demo#REG#e1", sk: String(index + 1).padStart(9, "0") }));
    expect(await writeAnchors({ worldId: "demo", epoch: 1, chain: "REG", entries: tooMany }, deps)).toEqual({ anchored: [], skipped: [] });
  });

  it("throws when the log group cannot be written, so the asynchronous invocation retries", async () => {
    const { deps, reg } = await world();
    const failing = { ...deps, sink: { ensureStream: async () => undefined, put: async () => Promise.reject(new Error("throttled")) } };
    await expect(writeAnchors({ worldId: "demo", epoch: 1, chain: "REG", entries: [{ seq: 1, pk: reg.appended.pk, sk: reg.appended.sk }] }, failing)).rejects.toThrow("throttled");
  });
});

describe("the CloudWatch anchor sink", () => {
  it("creates the stream once (an existing one is fine) and puts the events in the anchor log group", async () => {
    const logs = mockClient(CloudWatchLogsClient);
    logs.on(CreateLogStreamCommand).rejectsOnce(new ResourceAlreadyExistsException({ message: "exists", $metadata: {} }));
    logs.on(PutLogEventsCommand).resolves({});
    const sink = cloudWatchAnchorSink("/app/poc/register-anchors", new CloudWatchLogsClient({ region: "us-east-1" }));
    await sink.ensureStream("demo-e1-REG");
    await sink.put("demo-e1-REG", [{ timestamp: 1, message: "{}" }]);
    expect(logs.commandCalls(PutLogEventsCommand)[0]?.args[0].input).toEqual({ logGroupName: "/app/poc/register-anchors", logStreamName: "demo-e1-REG", logEvents: [{ timestamp: 1, message: "{}" }] });
    logs.on(CreateLogStreamCommand).rejects(new Error("AccessDenied"));
    await expect(sink.ensureStream("demo-e1-TAPE")).rejects.toThrow("AccessDenied");
    logs.restore();
  });
});
