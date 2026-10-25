// Gate before any guest credential leaves the operator (credentials go only to the private testing instructions;
// docs/architecture.md §11): every `guest-NN` account must open a world that is READY and pristine.
// Reads only (ListUsersInGroup, GetItem, Query); it never repairs anything.
//
//   npm run console:check-guests -- --stage poc                 every guest-NN of the GUEST group
//   npm run console:check-guests -- --stage poc --expect 15     and guest-01..guest-15 must all exist
//   npm run console:check-guests -- --stage poc --guest 3       only guest-03 (repeatable)
//
// A guest passes when
//   - its Cognito user exists, is enabled, has a permanent password (CONFIRMED) and `custom:worldId = gNN`;
//   - `W#gNN#WORLD/META` is READY (REGISTERED, CREATING and RESETTING fail);
//   - its `STAFF#stf-guest-NN` row is active, GUEST and bound to the user's `sub` (the pre-token trigger
//     reads nothing else);
//   - the world is pristine: clock PAUSED on Wed 07/10/2026 10:10 -03:00, the clock of the world's
//     current epoch (as the creation or the last reset wrote it), and no complaint of C01 yet.
// A world that fails is finished with `console:invite -- --guest <n> --resume` or reset, then checked
// again. `guest-test` and the QaDriver's `qa-*` guests are not handed out, so they are not checked.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CognitoIdentityProviderClient, ListUsersInGroupCommand, type UserType } from "@aws-sdk/client-cognito-identity-provider";
import { authConfig } from "../../packages/bff/src/auth/config";
import { DynamoStore } from "../../packages/bff/src/connector/dynamo/engine";
import { complaintsRepo } from "../../packages/bff/src/connector/repos/complaints";
import { runtimeRepo } from "../../packages/bff/src/connector/repos/runtime";
import { worldsRepo } from "../../packages/bff/src/connector/repos/worlds";
import type { TableStore } from "../../packages/bff/src/connector/store";
import { awsClientConfig } from "../../packages/bff/src/lib/clients";
import { parseFlags } from "../channels/cli-args";
import { COGNITO_TIMEOUTS, type CognitoUser, guestAccount, userFrom } from "./invite";

/** Simulated "now" of a pristine guest world (docs/seed-spec.md, template `guest`). */
export const PRISTINE_SIM_NOW = "2026-10-07T10:10:00-03:00";
/** C01, the customer of the 5-minute path: a pristine world has no complaint of hers yet. */
export const TOUR_CUSTOMER_ID = "cus-0001";
/** Accounts handed out to guests; `guest-test` is checked only when asked for (`--guest test`). */
const GUEST_USERNAME = /^guest-\d{2}$/;
const CHECKABLE_USERNAME = /^guest-(\d{2}|test)$/;

/** What the check reads about one guest account and its world. */
export interface GuestSnapshot {
  readonly username: string;
  readonly worldId: string;
  readonly staffId: string;
  readonly user: CognitoUser | undefined;
  readonly world: { readonly status: string; readonly epoch: number } | undefined;
  readonly staff: { readonly role: string; readonly cognitoSubKey: string; readonly active: boolean } | undefined;
  readonly clock: { readonly mode: string; readonly pausedSimNow?: string; readonly worldEpoch: number } | undefined;
  readonly tourCustomerComplaints: number;
}

/** Everything that keeps a guest account from being handed out; empty when it may go. */
export function guestProblems(snapshot: GuestSnapshot): string[] {
  const { user, world, staff, clock } = snapshot;
  const problems: string[] = [];
  if (user === undefined) problems.push("no Cognito user in the GUEST group");
  else {
    if (!user.enabled) problems.push("Cognito user disabled");
    if (user.status !== "CONFIRMED") problems.push(`password not permanent (${user.status ?? "unknown status"}): run console:invite again`);
    if (user.worldId !== snapshot.worldId) problems.push(`custom:worldId is ${user.worldId ?? "missing"}, not ${snapshot.worldId}`);
  }
  if (world === undefined) problems.push("world not registered");
  else if (world.status !== "READY") problems.push(`world ${world.status}, not READY`);
  if (staff === undefined) problems.push(`no STAFF#${snapshot.staffId} row: nobody can sign in`);
  else {
    if (!staff.active) problems.push("staff row inactive");
    if (staff.role !== "GUEST") problems.push(`staff row role ${staff.role}, not GUEST`);
    if (user !== undefined && staff.cognitoSubKey !== `SUB#${user.sub}`) problems.push("staff row bound to another Cognito user");
  }
  if (clock === undefined) problems.push("world has no clock");
  else {
    if (clock.mode !== "PAUSED") problems.push(`clock ${clock.mode}, not PAUSED`);
    if (clock.pausedSimNow === undefined || Date.parse(clock.pausedSimNow) !== Date.parse(PRISTINE_SIM_NOW)) {
      problems.push(`clock at ${clock.pausedSimNow ?? "no time"}, not ${PRISTINE_SIM_NOW}`);
    }
    if (world !== undefined && clock.worldEpoch !== world.epoch) problems.push(`clock of epoch ${clock.worldEpoch}, world at epoch ${world.epoch}`);
  }
  if (snapshot.tourCustomerComplaints > 0) problems.push(`C01 already has ${snapshot.tourCustomerComplaints} complaint(s): the world was used`);
  return problems;
}

export interface CheckGuestsArgs {
  /** Only these guest numbers, when given. */
  readonly guests: readonly string[];
  /** guest-01..guest-NN must all exist. */
  readonly expect?: number;
}

export function parseCheckGuestsArgs(argv: readonly string[]): CheckGuestsArgs {
  const guests: string[] = [];
  let expect: number | undefined;
  parseFlags(argv, {
    "--stage": (value) => {
      const stage = value();
      if (stage !== "poc") throw new RangeError(`unknown stage "${stage}": this app only has the stage poc`);
    },
    "--guest": (value) => {
      guests.push(guestAccount(value()).username);
    },
    "--expect": (value) => {
      const raw = value();
      expect = /^\d{1,2}$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(expect) || expect < 1) throw new RangeError(`--expect takes a number from 1 to 99, not "${raw}"`);
    },
  });
  return { guests, ...(expect === undefined ? {} : { expect }) };
}

export interface CheckGuestsDeps {
  readonly cognito: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId: string;
  readonly store: TableStore;
}

async function guestUsers(deps: CheckGuestsDeps): Promise<Map<string, UserType>> {
  const users = new Map<string, UserType>();
  let token: string | undefined;
  do {
    const page = await deps.cognito.send(new ListUsersInGroupCommand({ UserPoolId: deps.userPoolId, GroupName: "GUEST", Limit: 60, NextToken: token }));
    for (const user of page.Users ?? []) if (user.Username !== undefined && CHECKABLE_USERNAME.test(user.Username)) users.set(user.Username, user);
    token = page.NextToken;
  } while (token);
  return users;
}

async function snapshotOf(username: string, cognitoUser: UserType | undefined, deps: CheckGuestsDeps): Promise<GuestSnapshot> {
  const { worldId, staffId } = guestAccount(username.slice("guest-".length));
  const ctx = { store: deps.store, now: () => new Date() };
  const worlds = worldsRepo(ctx);
  const [meta, staff, clock, complaints] = await Promise.all([
    worlds.getMeta(worldId, { consistent: true }),
    worlds.getStaff(worldId, staffId),
    runtimeRepo(ctx).getClock(worldId),
    complaintsRepo(ctx).listByCustomer(worldId, TOUR_CUSTOMER_ID),
  ]);
  return {
    username,
    worldId,
    staffId,
    user: cognitoUser === undefined ? undefined : userFrom(cognitoUser.Attributes, cognitoUser.UserStatus, cognitoUser.Enabled),
    world: meta === undefined ? undefined : { status: meta.status, epoch: meta.epoch },
    staff: staff === undefined ? undefined : { role: staff.role, cognitoSubKey: staff.cognitoSubKey, active: staff.active },
    clock: clock === undefined ? undefined : { mode: clock.mode, worldEpoch: clock.worldEpoch, ...(clock.pausedSimNow ? { pausedSimNow: clock.pausedSimNow } : {}) },
    tourCustomerComplaints: complaints.filter((complaint) => complaint.origin === "LIVE").length,
  };
}

export interface GuestVerdict {
  readonly username: string;
  readonly worldId: string;
  readonly problems: readonly string[];
}

export async function checkGuests(args: CheckGuestsArgs, deps: CheckGuestsDeps): Promise<GuestVerdict[]> {
  const users = await guestUsers(deps);
  const expected = Array.from({ length: args.expect ?? 0 }, (_, index) => guestAccount(String(index + 1)).username);
  const listed = [...users.keys()].filter((username) => GUEST_USERNAME.test(username));
  const usernames = args.guests.length > 0 ? [...new Set(args.guests)] : [...new Set([...expected, ...listed])];
  if (usernames.length === 0) return [{ username: "guest-NN", worldId: "gNN", problems: ["the GUEST group has no guest-NN account"] }];
  const verdicts: GuestVerdict[] = [];
  for (const username of usernames.sort()) {
    const snapshot = await snapshotOf(username, users.get(username), deps);
    verdicts.push({ username, worldId: snapshot.worldId, problems: guestProblems(snapshot) });
  }
  return verdicts;
}

export function report(verdicts: readonly GuestVerdict[]): { lines: string[]; ok: boolean } {
  const lines = verdicts.map((verdict) =>
    verdict.problems.length === 0 ? `  ok    ${verdict.username} (${verdict.worldId}) READY and pristine` : `  FAIL  ${verdict.username} (${verdict.worldId}): ${verdict.problems.join("; ")}`,
  );
  const failed = verdicts.filter((verdict) => verdict.problems.length > 0).length;
  lines.push(failed === 0 ? `console:check-guests: ${verdicts.length} guest(s) ready to hand out.` : `console:check-guests: ${failed} of ${verdicts.length} guest(s) must not be handed out.`);
  return { lines, ok: failed === 0 };
}

async function main(): Promise<void> {
  const args = parseCheckGuestsArgs(process.argv.slice(2));
  const auth = authConfig();
  const deps: CheckGuestsDeps = {
    cognito: new CognitoIdentityProviderClient({ region: auth.region, ...awsClientConfig(COGNITO_TIMEOUTS) }),
    userPoolId: auth.userPoolId,
    store: new DynamoStore(),
  };
  const { lines, ok } = report(await checkGuests(args, deps));
  for (const line of lines) console.log(line);
  if (!ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`console:check-guests: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
