// verify_register_chain (docs/architecture.md §8.3, ADR-0014): the first ingested anchor is the
// reference, a disagreeing anchor is ANCHOR_CONFLICT, foreign streams are ignored and reported, a seq
// without an anchor is `partial`, and an overwrite is detected even with the hashes recomputed.
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { SIM_NOW, TEST_NOW } from "../connector/testing";
import type { RegisterEntry } from "../domain/ledger";
import { writeAnchors } from "../handlers/anchor-writer";
import { anchorStreamName, cloudWatchAnchorReader } from "./anchors";
import { type ChainBuild, appendChained, chainHash } from "./register";
import { type VerifiableEntry, verifyChain, verifyRegisterChain } from "./register-verify";
import { MemoryAnchorLog, TEST_CHAIN_KEY, complaintsKit, linesNamed } from "./testing";

const STREAM = anchorStreamName("demo", 1, "REG");

/** A world whose every append is anchored by the real AnchorWriter logic into a memory log group. */
async function anchoredChain(count: number) {
  const anchors = new MemoryAnchorLog();
  const kit = complaintsKit({
    onAnchor: async (request) => {
      await writeAnchors(request, { connector: kit.connector, sink: anchors.sink(), log: kit.log, now: () => TEST_NOW });
    },
  });
  for (let index = 1; index <= count; index += 1) {
    await appendChained(kit.deps, {
      chain: "REG",
      worldId: "demo",
      epoch: 1,
      build: (): ChainBuild<"REG"> => ({
        entry: { eventType: index === 1 ? "FILED" : "STATUS", atSim: SIM_NOW, complaintId: "cmp-0001", complaintNumber: "R-2026-000123", kind: "RECLAMO", type: "PAYMENT_NOT_REFLECTED", channel: "WHATSAPP", origin: "LIVE", reason: `step-${index}` },
      }),
    });
  }
  const { entries } = await kit.connector.chains.listRegister("REG", "demo", 1);
  return { kit, anchors, entries };
}

function verify(entries: readonly RegisterEntry[] | readonly VerifiableEntry[], anchors: MemoryAnchorLog) {
  return verifyChain({ worldId: "demo", epoch: 1, chain: "REG", key: TEST_CHAIN_KEY, entries: entries as VerifiableEntry[], anchors: anchors.events });
}

/** The overwrite of seq `n` with another reason, hashes recomputed downstream with the published key. */
function rewrite(entries: readonly RegisterEntry[], seq: number): RegisterEntry[] {
  const out: RegisterEntry[] = [];
  let prevHash = "";
  for (const entry of entries) {
    const changed = entry.seq === seq ? { ...entry, reason: "rewritten" } : { ...entry };
    if (entry.seq >= seq) {
      if (entry.seq > seq) changed.prevHash = prevHash;
      changed.hash = chainHash(TEST_CHAIN_KEY, changed.prevHash, changed);
    }
    prevHash = changed.hash;
    out.push(changed);
  }
  return out;
}

describe("verify_register_chain [FL-014]", () => {
  it("[FL-014] verifies a chain whose every entry has its anchor", async () => {
    const { entries, anchors } = await anchoredChain(3);
    expect(anchors.events.map((event) => event.stream)).toEqual([STREAM, STREAM, STREAM]);
    const result = verify(entries, anchors);
    expect(result).toMatchObject({ result: "ok", entries: 3, breaks: [], anchorConflicts: [], unanchored: [], foreignAnchors: [], headHash: entries[2]?.hash });
    expect(result.brokenAt).toBeUndefined();
  });

  it("[FL-014] reports a seq without an anchor as partial, never ok", async () => {
    const { entries, anchors } = await anchoredChain(3);
    anchors.events.splice(1, 1);
    expect(verify(entries, anchors)).toMatchObject({ result: "partial", unanchored: [2], breaks: [] });
  });

  it("[FL-014] detects an overwrite with the hashes recomputed with the published key against the first anchor", async () => {
    const { entries, anchors } = await anchoredChain(3);
    const tampered = rewrite(entries, 2);
    // The recomputed chain is internally consistent: only the anchors betray it.
    expect(verifyChain({ worldId: "demo", epoch: 1, chain: "REG", key: TEST_CHAIN_KEY, entries: tampered, anchors: [] }).breaks).toEqual([]);
    expect(verify(tampered, anchors)).toMatchObject({ result: "broken", brokenAt: 2, breaks: [{ seq: 2, reason: "ANCHOR_MISMATCH" }, { seq: 3, reason: "ANCHOR_MISMATCH" }] });
  });

  it("[FL-014] a back-dated anchor of the overwritten hash is an ANCHOR_CONFLICT: ingestion order decides, not the timestamp", async () => {
    const { entries, anchors } = await anchoredChain(2);
    const tampered = rewrite(entries, 2);
    const forged = tampered[1] as RegisterEntry;
    anchors.add(STREAM, JSON.stringify({ worldId: "demo", epoch: 1, chain: "REG", seq: 2, hash: forged.hash, atReal: "2026-10-01T00:00:00.000Z" }), Date.parse("2026-10-01T00:00:00Z"));
    const result = verify(tampered, anchors);
    expect(result).toMatchObject({ result: "broken", brokenAt: 2, anchorConflicts: [2] });
    expect(result.breaks).toEqual([{ seq: 2, reason: "ANCHOR_CONFLICT" }]);
    // The same anchors listed newest first are read in ingestion order all the same.
    expect(verifyChain({ worldId: "demo", epoch: 1, chain: "REG", key: TEST_CHAIN_KEY, entries: tampered, anchors: [...anchors.events].reverse() })).toMatchObject({ anchorConflicts: [2] });
  });

  it("[FL-014] an untouched entry with a second, disagreeing anchor is still a conflict", async () => {
    const { entries, anchors } = await anchoredChain(1);
    anchors.add(STREAM, JSON.stringify({ worldId: "demo", epoch: 1, chain: "REG", seq: 1, hash: "f".repeat(64), atReal: TEST_NOW.toISOString() }));
    expect(verify(entries, anchors)).toMatchObject({ result: "broken", anchorConflicts: [1] });
  });

  it("[FL-014] ignores and reports anchors of other streams; the sibling chains' streams are not foreign", async () => {
    const { entries, anchors } = await anchoredChain(2);
    const forged = JSON.stringify({ worldId: "demo", epoch: 1, chain: "REG", seq: 1, hash: "f".repeat(64), atReal: TEST_NOW.toISOString() });
    anchors.add("demo-e1-REG-copy", forged);
    anchors.add("demo-e1-TAPE", JSON.stringify({ worldId: "demo", epoch: 1, chain: "TAPE", seq: 1, hash: "a".repeat(64), atReal: TEST_NOW.toISOString() }));
    anchors.add(STREAM, "not json");
    const result = verify(entries, anchors);
    expect(result.result).toBe("ok");
    expect(result.foreignAnchors).toEqual([expect.objectContaining({ stream: "demo-e1-REG-copy", seq: 1 }), expect.objectContaining({ stream: STREAM })]);
  });

  it("[FL-014] breaks on an edited entry, a gap in seq and an anchored entry that disappeared", async () => {
    const { entries, anchors } = await anchoredChain(3);
    const edited = entries.map((entry) => (entry.seq === 2 ? { ...entry, reason: "edited" } : entry));
    expect(verify(edited, anchors)).toMatchObject({ result: "broken", brokenAt: 2, breaks: [{ seq: 2, reason: "HASH_MISMATCH" }] });
    const gap = entries.filter((entry) => entry.seq !== 2);
    expect(verify(gap, anchors)).toMatchObject({ result: "broken", brokenAt: 2 });
    expect(verify(gap, anchors).breaks).toContainEqual({ seq: 2, reason: "ENTRY_MISSING" });
    expect(verify(entries.slice(0, 2), anchors)).toMatchObject({ result: "broken", breaks: [{ seq: 3, reason: "ENTRY_MISSING" }] });
  });

  it("verifies an empty chain as ok", () => {
    expect(verifyChain({ worldId: "demo", epoch: 1, chain: "TAPE", key: TEST_CHAIN_KEY, entries: [], anchors: [] })).toMatchObject({ result: "ok", entries: 0 });
  });

  it("[FL-014] loads the chain and the anchors and logs ChainBroken when it is broken", async () => {
    const { kit, anchors } = await anchoredChain(2);
    expect(await verifyRegisterChain(kit.deps, anchors, { worldId: "demo", epoch: 1, chain: "REG" })).toMatchObject({ result: "ok", entries: 2 });
    anchors.add(STREAM, JSON.stringify({ worldId: "demo", epoch: 1, chain: "REG", seq: 2, hash: "f".repeat(64), atReal: TEST_NOW.toISOString() }));
    const broken = await verifyRegisterChain(kit.deps, anchors, { worldId: "demo", epoch: 1, chain: "REG" });
    expect(broken.result).toBe("broken");
    expect(linesNamed(kit.lines, "register.chain_broken")[0]).toMatchObject({ metric: "ChainBroken", brokenAt: 2, anchorConflicts: 1 });
  });
});

describe("the CloudWatch anchor reader", () => {
  it("reads every page by stream prefix and keeps CloudWatch's ingestionTime", async () => {
    const logs = mockClient(CloudWatchLogsClient);
    logs
      .on(FilterLogEventsCommand)
      .resolvesOnce({ events: [{ logStreamName: STREAM, ingestionTime: 2, timestamp: 9, message: "a", eventId: "e1" }], nextToken: "t1" })
      .resolvesOnce({ events: [{ logStreamName: STREAM, ingestionTime: 3, message: "b" }, { logStreamName: STREAM, message: "no ingestion time" }] });
    const reader = cloudWatchAnchorReader(new CloudWatchLogsClient({ region: "us-east-1" }), "/app/poc/register-anchors");
    expect(await reader.read("demo", 1)).toEqual([
      { stream: STREAM, ingestionTime: 2, timestamp: 9, eventId: "e1", message: "a" },
      { stream: STREAM, ingestionTime: 3, message: "b" },
    ]);
    const calls = logs.commandCalls(FilterLogEventsCommand).map((call) => call.args[0].input);
    expect(calls).toEqual([
      { logGroupName: "/app/poc/register-anchors", logStreamNamePrefix: "demo-e1-" },
      { logGroupName: "/app/poc/register-anchors", logStreamNamePrefix: "demo-e1-", nextToken: "t1" },
    ]);
    logs.restore();
  });
});
