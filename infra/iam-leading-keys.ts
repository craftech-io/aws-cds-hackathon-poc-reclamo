// Leading-key fences of the world-fenced roles and of the roles that reach `Leads`
// (docs/architecture.md §14, docs/architecture-guests.md §12), as plain data and the IAM
// `StringLike` they are evaluated with. Re-exported by infra/iam-capabilities.ts, which keeps the rest
// of every role's capabilities.

/**
 * `ForAllValues:StringLike dynamodb:LeadingKeys` of every world-fenced role, always with
 * `Null: { "dynamodb:LeadingKeys": "false" }` (docs/architecture.md §14). `readOnly` keys may only be
 * read (`GetItem`, `Query`).
 */
export const WORLD_LEADING_KEYS = {
  Bff: {
    // `W#gs-*`: self-signup worlds; the global counters of the sign-up and the edge's audit partition
    // (docs/architecture-guests.md §11-§12). The switch and the kill are only read, and so are the KPI
    // rows of the `sim-*` run worlds the metrics tabs show (only their `Metrics` partition, leadingKeyFits).
    write: ["W#demo#*", "W#g??#*", "W#gtest#*", "W#gs-*", "W#qa-*", "KILL#AGENT", "SIGNUPCAP#*", "SIGNUPIP#*", "SIGNUPCANON#*", "RECOVERYIP#*", "AUTHMAIL#*", "GUESTACCT#*", "SIGNUP#AUD#*"],
    readOnly: ["SWITCH#SIGNUP", "KILL#SIGNUP", "W#sim-*#METRICS"],
  },
  WorldJanitor: { write: ["W#demo#*", "W#g??#*", "W#gtest#*", "W#gs-*", "W#gprobe#*", "W#qa-*", "W#qamin#*", "GUEST#*", "GUESTCAP#*"], readOnly: [] },
  // SC-24 runs the sign-up service in process: it reads the switch and the kill (`signupOpen`), counts
  // in the QA buckets and audits the edge's QA events in their own partition, never a visitor's.
  QaDriver: {
    write: ["W#qa-*", "W#qamin#*", "W#sim-*", "LEASE#*", "PROBE#*", "GLOBALCAP#QA#*", "SIGNUPCAP#QA#*", "GUESTCAP#QA", "SIGNUP#AUD#QA#*"],
    readOnly: ["W#gprobe#*", "SWITCH#SIGNUP", "KILL#SIGNUP"],
  },
  // Same code as EventWorker, on its own queue: only the self-signup worlds, their pool cap and the kill
  // (docs/architecture-guests.md §12). Applied by infra/workers.ts on the world tables and Runtime.
  SignupEventWorker: { write: ["W#gs-*", "GLOBALCAP#SIGNUP#*"], readOnly: ["KILL#AGENT"] },
  BudgetBreaker: { write: ["KILL#AGENT", "KILL#SIGNUP", "W#*#AUD#*"], readOnly: [] },
  PreTokenTrigger: { write: ["W#*#AUD#*"], readOnly: [] },
  // Registers a confirmed self-signup: its world, staff row, ticket and audit entry (never another world).
  PostConfirmationTrigger: { write: ["W#gs-*", "W#qa-*", "SIGNUP#AUD#*"], readOnly: [] },
  LeadNotifier: { write: ["LEADNOTICE#*", "SIGNUP#AUD#*"], readOnly: [] },
} as const satisfies Record<string, { write: readonly string[]; readOnly: readonly string[] }>;

export type WorldFencedRole = keyof typeof WORLD_LEADING_KEYS;

/** IAM `StringLike`: `*` any run of characters, `?` exactly one. */
export function stringLike(pattern: string, value: string): boolean {
  const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "s").test(value);
}

/**
 * What IAM decides for a DynamoDB request of a world-fenced role: every leading key must match one
 * pattern (`ForAllValues`), and a request without any leading key (a `Scan`) fails the Null guard.
 */
export function leadingKeysAllow(role: WorldFencedRole, keys: readonly string[], mode: "read" | "write"): boolean {
  if (keys.length === 0) return false;
  const fence = WORLD_LEADING_KEYS[role];
  const patterns: readonly string[] = mode === "read" ? [...fence.write, ...fence.readOnly] : fence.write;
  return keys.every((key) => patterns.some((pattern) => stringLike(pattern, key)));
}

// ---- Leads (docs/architecture-guests.md §10, §12) ---------------------------------------------------

/**
 * One statement on `Leads`. `leadingKeys` always comes with its Null guard. `attributes` limits the
 * item to those attributes (`ForAllValues:StringEquals dynamodb:Attributes` + Null guard: a GetItem
 * without a projection carries no attribute names and would pass an empty ForAllValues).
 * `select` is checked with `StringEqualsIfExists`: DynamoDB sends `dynamodb:Select` only for Query and
 * Scan, so a plain `StringEquals` would deny every GetItem. `index` puts the statement on that index
 * only (`Leads/index/<name>`), never on the table.
 */
export interface LeadsGrant {
  readonly actions: readonly string[];
  readonly leadingKeys: readonly string[];
  readonly attributes?: readonly string[];
  readonly select?: "SPECIFIC_ATTRIBUTES" | "ALL_PROJECTED_ATTRIBUTES";
  readonly index?: "ByEmailHash";
}

const ITEM_RW = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"] as const;

/**
 * The closed list of roles that reach `Leads`; every other role of the app (the whole demo) has no
 * statement on it. Nobody gets `Scan`, `BatchGetItem` or `BatchWriteItem`, and the Bff never reads a
 * `LEAD#` item (an IDOR in the console must not leak contact data).
 */
export const LEADS_GRANTS = {
  PreSignUpTrigger: [{ actions: ["dynamodb:GetItem"], leadingKeys: ["SIGNUP#*", "QASIGNUP#*", "PENDING#*", "QAPENDING#*"] }],
  // Rule (d) of the identity invariant: only `worldId` of the lead, never the email or the consents.
  PreTokenTrigger: [{ actions: ["dynamodb:GetItem"], leadingKeys: ["LEAD#*", "QALEAD#*"], attributes: ["pk", "sk", "worldId"], select: "SPECIFIC_ATTRIBUTES" }],
  PostConfirmationTrigger: [{ actions: [...ITEM_RW], leadingKeys: ["SIGNUP#*", "QASIGNUP#*", "LEAD#*", "QALEAD#*", "CANON#*"] }],
  LeadNotifier: [{ actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], leadingKeys: ["LEAD#*"] }],
  Bff: [
    { actions: [...ITEM_RW], leadingKeys: ["SIGNUP#*", "PENDING#*", "CANON#*"] },
    // The repair of guests/register.ts (conditional put) and `lastLoginAtReal`/`expiresAt` (of a QA lead
    // too, when SC-24's account signs in to its `qa-<runId>-su<n>` world); no read.
    { actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"], leadingKeys: ["LEAD#*", "QALEAD#*"] },
    // Uniqueness and recovery: the keys of the email's lead, nothing projected besides them.
    { actions: ["dynamodb:Query"], leadingKeys: ["EMAIL#*"], select: "ALL_PROJECTED_ATTRIBUTES", index: "ByEmailHash" },
  ],
  // The world id of a lead whose world it recreates.
  WorldJanitor: [{ actions: ["dynamodb:UpdateItem"], leadingKeys: ["LEAD#*"] }],
  // SC-24 only: its own QA requests and leads, never a visitor's.
  QaDriver: [{ actions: [...ITEM_RW, "dynamodb:DeleteItem"], leadingKeys: ["QASIGNUP#*", "QAPENDING#*", "QALEAD#*"] }],
} as const satisfies Record<string, readonly LeadsGrant[]>;

export type LeadsRole = keyof typeof LEADS_GRANTS;

/** What IAM decides for one request of a role on `Leads` (action, leading key, attributes asked). */
export function leadsAllow(role: LeadsRole, request: { action: string; key: string; index?: string; attributes?: readonly string[] }): boolean {
  const grants: readonly LeadsGrant[] = LEADS_GRANTS[role];
  return grants.some((grant) => {
    if (!grant.actions.includes(request.action)) return false;
    if ((grant.index ?? undefined) !== request.index) return false;
    if (!grant.leadingKeys.some((pattern) => stringLike(pattern, request.key))) return false;
    if (grant.attributes === undefined) return true;
    const asked = request.attributes ?? [];
    return asked.length > 0 && asked.every((name) => grant.attributes?.includes(name));
  });
}
