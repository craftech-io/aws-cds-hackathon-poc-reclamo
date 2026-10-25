// Console accounts of Reclamo en regla (docs/architecture.md §11 and §17 item 4).
// The operator runs it from a laptop inside `sst shell`, never from CI:
//
//   npm run console:invite -- --stage poc --guest 3              guest-03 in its own world g03, READY on exit
//   npm run console:invite -- --stage poc --guest 3 --resume     finishes a world an interrupted run left CREATING
//   npm run console:invite -- --stage poc --guest test           guest-test in gtest (optional manual check only)
//   npm run console:invite -- --stage poc --world demo --role OPERATOR --email <address of demoRecipients>
//                             [--username operator-02] [--name "<display name>"]
//
// Guests: `AdminCreateUser` without email and without a message, `custom:worldId = gNN` (immutable),
// a permanent random password, no MFA, group GUEST; then packages/bff/src/worlds/guest-world.ts
// pre-registers the world (`META REGISTERED` + `STAFF#stf-guest-NN` with the `sub`) and builds it until
// `READY`. The password is written once to scripts/console/guest-credentials.local.json (mode 600,
// ignored by git, refused by CI) and never printed; it only travels to the private testing
// instructions of the submission. Until the world factory exists (WP-34) `--guest` fails with
// UNAVAILABLE before it creates any user.
//
// Staff: only in the `demo` world, only for an address of `SeedOverrides.demoRecipients.emails`
// (checked before anything is created) and only once the pool sends from the app's SES identity
// (infra/auth-email.ts); Cognito emails the temporary password, the first sign-in asks for a new one.
// The email is never marked verified (`staffUserAttributes`): staff recover only through an administrator.
// The `STAFF#` row is written with the returned `sub`: without it the pre-token trigger lets nobody in.
//
// Idempotent: an existing user is reused (never re-invited, its immutable world checked, a guest's
// password kept once it is permanent). `gprobe` (the fence-probe world), guest worlds for staff and
// `qa-*` users are refused. Emails are printed masked; passwords never.
import { randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminSetUserPasswordCommand,
  type AttributeType,
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { z } from "zod";
import { ConnectorError, maskEmail, normalizeEmail, worldKindOf } from "@reclamo/shared";
import { authConfig } from "../../packages/bff/src/auth/config";
import { DynamoStore } from "../../packages/bff/src/connector/dynamo/engine";
import { worldsRepo } from "../../packages/bff/src/connector/repos/worlds";
import type { TableStore } from "../../packages/bff/src/connector/store";
import { awsClientConfig } from "../../packages/bff/src/lib/clients";
import { secretValue } from "../../packages/bff/src/lib/secrets";
import { assertGuestWorldFactory, createGuestWorld, type GuestWorldRequest, type GuestWorldResult } from "../../packages/bff/src/worlds/guest-world";
import { parseFlags } from "../channels/cli-args";

export const APP_DOMAIN = "reclamo.demo.craftech.io";
/** FROM of the invitations once the pool sends through SES (infra/auth-email.ts). */
export const INVITATION_SENDER = `no-reply@${APP_DOMAIN}`;
export const WORLD_ATTRIBUTE = "custom:worldId";
export const CREDENTIALS_FILE = "scripts/console/guest-credentials.local.json";
export const STAFF_ROLES = ["OPERATOR", "SUPERVISOR", "COMPLIANCE"] as const;
export type StaffInviteRole = (typeof STAFF_ROLES)[number];

/** Cognito answers in well under a second; three attempts with backoff inside the SDK. */
export const COGNITO_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 2_000, maxAttempts: 3 } as const;

interface Account {
  readonly username: string;
  readonly worldId: string;
  readonly staffId: string;
  readonly displayName: string;
}
export interface GuestInvitation extends Account {
  readonly kind: "guest";
  readonly resume: boolean;
}
export interface StaffInvitation extends Account {
  readonly kind: "staff";
  readonly role: StaffInviteRole;
  readonly email: string;
}
export type Invitation = GuestInvitation | StaffInvitation;

/** `guest-NN` in `gNN` (NN = 01..99), or `guest-test` in `gtest`. */
export function guestAccount(label: string): Account {
  if (label === "test") return { username: "guest-test", worldId: "gtest", staffId: "stf-guest-test", displayName: "Guest test" };
  const n = /^\d{1,2}$/.test(label) ? Number(label) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new RangeError(`--guest takes a number from 1 to 99 or "test", not "${label}"`);
  const nn = String(n).padStart(2, "0");
  return { username: `guest-${nn}`, worldId: `g${nn}`, staffId: `stf-guest-${nn}`, displayName: `Guest ${nn}` };
}

export const USAGE =
  "usage: console:invite -- [--stage poc] --guest <1-99|test> [--resume]\n" +
  "       console:invite -- [--stage poc] --world demo --role <OPERATOR|SUPERVISOR|COMPLIANCE> --email <address> [--username <role>-NN] [--name <display name>]";

export function parseInviteArgs(argv: readonly string[]): Invitation {
  const flags: Record<string, string | undefined> = {};
  let resume = false;
  const option = (name: string) => (value: () => string) => {
    flags[name] = value();
  };
  parseFlags(argv, {
    "--stage": option("stage"),
    "--guest": option("guest"),
    "--world": option("world"),
    "--role": option("role"),
    "--email": option("email"),
    "--username": option("username"),
    "--name": option("name"),
    "--resume": () => {
      resume = true;
    },
  });
  if (flags.stage !== undefined && flags.stage !== "poc") throw new RangeError(`unknown stage "${flags.stage}": this app only has the stage poc`);
  if (flags.guest !== undefined) {
    if (["world", "role", "email", "username", "name"].some((name) => flags[name] !== undefined)) {
      throw new RangeError("--guest takes no --world, --role, --email, --username or --name: a guest has no email and gets its own world");
    }
    return { kind: "guest", ...guestAccount(flags.guest), resume };
  }
  if (resume) throw new RangeError("--resume only applies to --guest");
  const { world, role, email } = flags;
  if (world === undefined || role === undefined || email === undefined) throw new RangeError("a staff account needs --world, --role and --email");
  if (world === "gprobe") throw new RangeError("gprobe is the fence-probe world: no console account ever signs in to it");
  const kind = worldKindOf(world);
  if (kind === "GUEST") throw new RangeError(`${world} is a guest world: it only gets its guest account (--guest)`);
  if (kind !== "DEMO") throw new RangeError(`staff accounts belong to the demo world, not "${world}" (qa-* users are the QaDriver's)`);
  if (role === "GUEST") throw new RangeError("guest accounts are created with --guest <n>");
  const staffRole = STAFF_ROLES.find((candidate) => candidate === role);
  if (staffRole === undefined) throw new RangeError(`--role must be one of ${STAFF_ROLES.join(", ")}`);
  const username = flags.username ?? `${staffRole.toLowerCase()}-01`;
  if (!new RegExp(`^${staffRole.toLowerCase()}-\\d{2}$`).test(username)) throw new RangeError(`--username must be ${staffRole.toLowerCase()}-NN for the role ${staffRole}`);
  let address: string;
  try {
    address = normalizeEmail(email);
  } catch {
    throw new RangeError("--email is not an email address");
  }
  const displayName = (flags.name ?? username).trim();
  if (displayName.length === 0 || displayName.length > 120) throw new RangeError("--name must have 1 to 120 characters");
  return { kind: "staff", username, worldId: world, staffId: `stf-${username}`, displayName, role: staffRole, email: address };
}

const SeedOverridesRecipients = z.looseObject({
  demoRecipients: z.looseObject({ emails: z.array(z.string()).max(5).optional() }).optional(),
});

/** `SeedOverrides.demoRecipients.emails`, normalized; only @craftech.io addresses (docs/architecture.md §3). */
export function demoRecipientsOf(seedOverridesJson: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(seedOverridesJson);
  } catch {
    // JSON.parse quotes the input in its message, and the secret holds real addresses.
    throw new Error("SeedOverrides is not valid JSON");
  }
  const parsed = SeedOverridesRecipients.safeParse(json);
  if (!parsed.success) throw new Error("SeedOverrides.demoRecipients.emails must be a list of at most 5 addresses");
  const emails = (parsed.data.demoRecipients?.emails ?? []).map((email) => normalizeEmail(email));
  if (emails.some((email) => !email.endsWith("@craftech.io"))) throw new Error("SeedOverrides.demoRecipients.emails may only hold @craftech.io addresses");
  return emails;
}

const PASSWORD_CLASSES = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+-=?@^_"] as const;

/** 24 random characters with every class the pool's password policy requires (infra/auth.ts). */
export function generatePassword(length = 24): string {
  const all = PASSWORD_CLASSES.join("");
  const chars = PASSWORD_CLASSES.map((set) => set[randomInt(set.length)] ?? "");
  while (chars.length < length) chars.push(all[randomInt(all.length)] ?? "");
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [chars[index], chars[other]] = [chars[other] ?? "", chars[index] ?? ""];
  }
  return chars.join("");
}

/** Merges one guest credential into the local file (mode 600) and returns its path. */
export function saveCredential(file: string, entry: { username: string; worldId: string; password: string }, now: Date): string {
  const path = resolve(process.cwd(), file);
  const current: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const all = typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {};
  all[entry.username] = { worldId: entry.worldId, password: entry.password, setAt: now.toISOString() };
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export interface CognitoUser {
  readonly sub: string;
  readonly worldId: string | undefined;
  readonly email: string | undefined;
  readonly status: string | undefined;
  readonly enabled: boolean;
}

export function userFrom(attributes: readonly AttributeType[] | undefined, status: string | undefined, enabled: boolean | undefined): CognitoUser {
  const value = (name: string) => attributes?.find((attribute) => attribute.Name === name)?.Value;
  const sub = value("sub");
  if (sub === undefined) throw new Error("Cognito returned a user without sub");
  return { sub, worldId: value(WORLD_ATTRIBUTE), email: value("email"), status, enabled: enabled ?? true };
}

/**
 * Attributes of a new staff user: its email (where Cognito sends the invitation) and its immutable
 * world. Never `email_verified`: the pool recovers passwords by verified email, which only a
 * self-signup guest may have; staff recover only through an administrator
 * (docs/architecture-guests.md §2, `console:unverify-staff`).
 */
export function staffUserAttributes(email: string, worldId: string): AttributeType[] {
  return [
    { Name: "email", Value: email },
    { Name: WORLD_ATTRIBUTE, Value: worldId },
  ];
}

export interface InviteDeps {
  readonly cognito: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId: string;
  readonly store: TableStore;
  readonly demoRecipients: () => readonly string[];
  readonly guestWorld: { assertAvailable(): void; create(request: GuestWorldRequest): Promise<GuestWorldResult> };
  readonly saveCredential: (entry: { username: string; worldId: string; password: string }) => string;
  readonly password: () => string;
  readonly now: () => Date;
}

export interface InviteOutcome {
  readonly username: string;
  readonly worldId: string;
  readonly user: "created" | "existing";
  readonly staffRow?: "created" | "existing";
  readonly world?: GuestWorldResult["status"];
  readonly credentialsFile?: string;
  readonly invitedAddress?: string;
}

async function findUser(deps: InviteDeps, username: string): Promise<CognitoUser | undefined> {
  try {
    const user = await deps.cognito.send(new AdminGetUserCommand({ UserPoolId: deps.userPoolId, Username: username }));
    return userFrom(user.UserAttributes, user.UserStatus, user.Enabled);
  } catch (error) {
    if (error instanceof Error && error.name === "UserNotFoundException") return undefined;
    throw error;
  }
}

function assertWorld(user: CognitoUser, account: Account): void {
  if (user.worldId !== account.worldId) {
    throw new Error(`${account.username} already exists in another world; custom:worldId is immutable, so it is never changed here`);
  }
}

/** Refuses an emailed invitation unless the pool sends from the app's SES identity (infra/auth-email.ts). */
async function assertSesSender(deps: InviteDeps): Promise<void> {
  const described = await deps.cognito.send(new DescribeUserPoolCommand({ UserPoolId: deps.userPoolId }));
  const email = described.UserPool?.EmailConfiguration;
  const fromOk = email?.From === INVITATION_SENDER || (email?.From ?? "").endsWith(`<${INVITATION_SENDER}>`);
  if (!email?.SourceArn?.endsWith(`:identity/${APP_DOMAIN}`) || !fromOk) {
    throw new Error(`UNAVAILABLE: the user pool does not send from ${INVITATION_SENDER} yet (infra/auth-email.ts switches it on the deploy after the SES identity is verified); no invitation was sent`);
  }
}

async function inviteGuest(invitation: GuestInvitation, deps: InviteDeps): Promise<InviteOutcome> {
  deps.guestWorld.assertAvailable();
  const { username, worldId } = invitation;
  const pool = { UserPoolId: deps.userPoolId, Username: username };
  let user = await findUser(deps, username);
  const existed = user !== undefined;
  if (user === undefined) {
    const created = await deps.cognito.send(
      new AdminCreateUserCommand({ ...pool, UserAttributes: [{ Name: WORLD_ATTRIBUTE, Value: worldId }], MessageAction: "SUPPRESS" }),
    );
    user = userFrom(created.User?.Attributes, created.User?.UserStatus, created.User?.Enabled);
  }
  assertWorld(user, invitation);
  let credentialsFile: string | undefined;
  if (user.status !== "CONFIRMED") {
    // A new user, or one an interrupted run left with Cognito's temporary password.
    const password = deps.password();
    credentialsFile = deps.saveCredential({ username, worldId, password });
    await deps.cognito.send(new AdminSetUserPasswordCommand({ ...pool, Password: password, Permanent: true }));
  }
  await deps.cognito.send(new AdminSetUserMFAPreferenceCommand({ ...pool, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }));
  await deps.cognito.send(new AdminAddUserToGroupCommand({ ...pool, GroupName: "GUEST" }));
  const world = await deps.guestWorld.create({
    worldId,
    staff: { staffId: invitation.staffId, sub: user.sub, displayName: invitation.displayName },
    resume: invitation.resume,
  });
  if (world.status !== "READY") throw new Error(`${worldId} did not reach READY`);
  return { username, worldId, user: existed ? "existing" : "created", world: world.status, ...(credentialsFile ? { credentialsFile } : {}) };
}

function staffRowTaken(invitation: StaffInvitation): Error {
  return new Error(`STAFF#${invitation.staffId} of ${invitation.worldId} belongs to another Cognito user; choose another --username`);
}

async function registerStaff(invitation: StaffInvitation, sub: string, deps: InviteDeps): Promise<"created" | "existing"> {
  const worlds = worldsRepo({ store: deps.store, now: deps.now });
  const { worldId, staffId, role, displayName } = invitation;
  try {
    await worlds.putStaff({ worldId, staffId, role, displayName, cognitoSubKey: `SUB#${sub}`, active: true });
    return "created";
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "CONFLICT") throw error;
    const row = await worlds.getStaff(worldId, staffId);
    if (row?.cognitoSubKey !== `SUB#${sub}`) throw staffRowTaken(invitation);
    return "existing";
  }
}

async function inviteStaff(invitation: StaffInvitation, deps: InviteDeps): Promise<InviteOutcome> {
  const { username, worldId, email, role } = invitation;
  if (!deps.demoRecipients().includes(email)) {
    throw new Error(`${maskEmail(email)} is not in SeedOverrides.demoRecipients.emails: staff invitations only go to demo recipients`);
  }
  await assertSesSender(deps);
  const pool = { UserPoolId: deps.userPoolId, Username: username };
  let user = await findUser(deps, username);
  const existed = user !== undefined;
  // A row bound to another user is refused before anything is created or emailed.
  const row = await worldsRepo({ store: deps.store, now: deps.now }).getStaff(worldId, invitation.staffId);
  if (row !== undefined && (user === undefined || row.cognitoSubKey !== `SUB#${user.sub}`)) throw staffRowTaken(invitation);
  if (user === undefined) {
    const created = await deps.cognito.send(
      new AdminCreateUserCommand({
        ...pool,
        UserAttributes: staffUserAttributes(email, worldId),
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    user = userFrom(created.User?.Attributes, created.User?.UserStatus, created.User?.Enabled);
  }
  assertWorld(user, invitation);
  if (user.email === undefined || normalizeEmail(user.email) !== email) throw new Error(`${username} already exists with another email; choose another --username`);
  await deps.cognito.send(new AdminAddUserToGroupCommand({ ...pool, GroupName: role }));
  const staffRow = await registerStaff(invitation, user.sub, deps);
  return { username, worldId, user: existed ? "existing" : "created", staffRow, ...(existed ? {} : { invitedAddress: maskEmail(email) }) };
}

export function runInvite(invitation: Invitation, deps: InviteDeps): Promise<InviteOutcome> {
  return invitation.kind === "guest" ? inviteGuest(invitation, deps) : inviteStaff(invitation, deps);
}

export function describeOutcome(outcome: InviteOutcome): string {
  const parts = [`${outcome.username} (${outcome.worldId}): user ${outcome.user}`];
  if (outcome.staffRow) parts.push(`staff row ${outcome.staffRow}`);
  if (outcome.world) parts.push(`world ${outcome.world}`);
  if (outcome.invitedAddress) parts.push(`invitation sent to ${outcome.invitedAddress}`);
  if (outcome.credentialsFile) parts.push(`password written to ${outcome.credentialsFile}`);
  return `console:invite: ${parts.join(" · ")}`;
}

async function main(): Promise<void> {
  let invitation: Invitation;
  try {
    invitation = parseInviteArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`console:invite: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
  const auth = authConfig();
  const deps: InviteDeps = {
    cognito: new CognitoIdentityProviderClient({ region: auth.region, ...awsClientConfig(COGNITO_TIMEOUTS) }),
    userPoolId: auth.userPoolId,
    store: new DynamoStore(),
    demoRecipients: () => demoRecipientsOf(secretValue("SeedOverrides")),
    guestWorld: { assertAvailable: assertGuestWorldFactory, create: createGuestWorld },
    saveCredential: (entry) => saveCredential(CREDENTIALS_FILE, entry, new Date()),
    password: generatePassword,
    now: () => new Date(),
  };
  console.log(describeOutcome(await runInvite(invitation, deps)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? `${String(error.code)}: ` : "";
    console.error(`console:invite: ${code}${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
