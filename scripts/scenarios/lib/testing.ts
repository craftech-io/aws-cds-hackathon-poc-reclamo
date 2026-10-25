// Test kit of the runner: a `QaDriver` in memory that records every call with its key and answers from a
// table per action, fake time, and a minimal snapshot. Nothing here reaches AWS.
import type { QaActionName, QaResponse } from "@reclamo/bff/qa-driver/contract";
import type { DriverClient } from "./driver-client";
import type { Snapshot, SnapshotMessage } from "./snapshot";

export interface RecordedCall {
  readonly action: QaActionName;
  readonly input: unknown;
  readonly key: string;
}

export type FakeAnswer = (input: unknown, key: string) => QaResponse | Promise<QaResponse>;

export function fakeDriver(answers: Partial<Record<QaActionName, FakeAnswer>> = {}): DriverClient & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async call(action, input, key) {
      calls.push({ action, input, key });
      const answer = answers[action];
      return answer === undefined ? { ok: true, replayed: false, result: {} } : answer(input, key);
    },
  };
}

export const okWith = (result: unknown): FakeAnswer => () => ({ ok: true, replayed: false, result });
export const refusedWith = (code: "UNAVAILABLE" | "FORBIDDEN" | "NOT_FOUND", reason?: string): FakeAnswer => () => ({ ok: false, error: { code, message: "refused", ...(reason === undefined ? {} : { reason }) } });

/** Real time that only moves when the code under test sleeps. */
export function fakeTime(start = 0) {
  let now = start;
  return { now: () => now, sleep: (ms: number) => Promise.resolve(void (now += ms)) };
}

let messageSeq = 0;

export function message(overrides: Partial<SnapshotMessage>): SnapshotMessage {
  messageSeq += 1;
  return { messageId: `msg-${messageSeq}`, direction: "OUT", channel: "WHATSAPP", kind: "REPLY", status: "SENT", body: "", templateName: null, atSim: "2026-10-07T13:10:00.000Z", turnId: null, disclosure: false, buttons: [], scan: null, ...overrides };
}

/** A snapshot with the fields the runner's helpers read; the rest empty. */
export function snapshotStub(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    worldId: "qa-812-1-sc01",
    epoch: 1,
    clock: { mode: "PAUSED", pausedSimNow: "2026-10-07T13:10:00.000Z" },
    conversation: null,
    processError: null,
    messages: [],
    complaints: [],
    timers: [],
    emails: [],
    inFlight: 0,
    turnsToday: 0,
    ...overrides,
  };
}
