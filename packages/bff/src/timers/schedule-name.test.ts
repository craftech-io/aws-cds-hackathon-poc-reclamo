// Schedule names (docs/architecture.md §10): one per timer, epoch and world, readable prefix, a hash of
// the timer key, at most 64 characters; the dispatcher checks the fired ARN against it (FL-099).
import { describe, expect, it } from "vitest";
import { SCHEDULE_ARN_PLACEHOLDER, SCHEDULE_NAME_MAX, ScheduleNameError, arnMatchesTimer, atExpression, parseScheduleArn, scheduleNameOf } from "./schedule-name";
import { scheduleInputJson, unqualifiedFunctionArn } from "./scheduler-client";

const KEY = (worldId: string, rest = "SETTLEMENT_PUBLISH#NORTE-2026-10-07") => `W#${worldId}#TIMER#${rest}`;
const ARN = (name: string, group = "aws-cds-hackathon-poc-reclamo-poc-schedules") => `arn:aws:scheduler:us-east-1:776805327629:schedule/${group}/${name}`;

describe("schedule names [FL-099]", () => {
  it("[FL-099] is tm-<worldId>-e<epoch>-<16 base32 of the timer key>, lower case", () => {
    const name = scheduleNameOf("g01", 3, KEY("g01"));
    expect(name).toMatch(/^tm-g01-e3-[a-z2-7]{16}$/);
    expect(name).toBe(scheduleNameOf("g01", 3, KEY("g01")));
  });

  it("[FL-099] two guest worlds with the same template timers never share a name", () => {
    expect(scheduleNameOf("g01", 1, KEY("g01"))).not.toBe(scheduleNameOf("g02", 1, KEY("g02")));
    expect(scheduleNameOf("gs-abcdefghij", 1, KEY("gs-abcdefghij"))).not.toBe(scheduleNameOf("gs-abcdefghik", 1, KEY("gs-abcdefghik")));
  });

  it("a new epoch and another timer of the same world get other names", () => {
    expect(scheduleNameOf("demo", 1, KEY("demo"))).not.toBe(scheduleNameOf("demo", 2, KEY("demo")));
    expect(scheduleNameOf("demo", 1, KEY("demo"))).not.toBe(scheduleNameOf("demo", 1, KEY("demo", "SLA#cmp-0001-DEADLINE")));
  });

  it("keeps the QA prefix the QaDriver's fence names (tm-qa-…)", () => {
    expect(scheduleNameOf("qa-r1-sc15", 1, KEY("qa-r1-sc15"))).toMatch(/^tm-qa-r1-sc15-e1-/);
  });

  it("fits in 64 characters for a world id of 24 and refuses what would not", () => {
    const world = "qa-abcdefghij-sc-15-lat1";
    expect(world).toHaveLength(24);
    expect(scheduleNameOf(world, 123456, KEY(world)).length).toBeLessThanOrEqual(SCHEDULE_NAME_MAX);
    const long = "qa-abcdefghijklmnopqrstuvwxyz-0123456789-sc";
    expect(() => scheduleNameOf(long, 1, KEY(long))).toThrow(ScheduleNameError);
  });

  it("refuses a timer key of another world and an invalid epoch", () => {
    expect(() => scheduleNameOf("g01", 1, KEY("g02"))).toThrow(ScheduleNameError);
    expect(() => scheduleNameOf("g01", -1, KEY("g01"))).toThrow(ScheduleNameError);
  });
});

describe("schedule ARN check [FL-099]", () => {
  const expected = { worldId: "g01", epoch: 1, timerKey: KEY("g01") };

  it("[FL-099] accepts the ARN of the timer's own schedule and nothing else", () => {
    const name = scheduleNameOf("g01", 1, KEY("g01"));
    expect(parseScheduleArn(ARN(name))).toEqual({ group: "aws-cds-hackathon-poc-reclamo-poc-schedules", name });
    expect(arnMatchesTimer(ARN(name), expected)).toBe(true);
    expect(arnMatchesTimer(ARN(scheduleNameOf("g02", 1, KEY("g02"))), expected)).toBe(false);
    expect(arnMatchesTimer(ARN(scheduleNameOf("g01", 2, KEY("g01"))), expected)).toBe(false);
    expect(arnMatchesTimer(ARN(name, "another-group"), { ...expected, group: "aws-cds-hackathon-poc-reclamo-poc-schedules" })).toBe(false);
    expect(arnMatchesTimer(SCHEDULE_ARN_PLACEHOLDER, expected)).toBe(false);
    expect(arnMatchesTimer("not an arn", expected)).toBe(false);
  });

  it("the schedule's input asks the Scheduler for its own ARN", () => {
    const input = JSON.parse(scheduleInputJson({ worldId: "g01", timerKey: KEY("g01"), version: 2, epoch: 1, dueAtSim: "2026-10-08T08:30:00-03:00" })) as Record<string, unknown>;
    expect(input).toEqual({ worldId: "g01", timerKey: KEY("g01"), version: 2, epoch: 1, dueAtSim: "2026-10-08T08:30:00-03:00", scheduleArn: "<aws.scheduler.schedule-arn>" });
  });
});

describe("at() expressions", () => {
  it("are UTC and never early: a fraction of a second rounds up", () => {
    expect(atExpression(new Date("2026-10-07T13:10:00.000Z"))).toBe("at(2026-10-07T13:10:00)");
    expect(atExpression(new Date("2026-10-07T13:10:00.200Z"))).toBe("at(2026-10-07T13:10:01)");
    expect(() => atExpression(new Date(Number.NaN))).toThrow(ScheduleNameError);
  });
});

describe("ScheduleDispatch as its own target", () => {
  it("drops a version or alias qualifier from the invoked ARN", () => {
    const arn = "arn:aws:lambda:us-east-1:776805327629:function:reclamo-poc-ScheduleDispatch";
    expect(unqualifiedFunctionArn(arn)).toBe(arn);
    expect(unqualifiedFunctionArn(`${arn}:live`)).toBe(arn);
  });
});
