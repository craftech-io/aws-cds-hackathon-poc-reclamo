import { randomUUID } from "node:crypto";
import { CognitoIdentityProviderClient, ListUsersInGroupCommand, type UserStatusType, type UserType } from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../packages/bff/src/connector/memory/engine";
import { complaintsRepo } from "../../packages/bff/src/connector/repos/complaints";
import { runtimeRepo } from "../../packages/bff/src/connector/repos/runtime";
import { worldsRepo } from "../../packages/bff/src/connector/repos/worlds";
import type { WorldStatus } from "../../packages/bff/src/domain/world";
import { type CheckGuestsDeps, PRISTINE_SIM_NOW, TOUR_CUSTOMER_ID, checkGuests, parseCheckGuestsArgs, report } from "./check-guests";
import { guestAccount } from "./invite";

const cognito = mockClient(CognitoIdentityProviderClient);
const now = () => new Date("2026-10-01T12:00:00.000Z");
let store: MemoryStore;
let users: UserType[];

interface GuestSetup {
  readonly status?: WorldStatus;
  readonly worldEpoch?: number;
  readonly clockEpoch?: number;
  readonly clockMode?: "PAUSED" | "RUNNING";
  readonly pausedSimNow?: string;
  readonly userStatus?: UserStatusType;
  readonly enabled?: boolean;
  readonly attributeWorld?: string;
  readonly staffSub?: string;
  readonly staffRow?: boolean;
  readonly register?: boolean;
}

/** A guest account and its world as `console:invite` and the world factory leave them, with overrides. */
async function guest(label: string, setup: GuestSetup = {}): Promise<void> {
  const { username, worldId, staffId, displayName } = guestAccount(label);
  const sub = randomUUID();
  users.push({
    Username: username,
    UserStatus: setup.userStatus ?? "CONFIRMED",
    Enabled: setup.enabled ?? true,
    Attributes: [
      { Name: "sub", Value: sub },
      { Name: "custom:worldId", Value: setup.attributeWorld ?? worldId },
    ],
  });
  const worlds = worldsRepo({ store, now });
  const epoch = setup.worldEpoch ?? 1;
  if (setup.register !== false) await worlds.register({ worldId, kind: "GUEST", template: "guest", epoch, status: setup.status ?? "READY" });
  if (setup.staffRow !== false) {
    await worlds.putStaff({ worldId, staffId, role: "GUEST", displayName, cognitoSubKey: `SUB#${setup.staffSub ?? sub}`, active: true });
  }
  await runtimeRepo({ store, now }).putClock({
    worldId,
    mode: setup.clockMode ?? "PAUSED",
    pausedSimNow: setup.pausedSimNow ?? "2026-10-07T13:10:00.000Z",
    worldEpoch: setup.clockEpoch ?? epoch,
  });
}

async function complaintOfC01(worldId: string, origin: "SEED" | "LIVE"): Promise<void> {
  await store.write(
    complaintsRepo({ store, now }).createOp({
      worldId,
      complaintId: `cmp-${origin.toLowerCase()}`,
      complaintNumber: origin === "SEED" ? "R-2026-000100" : "R-2026-000123",
      epoch: 1,
      customerId: TOUR_CUSTOMER_ID,
      kind: "RECLAMO",
      type: "PAYMENT_NOT_REFLECTED",
      status: "REGISTERED",
      priority: "NORMAL",
      origin,
      control: "AGENT",
      channel: "WHATSAPP",
      summary: "Pago no reflejado",
      filedAtSim: "2026-10-07T13:12:00.000Z",
      deadlineSim: "2026-10-21T13:12:00.000Z",
      slaState: "ON_TIME",
      emailAnswerConsent: { status: "PENDING" },
      statusHistory: [],
    }),
  );
}

function deps(): CheckGuestsDeps {
  return { cognito: new CognitoIdentityProviderClient({ region: "us-east-1" }), userPoolId: "us-east-1_TESTPOOL1", store };
}

async function problemsOf(label: string): Promise<readonly string[]> {
  const verdicts = await checkGuests({ guests: [guestAccount(label).username] }, deps());
  return verdicts[0]?.problems ?? ["no verdict"];
}

beforeEach(() => {
  store = new MemoryStore();
  users = [];
  cognito.reset();
  // Two pages, to prove the listing follows NextToken.
  cognito.on(ListUsersInGroupCommand).callsFake((input) =>
    input.NextToken === undefined ? { Users: users.slice(0, 2), NextToken: users.length > 2 ? "page-2" : undefined } : { Users: users.slice(2) },
  );
});

describe("console:check-guests", () => {
  it("passes a guest whose world is READY and pristine, reading only", async () => {
    await guest("1");
    await guest("2");
    await guest("3");
    const writes = vi.spyOn(store, "write");
    const verdicts = await checkGuests({ guests: [] }, deps());
    expect(verdicts).toEqual([
      { username: "guest-01", worldId: "g01", problems: [] },
      { username: "guest-02", worldId: "g02", problems: [] },
      { username: "guest-03", worldId: "g03", problems: [] },
    ]);
    expect(report(verdicts).ok).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(cognito.calls().map((call) => (call.args[0] as object).constructor.name)).toEqual(["ListUsersInGroupCommand", "ListUsersInGroupCommand"]);
  });

  it("fails a world that is RESETTING, CREATING, REGISTERED or not registered", async () => {
    await guest("1", { status: "RESETTING" });
    await guest("2", { status: "CREATING" });
    await guest("3", { status: "REGISTERED" });
    await guest("4", { register: false });
    expect(await problemsOf("1")).toContain("world RESETTING, not READY");
    expect(await problemsOf("2")).toContain("world CREATING, not READY");
    expect(await problemsOf("3")).toContain("world REGISTERED, not READY");
    expect(await problemsOf("4")).toContain("world not registered");
  });

  it("fails a world that was used: clock moved or running, or a live complaint of C01", async () => {
    await guest("1", { pausedSimNow: "2026-10-08T13:10:00.000Z" });
    await guest("2", { clockMode: "RUNNING" });
    await guest("3");
    await complaintOfC01("g03", "LIVE");
    expect(await problemsOf("1")).toEqual([`clock at 2026-10-08T13:10:00.000Z, not ${PRISTINE_SIM_NOW}`]);
    expect(await problemsOf("2")).toEqual(["clock RUNNING, not PAUSED"]);
    expect(await problemsOf("3")).toEqual(["C01 already has 1 complaint(s): the world was used"]);
  });

  it("accepts a reset world (new epoch, fresh clock) and the seeded history of C01", async () => {
    await guest("1", { worldEpoch: 2 });
    await complaintOfC01("g01", "SEED");
    expect(await problemsOf("1")).toEqual([]);
    await guest("2", { worldEpoch: 2, clockEpoch: 1 });
    expect(await problemsOf("2")).toEqual(["clock of epoch 1, world at epoch 2"]);
  });

  it("fails an account nobody can use: temporary password, disabled, wrong world, missing or foreign staff row", async () => {
    await guest("1", { userStatus: "FORCE_CHANGE_PASSWORD" });
    await guest("2", { enabled: false });
    await guest("3", { attributeWorld: "g09" });
    await guest("4", { staffRow: false });
    await guest("5", { staffSub: "someone-else" });
    expect(await problemsOf("1")).toEqual(["password not permanent (FORCE_CHANGE_PASSWORD): run console:invite again"]);
    expect(await problemsOf("2")).toEqual(["Cognito user disabled"]);
    expect(await problemsOf("3")).toEqual(["custom:worldId is g09, not g03"]);
    expect(await problemsOf("4")).toEqual(["no STAFF#stf-guest-04 row: nobody can sign in"]);
    expect(await problemsOf("5")).toEqual(["staff row bound to another Cognito user"]);
  });

  it("requires guest-01..guest-NN with --expect and fails on an empty GUEST group", async () => {
    await guest("1");
    await guest("2");
    const verdicts = await checkGuests({ guests: [], expect: 3 }, deps());
    expect(verdicts.map((verdict) => [verdict.username, verdict.problems.length > 0])).toEqual([
      ["guest-01", false],
      ["guest-02", false],
      ["guest-03", true],
    ]);
    expect(verdicts[2]?.problems).toContain("no Cognito user in the GUEST group");
    const { lines, ok } = report(verdicts);
    expect(ok).toBe(false);
    expect(lines.at(-1)).toBe("console:check-guests: 1 of 3 guest(s) must not be handed out.");

    users = [];
    expect(report(await checkGuests({ guests: [] }, deps())).ok).toBe(false);
  });

  it("checks only guest-NN by default: guest-test and the QaDriver's qa-* guests are never handed out", async () => {
    await guest("1");
    await guest("test", { status: "RESETTING" });
    users.push({ Username: "qa-r1-sc22j-guest", UserStatus: "CONFIRMED", Enabled: true, Attributes: [{ Name: "sub", Value: randomUUID() }] });
    expect((await checkGuests({ guests: [] }, deps())).map((verdict) => verdict.username)).toEqual(["guest-01"]);
    expect(await problemsOf("test")).toEqual(["world RESETTING, not READY"]);
  });

  it("takes --stage poc, --expect and repeated --guest", () => {
    expect(parseCheckGuestsArgs(["--stage", "poc", "--guest", "3", "--guest", "12"])).toEqual({ guests: ["guest-03", "guest-12"] });
    expect(parseCheckGuestsArgs(["--expect", "15"])).toEqual({ guests: [], expect: 15 });
    expect(() => parseCheckGuestsArgs(["--stage", "dev"])).toThrow('unknown stage "dev"');
    expect(() => parseCheckGuestsArgs(["--expect", "0"])).toThrow("--expect");
    expect(() => parseCheckGuestsArgs(["--guest", "100"])).toThrow(RangeError);
  });
});
