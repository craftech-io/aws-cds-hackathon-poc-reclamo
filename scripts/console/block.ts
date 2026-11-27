// The operator's block of a console account (docs/architecture-guests.md §18). Disabling an account in
// Cognito alone does not stop it: its id token is verified offline and lives on. The block is a mark on
// the account's staff rows, which the BFF reads on every request (and again, past every cache, before
// any SMS or code): from then on every procedure answers ACCOUNT_BLOCKED. Run it with the account's
// profile, inside `sst shell`:
//
//   npm run console:block -- --user <username or email>         block
//   npm run console:block -- --user <username or email> --off   unblock
//
// Blocking, in this order: the mark on every staff row of the account's `sub`, the Cognito user
// disabled, every session signed out (refresh tokens stop working) and the passes of the SMS code of
// its sessions deleted (`Runtime/SECONDFACTOR#<sub>#*`). Unblocking: the Cognito user enabled and the
// mark cleared (an account that was inactive before stays inactive). Both are idempotent and audited
// (`ACCOUNT_BLOCKED` / `ACCOUNT_UNBLOCKED`, with the staff ids only). A web request never writes or
// clears the mark. Nothing personal is printed: a self-signup's username is its email, so the report
// names the account by the prefix of its `sub`.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { worldsRepo } from "../../packages/bff/src/connector/repos/worlds";
import type { Key, TableStore } from "../../packages/bff/src/connector/store";
import { normalizeEmail } from "../../packages/bff/src/guests/email-domain";
import { edgeAuditOp } from "../../packages/bff/src/leads/repo";
import { ulid } from "../../packages/bff/src/lib/crypto";
import { parseFlags } from "../channels/cli-args";

export interface BlockDeps {
  readonly cognito: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId: string;
  readonly store: TableStore;
  /** Keys of `Runtime` whose `pk` starts with the prefix (a filtered `Scan`: no index covers them). */
  readonly runtimeKeys: (pkPrefix: string) => Promise<readonly Key[]>;
  readonly now: () => Date;
}

export interface BlockArgs {
  readonly user: string;
  readonly off: boolean;
}

export interface BlockReport {
  readonly mode: "block" | "unblock";
  readonly subPrefix: string;
  /** `<worldId>/<staffId>` of every staff row the mark was written on or cleared from. */
  readonly staff: readonly string[];
  /** Passes of the SMS code deleted (block only). */
  readonly passesDeleted: number;
}

export function parseBlockArgs(argv: readonly string[]): BlockArgs {
  let user: string | undefined;
  let off = false;
  parseFlags(argv, {
    "--user": (value) => {
      user = value();
    },
    "--off": () => {
      off = true;
    },
  });
  const trimmed = user?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > 254 || /["\\\s]/.test(trimmed)) throw new RangeError("--user <username or email> is required");
  return { user: trimmed.includes("@") ? normalizeEmail(trimmed) : trimmed, off };
}

interface Account {
  readonly username: string;
  readonly sub: string;
}

const subOf = (attributes: readonly { Name?: string | undefined; Value?: string | undefined }[] | undefined): string | undefined => attributes?.find((attribute) => attribute.Name === "sub")?.Value;

/** The Cognito user of a username (a self-signup's is its email), or of a staff account's email attribute. */
export async function findAccount(deps: Pick<BlockDeps, "cognito" | "userPoolId">, user: string): Promise<Account | undefined> {
  try {
    const found = await deps.cognito.send(new AdminGetUserCommand({ UserPoolId: deps.userPoolId, Username: user }));
    const sub = subOf(found.UserAttributes);
    if (found.Username && sub) return { username: found.Username, sub };
  } catch (error) {
    if (!(error instanceof Error && error.name === "UserNotFoundException")) throw error;
  }
  if (!user.includes("@")) return undefined;
  const listed = await deps.cognito.send(new ListUsersCommand({ UserPoolId: deps.userPoolId, Filter: `email = "${user}"`, Limit: 2 }));
  const users = listed.Users ?? [];
  if (users.length !== 1) return undefined;
  const sub = subOf(users[0]?.Attributes);
  return users[0]?.Username && sub ? { username: users[0].Username, sub } : undefined;
}

export const secondFactorPassPrefix = (sub: string): string => `SECONDFACTOR#${sub}#`;

export async function runBlock(args: BlockArgs, deps: BlockDeps): Promise<BlockReport> {
  const account = await findAccount(deps, args.user);
  if (!account) throw new RangeError("no account of the console has that username or email");
  const worlds = worldsRepo({ store: deps.store, now: deps.now });
  const rows = await worlds.findStaffBySub(account.sub);
  const staff = rows.map((row) => `${row.worldId}/${row.staffId}`);
  const pool = { UserPoolId: deps.userPoolId, Username: account.username };
  let passesDeleted = 0;
  if (args.off) {
    await deps.cognito.send(new AdminEnableUserCommand(pool));
    for (const row of rows) await worlds.setStaffBlocked(row.worldId, row.staffId, false);
  } else {
    // The mark first: from this write on, the BFF refuses the account whatever its tokens say.
    for (const row of rows) await worlds.setStaffBlocked(row.worldId, row.staffId, true);
    await deps.cognito.send(new AdminDisableUserCommand(pool));
    await deps.cognito.send(new AdminUserGlobalSignOutCommand(pool));
    for (const key of await deps.runtimeKeys(secondFactorPassPrefix(account.sub))) {
      await deps.store.write({ kind: "delete", table: "Runtime", key });
      passesDeleted += 1;
    }
  }
  const now = deps.now();
  const action = args.off ? "ACCOUNT_UNBLOCKED" : "ACCOUNT_BLOCKED";
  await deps.store.write(edgeAuditOp({ action, outcome: rows.length > 0 ? "STAFF_MARKED" : "NO_STAFF_ROW", refs: { staff: staff.join(",") || "-" } }, ulid(now.getTime()), now));
  return { mode: args.off ? "unblock" : "block", subPrefix: account.sub.slice(0, 8), staff, passesDeleted };
}

export function describeBlock(report: BlockReport): string {
  const rows = report.staff.length > 0 ? report.staff.join(", ") : "no staff row";
  if (report.mode === "unblock") return `console:block: account ${report.subPrefix}… unblocked and enabled (${rows}).`;
  return `console:block: account ${report.subPrefix}… blocked, disabled and signed out (${rows}); ${report.passesDeleted} SMS-code pass(es) deleted.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args: BlockArgs;
  try {
    args = parseBlockArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`console:block: ${error instanceof Error ? error.message : String(error)}\nusage: npm run console:block -- --user <username or email> [--off]`);
    process.exit(2);
  }
  try {
    const { stageBlockDeps } = await import("./block-stage");
    console.log(describeBlock(await runBlock(args, stageBlockDeps())));
  } catch (error) {
    console.error(`console:block: ${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
