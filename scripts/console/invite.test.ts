import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  type AdminCreateUserCommandInput,
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  InvalidParameterException,
  ResourceNotFoundException,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { StaffRole } from "@reclamo/shared";
import { MemoryStore } from "../../packages/bff/src/connector/memory/engine";
import { worldsRepo } from "../../packages/bff/src/connector/repos/worlds";
import { assertGuestWorldFactory, createGuestWorld, type GuestWorldRequest } from "../../packages/bff/src/worlds/guest-world";
import {
  type InviteDeps,
  demoRecipientsOf,
  describeOutcome,
  generatePassword,
  guestAccount,
  parseInviteArgs,
  runInvite,
  saveCredential,
} from "./invite";

const metadata = { $metadata: {} };
const DEMO_RECIPIENT = "lucia.demo@craftech.io";
const SES_SENDER = { SourceArn: "arn:aws:ses:us-east-1:111122223333:identity/reclamo.demo.craftech.io", From: "Reclamo en regla <no-reply@reclamo.demo.craftech.io>" };

interface FakeUser {
  readonly username: string;
  readonly attributes: Map<string, string>;
  status: "FORCE_CHANGE_PASSWORD" | "CONFIRMED";
  readonly groups: Set<string>;
  mfa?: unknown;
}

/**
 * Just enough of a Cognito user pool, with the rules that matter here: username attributes (email
 * as username or not), case-insensitive usernames, immutable `custom:worldId`, known groups, and the
 * invitation only when there is an email to deliver it to.
 */
class FakeUserPool {
  readonly users = new Map<string, FakeUser>();
  readonly invitations: string[] = [];
  constructor(
    readonly rules: { usernameAttributes: string[]; emailConfiguration: Record<string, string> } = {
      usernameAttributes: [],
      emailConfiguration: { EmailSendingAccount: "COGNITO_DEFAULT", ...SES_SENDER },
    },
  ) {}

  private key = (username: string) => username.toLowerCase();

  get(username: string): FakeUser {
    const user = this.users.get(this.key(username));
    if (!user) throw new UserNotFoundException({ message: "User does not exist.", ...metadata });
    return user;
  }

  create(input: AdminCreateUserCommandInput) {
    const username = input.Username ?? "";
    if (this.rules.usernameAttributes.includes("email") && !/^[^@\s]+@[^@\s]+$/.test(username)) {
      throw new InvalidParameterException({ message: "Username should be an email.", ...metadata });
    }
    if (this.users.has(this.key(username))) throw new UsernameExistsException({ message: "User account already exists", ...metadata });
    const attributes = new Map((input.UserAttributes ?? []).map((attribute) => [attribute.Name ?? "", attribute.Value ?? ""]));
    for (const name of attributes.keys()) if (name.startsWith("custom:") && name !== "custom:worldId") throw new InvalidParameterException({ message: `${name} is not in the schema`, ...metadata });
    const email = attributes.get("email");
    if (input.DesiredDeliveryMediums?.includes("EMAIL") && email === undefined) throw new InvalidParameterException({ message: "No email to deliver the invitation", ...metadata });
    if (input.MessageAction !== "SUPPRESS") {
      if (email === undefined) throw new InvalidParameterException({ message: "No delivery medium for the invitation", ...metadata });
      this.invitations.push(email);
    }
    attributes.set("sub", randomUUID());
    const user: FakeUser = { username, attributes, status: "FORCE_CHANGE_PASSWORD", groups: new Set() };
    this.users.set(this.key(username), user);
    return { User: this.describe(user) };
  }

  describe(user: FakeUser) {
    return { Username: user.username, Attributes: [...user.attributes].map(([Name, Value]) => ({ Name, Value })), UserStatus: user.status, Enabled: true };
  }
}

let pool: FakeUserPool;
let store: MemoryStore;
let worldRequests: GuestWorldRequest[];
let credentials: Array<{ username: string; worldId: string; password: string }>;
const cognito = mockClient(CognitoIdentityProviderClient);

function wire(): void {
  cognito.reset();
  cognito.on(AdminCreateUserCommand).callsFake((input) => pool.create(input));
  cognito.on(AdminGetUserCommand).callsFake((input) => {
    const { Attributes, UserStatus, Enabled } = pool.describe(pool.get(input.Username ?? ""));
    return { Username: input.Username, UserAttributes: Attributes, UserStatus, Enabled };
  });
  cognito.on(AdminSetUserPasswordCommand).callsFake((input) => {
    if (input.Permanent) pool.get(input.Username ?? "").status = "CONFIRMED";
    return {};
  });
  cognito.on(AdminSetUserMFAPreferenceCommand).callsFake((input) => {
    pool.get(input.Username ?? "").mfa = input.SoftwareTokenMfaSettings;
    return {};
  });
  cognito.on(AdminAddUserToGroupCommand).callsFake((input) => {
    const group = input.GroupName ?? "";
    if (!StaffRole.options.some((role) => role === group)) throw new ResourceNotFoundException({ message: "Group not found.", ...metadata });
    pool.get(input.Username ?? "").groups.add(group);
    return {};
  });
  cognito.on(AdminUpdateUserAttributesCommand).rejects(new InvalidParameterException({ message: "Cannot modify an immutable attribute", ...metadata }));
  cognito.on(DescribeUserPoolCommand).callsFake(() => ({
    UserPool: { UsernameAttributes: pool.rules.usernameAttributes, UsernameConfiguration: { CaseSensitive: false }, EmailConfiguration: pool.rules.emailConfiguration },
  }));
}

function deps(overrides: Partial<InviteDeps> = {}): InviteDeps {
  return {
    cognito: new CognitoIdentityProviderClient({ region: "us-east-1" }),
    userPoolId: "us-east-1_TESTPOOL1",
    store,
    demoRecipients: () => [DEMO_RECIPIENT],
    guestWorld: {
      assertAvailable: () => undefined,
      create: async (request) => {
        worldRequests.push(request);
        return { worldId: request.worldId, status: "READY" };
      },
    },
    saveCredential: (entry) => {
      credentials.push(entry);
      return "scripts/console/guest-credentials.local.json";
    },
    password: generatePassword,
    now: () => new Date("2026-10-01T12:00:00.000Z"),
    ...overrides,
  };
}

const commandsSent = () => cognito.calls().map((call) => (call.args[0] as { constructor: { name: string } }).constructor.name);

beforeEach(() => {
  pool = new FakeUserPool();
  store = new MemoryStore();
  worldRequests = [];
  credentials = [];
  wire();
});

describe("guest accounts on the username-based pool [FL-094]", () => {
  it("creates guest-01 without email, with a permanent password, no MFA, group GUEST, then builds g01", async () => {
    const outcome = await runInvite(parseInviteArgs(["--stage", "poc", "--guest", "1"]), deps());

    const user = pool.get("guest-01");
    expect(user.attributes.has("email")).toBe(false);
    expect(user.attributes.get("custom:worldId")).toBe("g01");
    expect(user.status).toBe("CONFIRMED");
    expect([...user.groups]).toEqual(["GUEST"]);
    expect(user.mfa).toEqual({ Enabled: false, PreferredMfa: false });
    expect(pool.invitations).toEqual([]);
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]?.args[0].input.MessageAction).toBe("SUPPRESS");

    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ username: "guest-01", worldId: "g01" });
    expect(cognito.commandCalls(AdminSetUserPasswordCommand)[0]?.args[0].input).toMatchObject({ Password: credentials[0]?.password, Permanent: true });

    expect(worldRequests).toEqual([{ worldId: "g01", staff: { staffId: "stf-guest-01", sub: user.attributes.get("sub"), displayName: "Guest 01" }, resume: false }]);
    expect(outcome).toEqual({ username: "guest-01", worldId: "g01", user: "created", world: "READY", credentialsFile: "scripts/console/guest-credentials.local.json" });
    expect(describeOutcome(outcome)).not.toContain(credentials[0]?.password ?? "-");
  });

  it("could not create guest-01 on a pool that used the email as username (the reference's usernames: [\"email\"])", async () => {
    pool = new FakeUserPool({ usernameAttributes: ["email"], emailConfiguration: SES_SENDER });
    await expect(runInvite(parseInviteArgs(["--guest", "1"]), deps())).rejects.toThrow("Username should be an email.");
  });

  it("fails closed with UNAVAILABLE and creates no user while the world factory is a stub (WP-34)", async () => {
    const stub = deps({ guestWorld: { assertAvailable: assertGuestWorldFactory, create: createGuestWorld } });
    await expect(runInvite(parseInviteArgs(["--guest", "3"]), stub)).rejects.toMatchObject({ name: "ToolError", code: "UNAVAILABLE" });
    await expect(createGuestWorld({ worldId: "g03", staff: { staffId: "stf-guest-03", sub: "s", displayName: "Guest 03" }, resume: false })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(cognito.calls()).toHaveLength(0);
    expect(pool.users.size).toBe(0);
  });

  it("is idempotent: a second run keeps the permanent password and resumes the world", async () => {
    await runInvite(parseInviteArgs(["--guest", "2"]), deps());
    const again = await runInvite(parseInviteArgs(["--guest", "02", "--resume"]), deps());
    expect(again.user).toBe("existing");
    expect(again.credentialsFile).toBeUndefined();
    expect(credentials).toHaveLength(1);
    expect(cognito.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(1);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(1);
    expect(worldRequests.map((request) => request.resume)).toEqual([false, true]);
  });

  it("sets a permanent password again for a user an interrupted run left with a temporary one", async () => {
    pool.create({ UserPoolId: "us-east-1_TESTPOOL1", Username: "guest-04", UserAttributes: [{ Name: "custom:worldId", Value: "g04" }], MessageAction: "SUPPRESS" });
    const outcome = await runInvite(parseInviteArgs(["--guest", "4"]), deps());
    expect(outcome.user).toBe("existing");
    expect(pool.get("guest-04").status).toBe("CONFIRMED");
    expect(credentials.map((entry) => entry.username)).toEqual(["guest-04"]);
  });

  it("never touches the immutable world of an existing user, whatever the case of its username", async () => {
    pool.create({ UserPoolId: "us-east-1_TESTPOOL1", Username: "Guest-05", UserAttributes: [{ Name: "custom:worldId", Value: "g06" }], MessageAction: "SUPPRESS" });
    await expect(runInvite(parseInviteArgs(["--guest", "5"]), deps())).rejects.toThrow("already exists in another world");
    expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
    expect(worldRequests).toEqual([]);
  });

  it("maps guest numbers and the optional test account to their worlds", () => {
    expect(guestAccount("7")).toEqual({ username: "guest-07", worldId: "g07", staffId: "stf-guest-07", displayName: "Guest 07" });
    expect(guestAccount("test")).toMatchObject({ username: "guest-test", worldId: "gtest" });
    for (const label of ["0", "100", "probe", "-1", "1.5"]) expect(() => guestAccount(label), label).toThrow(RangeError);
  });
});

describe("staff accounts [FL-094]", () => {
  it("creates operator-01 with an address of demoRecipients, invites it by email and writes its STAFF# row", async () => {
    const outcome = await runInvite(parseInviteArgs(["--world", "demo", "--role", "OPERATOR", "--email", "Lucia.Demo@craftech.io", "--name", "Lucía Ferrán"]), deps());

    const user = pool.get("operator-01");
    expect(user.attributes.get("email")).toBe(DEMO_RECIPIENT);
    expect(user.attributes.has("email_verified")).toBe(false);
    expect(user.attributes.get("custom:worldId")).toBe("demo");
    expect([...user.groups]).toEqual(["OPERATOR"]);
    expect(pool.invitations).toEqual([DEMO_RECIPIENT]);
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]?.args[0].input.DesiredDeliveryMediums).toEqual(["EMAIL"]);
    expect(cognito.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);

    const row = await worldsRepo({ store, now: () => new Date() }).getStaff("demo", "stf-operator-01");
    expect(row).toMatchObject({ worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR", displayName: "Lucía Ferrán", cognitoSubKey: `SUB#${user.attributes.get("sub")}`, active: true });
    expect(outcome).toEqual({ username: "operator-01", worldId: "demo", user: "created", staffRow: "created", invitedAddress: "l***@craftech.io" });
    expect(describeOutcome(outcome)).not.toContain(DEMO_RECIPIENT);
  });

  it("refuses an address outside demoRecipients before any call to Cognito", async () => {
    const invitation = parseInviteArgs(["--world", "demo", "--role", "SUPERVISOR", "--email", "someone@craftech.io"]);
    await expect(runInvite(invitation, deps())).rejects.toThrow("is not in SeedOverrides.demoRecipients.emails");
    await expect(runInvite(invitation, deps())).rejects.not.toThrow("someone@");
    expect(cognito.calls()).toHaveLength(0);
  });

  it("refuses to invite while the pool still sends from Cognito's own address", async () => {
    pool = new FakeUserPool({ usernameAttributes: [], emailConfiguration: { EmailSendingAccount: "COGNITO_DEFAULT" } });
    await expect(runInvite(parseInviteArgs(["--world", "demo", "--role", "COMPLIANCE", "--email", DEMO_RECIPIENT]), deps())).rejects.toThrow(/^UNAVAILABLE/);
    expect(commandsSent()).toEqual(["DescribeUserPoolCommand"]);
  });

  it("is idempotent, and refuses a username already bound to another address or another Cognito user", async () => {
    const args = ["--world", "demo", "--role", "OPERATOR", "--email", DEMO_RECIPIENT];
    await runInvite(parseInviteArgs(args), deps());
    const again = await runInvite(parseInviteArgs(args), deps());
    expect(again).toMatchObject({ user: "existing", staffRow: "existing" });
    expect(again.invitedAddress).toBeUndefined();
    expect(pool.invitations).toHaveLength(1);

    const other = deps({ demoRecipients: () => [DEMO_RECIPIENT, "tomas.demo@craftech.io"] });
    await expect(runInvite(parseInviteArgs(["--world", "demo", "--role", "OPERATOR", "--email", "tomas.demo@craftech.io"]), other)).rejects.toThrow("another email");

    await worldsRepo({ store, now: () => new Date() }).putStaff({ worldId: "demo", staffId: "stf-supervisor-01", role: "SUPERVISOR", displayName: "x", cognitoSubKey: "SUB#someone-else", active: true });
    await expect(runInvite(parseInviteArgs(["--world", "demo", "--role", "SUPERVISOR", "--email", DEMO_RECIPIENT]), deps())).rejects.toThrow("belongs to another Cognito user");
    expect(() => pool.get("supervisor-01")).toThrow("User does not exist.");
    expect(pool.invitations).toHaveLength(1);
  });
});

describe("arguments", () => {
  it("rejects gprobe, guest and QA worlds for staff, the GUEST role outside --guest and any stage but poc", () => {
    const staff = (world: string) => ["--world", world, "--role", "OPERATOR", "--email", DEMO_RECIPIENT];
    expect(() => parseInviteArgs(staff("gprobe"))).toThrow("gprobe is the fence-probe world");
    expect(() => parseInviteArgs(staff("g03"))).toThrow("guest world");
    expect(() => parseInviteArgs(staff("gtest"))).toThrow("guest world");
    for (const world of ["qa-r1-sc01", "qamin", "sim-001", "prod"]) expect(() => parseInviteArgs(staff(world)), world).toThrow("staff accounts belong to the demo world");
    expect(() => parseInviteArgs(["--world", "demo", "--role", "GUEST", "--email", DEMO_RECIPIENT])).toThrow("--guest");
    expect(() => parseInviteArgs(["--stage", "prod", "--guest", "1"])).toThrow('unknown stage "prod"');
    expect(() => parseInviteArgs(["--guest", "1", "--email", DEMO_RECIPIENT])).toThrow("a guest has no email");
    expect(() => parseInviteArgs(["--world", "demo", "--role", "OPERATOR", "--email", DEMO_RECIPIENT, "--resume"])).toThrow("--resume only applies to --guest");
    expect(() => parseInviteArgs(["--world", "demo", "--role", "OPERATOR", "--email", DEMO_RECIPIENT, "--username", "qa-r1-sc01-operator"])).toThrow("operator-NN");
    expect(() => parseInviteArgs(["--world", "demo", "--role", "OPERATOR", "--email", "not-an-address"])).toThrow("not an email address");
  });
});

describe("secrets and credentials", () => {
  it("reads demoRecipients from SeedOverrides: at most 5, only @craftech.io, never echoing the secret", () => {
    expect(demoRecipientsOf(JSON.stringify({ demoRecipients: { emails: [" Lucia.Demo@Craftech.io "] }, budgetEmail: "x@craftech.io" }))).toEqual([DEMO_RECIPIENT]);
    expect(demoRecipientsOf("{}")).toEqual([]);
    const six = Array.from({ length: 6 }, (_, index) => `d${index}@craftech.io`);
    expect(() => demoRecipientsOf(JSON.stringify({ demoRecipients: { emails: six } }))).toThrow("at most 5");
    expect(() => demoRecipientsOf(JSON.stringify({ demoRecipients: { emails: ["someone@example.com"] } }))).toThrow("only hold @craftech.io");
    expect(() => demoRecipientsOf("{secret-address@craftech.io")).toThrow(/^SeedOverrides is not valid JSON$/);
  });

  it("generates passwords the pool's policy accepts (infra/auth.ts: 14+ characters, every class)", () => {
    for (let run = 0; run < 50; run += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(24);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!#%+=?@^_-]/);
    }
    expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
  });

  it("keeps guest passwords in a local file readable only by the operator", () => {
    const file = join(mkdtempSync(join(tmpdir(), "invite-")), "guest-credentials.local.json");
    saveCredential(file, { username: "guest-01", worldId: "g01", password: "p1" }, new Date("2026-10-01T12:00:00.000Z"));
    saveCredential(file, { username: "guest-02", worldId: "g02", password: "p2" }, new Date("2026-10-01T12:01:00.000Z"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      "guest-01": { worldId: "g01", password: "p1", setAt: "2026-10-01T12:00:00.000Z" },
      "guest-02": { worldId: "g02", password: "p2", setAt: "2026-10-01T12:01:00.000Z" },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(process.cwd(), ".gitignore"), "utf8")).toContain("*.local.*");
  });
});
