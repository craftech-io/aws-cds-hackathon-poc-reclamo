// The storage layer against docs/architecture.md §1, §5, §6 and §14, the IAM fences of
// infra/iam-capabilities.ts, the CI bootstrap and the index attributes the connector writes.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_BUCKETS, bucketPrefix } from "./ci-spec";
import { keys } from "../packages/bff/src/connector/keys";
import { signupAuditPartition } from "../packages/bff/src/leads/keys";
import { RUN_WORLD_PREFIX, SIMULATED_LOAD_WORLD } from "../packages/bff/src/metrics/types";
import { WORLD_LEADING_KEYS, leadingKeysAllow, stringLike, type WorldFencedRole } from "./iam-capabilities";
import {
  ANCHOR_ACCESS,
  ANCHOR_RETENTION_DAYS,
  BUCKETS,
  BUCKET_ACTIONS,
  BUCKET_NAMES,
  CORS_MAX_AGE_SECONDS,
  GLOBAL_PARTITION_PREFIXES,
  LOGICAL_BUCKET_NAME_MAX,
  MEDIA_SCANNED_PREFIXES,
  QUARANTINE_PREFIX,
  TABLES,
  TABLE_ACTIONS,
  TABLE_NAMES,
  WORLD_INDEX,
  anchorLogGroupName,
  bucketCors,
  dynamoArgs,
  leadingKeyFits,
  leadingKeysConditions,
  lifecycleRules,
  type BucketSpec,
  type IndexSpec,
  type TableSpec,
} from "./storage-keys";
import { dataPlan } from "./workers-spec";

const APP = "aws-cds-hackathon-poc-reclamo";
const ORIGIN = "https://reclamo.demo.craftech.io";
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const bootstrap = read("infra/bootstrap/ci-role.yaml");

const section = (from: string, to: string): string => architecture.slice(architecture.indexOf(from), architecture.indexOf(to));
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? "").replace(/\\\|/g, "|"));

/** Rows of a markdown table whose first cell starts with a backticked name, split on unescaped pipes. */
function rows(markdown: string): Array<{ name: string; cells: string[] }> {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim()))
    .map((cells) => ({ name: ticks(cells[0] ?? "")[0] ?? "", cells }));
}

/** Parts of a GSI cell split on ` · ` (or `, `) outside parentheses: `Name (details)`. */
function indexParts(cell: string): Array<{ name: string; details: string }> {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let at = 0; at < cell.length; at += 1) {
    const char = cell[at] ?? "";
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (depth === 0 && cell.startsWith(" · ", at)) {
      parts.push(current);
      current = "";
      at += 2;
    } else if (depth === 0 && cell.startsWith(", ", at)) {
      parts.push(current);
      current = "";
      at += 1;
    } else current += char;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "—")
    .map((part) => ({ name: ticks(part)[0] ?? "", details: /\((.*)\)/.exec(part)?.[1] ?? "" }));
}

const documentedTables = rows(section("## 5. DynamoDB", "## 6. S3"));
const spec = (name: string): TableSpec => TABLES[name as keyof typeof TABLES];
const indexesOf = (name: string): Record<string, IndexSpec> => ({ ...spec(name).indexes });

describe("tables of docs/architecture.md §5", () => {
  it("has one table per documented aggregate, nothing else", () => {
    expect(documentedTables.length).toBe(13);
    expect(documentedTables.map(({ name }) => name).sort()).toEqual([...TABLE_NAMES].sort());
  });

  it.each(documentedTables)("$name has exactly the documented GSIs, with their keys", ({ name, cells }) => {
    const documented = indexParts(cells[4] ?? "");
    expect(Object.keys(indexesOf(name)).sort()).toEqual(documented.map((part) => part.name).sort());
    for (const { name: indexName, details } of documented) {
      const index = indexesOf(name)[indexName];
      const tokens = ticks(details);
      const assigned = /^`([a-zA-Z]+)` = `([^`]+)`/.exec(details);
      if (assigned) {
        expect(index?.hashKey, `${name}.${indexName}`).toBe(assigned[1]);
        expect(index?.partition, `${name}.${indexName}`).toBe(assigned[2]);
      } else if (/^(W#|SUB#)/.test(tokens[0] ?? "")) {
        expect(index?.partition, `${name}.${indexName}`).toBe(tokens[0]);
      } else if (tokens.length === 1 && /^[a-z]+[A-Z][A-Za-z]*$/.test(tokens[0] ?? "")) {
        expect(index?.hashKey, `${name}.${indexName}`).toBe(tokens[0]);
      }
      // A documented sort (`…, \`filedAtSim\``) needs a range key; the connector stores it normalised.
      const sorts = details.split(/[,;]/).slice(1).flatMap((part) => ticks(part)).filter((token) => /^[a-z][A-Za-z#]*$/.test(token));
      if (sorts.length > 0 || /\+ `/.test(details)) expect(index?.rangeKey, `${name}.${indexName} sort`).toBeDefined();
    }
  });

  it.each(documentedTables)("$name keeps TTL on expiresAt exactly where §5 lists one", ({ name, cells }) => {
    expect(spec(name).ttl, name).toBe((cells[5] ?? "").trim() !== "—");
    expect(dynamoArgs(spec(name)).ttl).toBe(spec(name).ttl ? "expiresAt" : undefined);
  });

  it.each(documentedTables)("$name puts every partition of a world under W#<worldId>#", ({ name, cells }) => {
    const partitions = ticks(cells[2] ?? "");
    expect(partitions.length).toBeGreaterThan(0);
    const globals = GLOBAL_PARTITION_PREFIXES[name as keyof typeof GLOBAL_PARTITION_PREFIXES] ?? [];
    for (const pk of partitions) {
      const inWorld = /^W#<(worldId|w)>#/.test(pk);
      expect(inWorld || globals.some((prefix) => pk.startsWith(prefix)), `${name} ${pk}`).toBe(true);
      if (spec(name).world === "all") expect(inWorld, `${name} ${pk}`).toBe(true);
      if (spec(name).world === "none") expect(inWorld, `${name} ${pk}`).toBe(false);
    }
  });

  it("lists the self-signup's audit partition of AuditLog, the one leads/keys.ts writes and the fences allow", () => {
    expect(TABLES.AuditLog.world).toBe("mixed");
    expect(GLOBAL_PARTITION_PREFIXES.AuditLog).toEqual(["SIGNUP#AUD#"]);
    const at = new Date("2026-10-14T12:00:00.000Z");
    for (const pk of [signupAuditPartition(at), signupAuditPartition(at, true)]) {
      expect(GLOBAL_PARTITION_PREFIXES.AuditLog?.some((prefix) => pk.startsWith(prefix)), pk).toBe(true);
      expect(ticks(documentedTables.find(({ name }) => name === "AuditLog")?.cells[2] ?? "").map((cell) => cell.replace("<yyyy-mm>", "2026-10")), pk).toContain(pk);
    }
    const signupAudit = Object.values(WORLD_LEADING_KEYS).flatMap((fence) => fence.write.filter((pattern) => pattern.startsWith("SIGNUP#AUD#")));
    expect(signupAudit.length).toBeGreaterThan(0);
    for (const pattern of signupAudit) expect(leadingKeyFits("AuditLog", pattern), pattern).toBe(true);
    // No other global key reaches AuditLog.
    for (const pattern of ["SIGNUPCAP#*", "LEADNOTICE#*", "KILL#AGENT", "REF#*"]) expect(leadingKeyFits("AuditLog", pattern), pattern).toBe(false);
  });

  it("builds WorldIndex keys-only on every table the factory rebuilds, partitioned by world", () => {
    expect(architecture).toContain("`WorldIndex` (partición `worldIndexKey = W#<worldId>#`, orden `worldIndexSort = <pk>|<sk>`, solo claves");
    const withWorldIndex = TABLE_NAMES.filter((name) => WORLD_INDEX in indexesOf(name));
    expect(withWorldIndex.sort()).toEqual(["Complaints", "Conversations", "Core", "Networks", "Timers"]);
    for (const name of withWorldIndex) {
      expect(indexesOf(name)[WORLD_INDEX]).toEqual({ hashKey: "worldIndexKey", rangeKey: "worldIndexSort", projection: "keys-only", partition: "W#<worldId>#" });
    }
    // `Leads` indexes carry keys only too: uniqueness, recovery and deletion never read contact data through them.
    for (const name of TABLE_NAMES) {
      for (const [indexName, index] of Object.entries(indexesOf(name))) {
        if (indexName !== WORLD_INDEX) expect(index.projection, `${name}.${indexName}`).toBe(name === "Leads" ? "keys-only" : "all");
      }
    }
  });
});

describe("keys under the world fences of docs/architecture.md §14", () => {
  // Indexes whose partition is not a world key, and the unfenced roles that query them.
  // `GuestIndex` is queried only by WorldJanitor, fenced by its `GUEST#*` leading key; `Leads` has no world.
  const UNFENCED_INDEXES = ["Worlds.BySub", "Worlds.GuestIndex", "Core.ByPhone", "Conversations.ByProviderMessageId", "ComplianceTape.ByMessage", "Leads.ByEmailHash", "Leads.BySub"];

  it("partitions every other index by W#<worldId>#, so LeadingKeys fences the roles that query it", () => {
    const unfenced: string[] = [];
    for (const name of TABLE_NAMES) {
      for (const [indexName, index] of Object.entries(indexesOf(name))) {
        if (!index.partition.startsWith("W#<worldId>#")) unfenced.push(`${name}.${indexName}`);
      }
    }
    expect(unfenced.sort()).toEqual([...UNFENCED_INDEXES].sort());
  });

  it("lets each world-fenced role query WorldIndex of its worlds and of no other", () => {
    const worldIndexKey = (worldId: string): string => `W#${worldId}#`;
    const cases: Array<[WorldFencedRole, string, boolean]> = [
      ["WorldJanitor", "demo", true],
      ["WorldJanitor", "g07", true],
      ["WorldJanitor", "gprobe", true],
      ["WorldJanitor", "qa-r1-sc01", true],
      ["WorldJanitor", "sim-001", false],
      ["Bff", "g07", true],
      ["Bff", "gprobe", false],
      ["QaDriver", "qa-r1-sc01", true],
      ["QaDriver", "demo", false],
      ["QaDriver", "g07", false],
    ];
    for (const [role, worldId, allowed] of cases) expect(leadingKeysAllow(role, [worldIndexKey(worldId)], "write"), `${role} ${worldId}`).toBe(allowed);
    expect(leadingKeysAllow("QaDriver", [worldIndexKey("gprobe")], "read")).toBe(true);
  });

  it("lets the Bff read the KPI partition of every run world the metrics tabs read, on Metrics alone and never write it", () => {
    // publish-batch accepts only RUN_WORLD_PREFIX worlds (scripts/metrics/publish-batch.test.ts); the load runs in its own.
    const runWorlds = [`${RUN_WORLD_PREFIX}r1`, `${RUN_WORLD_PREFIX}20261009-a`, SIMULATED_LOAD_WORLD];
    const grants = dataPlan("Bff").tables;
    for (const worldId of runWorlds) {
      const partition = keys.metricsPartition(worldId);
      expect(leadingKeysAllow("Bff", [partition], "read"), partition).toBe(true);
      expect(leadingKeysAllow("Bff", [partition], "write"), partition).toBe(false);
      expect(leadingKeysAllow("Bff", [`W#${worldId}#CMP#cmp-1`], "read"), worldId).toBe(false);
      const reaching = grants.filter((grant) => grant.leadingKeys?.some((pattern) => stringLike(pattern, partition)));
      expect(reaching.map((grant) => [grant.table, grant.access]), partition).toEqual([["Metrics", "read"]]);
    }
  });

  it("declares only key attributes, strings except the chained sequence number", () => {
    for (const name of TABLE_NAMES) {
      const args = dynamoArgs(spec(name));
      expect(args.primaryIndex).toEqual({ hashKey: "pk", rangeKey: "sk" });
      const used = new Set(["pk", "sk", ...Object.values(args.globalIndexes).flatMap((index) => [index.hashKey, index.rangeKey ?? "pk"])]);
      expect(Object.keys(args.fields).sort(), name).toEqual([...used].sort());
      for (const [field, type] of Object.entries(args.fields)) expect(type, `${name}.${field}`).toBe(field === "seq" ? "number" : "string");
    }
  });

  it("uses the index attributes the connector writes (packages/bff/src/connector/tables.ts)", async (context) => {
    const connectorTables = "packages/bff/src/connector/tables.ts";
    if (!existsSync(resolve(process.cwd(), connectorTables))) return context.skip();
    type Declared = { partition: string; sort?: string; sortType?: "S" | "N"; keysOnly?: boolean };
    const module = (await import(resolve(process.cwd(), connectorTables))) as { INDEXES: Record<string, Record<string, Declared>> };
    for (const [table, indexes] of Object.entries(module.INDEXES)) {
      for (const [indexName, declared] of Object.entries(indexes)) {
        const index = indexesOf(table)[indexName];
        expect(index, `${table}.${indexName}`).toBeDefined();
        expect([index?.hashKey, index?.rangeKey], `${table}.${indexName}`).toEqual([declared.partition, declared.sort]);
        expect(index?.projection === "keys-only", `${table}.${indexName}`).toBe(declared.keysOnly === true);
        if (declared.sort) expect(dynamoArgs(spec(table)).fields[declared.sort], `${table}.${indexName}`).toBe(declared.sortType === "N" ? "number" : "string");
      }
    }
  });
});

describe("access levels", () => {
  it("never lets append or read update, delete or batch-write, and grants no Scan", () => {
    for (const access of ["read", "append"] as const) {
      for (const action of ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) expect(TABLE_ACTIONS[access]).not.toContain(action);
    }
    expect(TABLE_ACTIONS.append).toContain("dynamodb:PutItem");
    expect(TABLE_ACTIONS.read).not.toContain("dynamodb:PutItem");
    for (const actions of Object.values(TABLE_ACTIONS)) {
      expect(actions).not.toContain("dynamodb:Scan");
      for (const action of actions) expect(action).toMatch(/^dynamodb:[A-Z][A-Za-z]+$/);
    }
    for (const action of [...TABLE_ACTIONS.read, ...TABLE_ACTIONS.append]) expect(TABLE_ACTIONS.write).toContain(action);
  });

  it("fences by leading keys with the Null guard, and refuses an empty fence", () => {
    expect(leadingKeysConditions(WORLD_LEADING_KEYS.Bff.write)).toEqual([
      { test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...WORLD_LEADING_KEYS.Bff.write] },
      { test: "Null", variable: "dynamodb:LeadingKeys", values: ["false"] },
    ]);
    expect(WORLD_LEADING_KEYS.Bff.write).toEqual(expect.arrayContaining(["W#demo#*", "W#g??#*", "W#gtest#*", "W#gs-*", "W#qa-*", "KILL#AGENT"]));
    expect(() => leadingKeysConditions([])).toThrow(/at least one/);
  });

  it("gives objects read or write, never listing or anything bucket-wide", () => {
    expect(BUCKET_ACTIONS).toEqual({ read: ["s3:GetObject"], write: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"] });
  });
});

describe("buckets of docs/architecture.md §6", () => {
  const documented = rows(section("| Bucket | Prefijos |", "- **CORS**"));

  it("has one bucket per documented purpose, with short logical names", () => {
    expect(documented.map(({ name }) => name).sort()).toEqual([...BUCKET_NAMES].sort());
    for (const name of BUCKET_NAMES) expect(name.length, name).toBeLessThanOrEqual(LOGICAL_BUCKET_NAME_MAX);
  });

  it("fixes the physical name of exactly the three buckets the browser reaches", () => {
    const fixed = BUCKET_NAMES.flatMap((name) => {
      const bucket: BucketSpec = BUCKETS[name];
      return bucket.fixed === undefined ? [] : [[name, bucket.fixed]];
    });
    expect(fixed).toEqual([
      ["Media", "media"],
      ["Documents", "documents"],
      ["Emails", "emails"],
    ]);
    expect(fixed.map(([, purpose]) => purpose)).toEqual([...BROWSER_BUCKETS]);
  });

  it("allows CORS only from the console origin: POST and GET on Media, GET on Documents and Emails", () => {
    expect(architecture).toContain(`\`AllowedOrigins = ${ORIGIN}\` exacto, \`MaxAge ${CORS_MAX_AGE_SECONDS}\``);
    const expected: Record<string, string[] | false> = { Media: ["GET", "POST"], Documents: ["GET"], Emails: ["GET"], Settlements: false, Exports: false, Seed: false };
    for (const name of BUCKET_NAMES) {
      const cors = bucketCors(name, ORIGIN);
      if (expected[name] === false) {
        expect(cors, name).toBe(false);
        continue;
      }
      expect(cors, name).toEqual({ allowOrigins: [ORIGIN], allowMethods: expected[name], allowHeaders: [], exposeHeaders: [], maxAge: "300 seconds" });
    }
  });

  it("expires objects as the retention column says, qa/ and up/ in two days", () => {
    const days = (name: (typeof BUCKET_NAMES)[number]): Record<string, number> =>
      Object.fromEntries(lifecycleRules(name).map((rule) => [rule.filter.prefix, rule.expiration.days]));
    expect(days("Media")).toEqual({ "": 90, "qa/": 2, "up/": 2 });
    expect(days("Documents")).toEqual({ "qa/": 2 });
    expect(days("Emails")).toEqual({ "": 90, "qa/": 2 });
    expect(days("Settlements")).toEqual({ "qa/": 2 });
    expect(days("Exports")).toEqual({ "": 7 });
    expect(days("Seed")).toEqual({});
    for (const name of BUCKET_NAMES) {
      const ids = lifecycleRules(name).map((rule) => rule.id);
      expect(new Set(ids).size, name).toBe(ids.length);
      for (const rule of lifecycleRules(name)) expect(rule.status).toBe("Enabled");
    }
  });

  it("puts every QA root, and only QA roots, under the two-day rule of each world bucket", () => {
    const shortLived = (name: (typeof BUCKET_NAMES)[number], key: string): boolean =>
      lifecycleRules(name).some((rule) => rule.filter.prefix !== "" && key.startsWith(rule.filter.prefix) && rule.expiration.days === 2);
    for (const name of ["Media", "Documents", "Emails", "Settlements"] as const) {
      for (const key of ["qa/run1/qa-run1-sc01/complaints/cmp-1/ACK-1.pdf", "qa/qamin/2026-10-07/mail-1.eml"]) expect(shortLived(name, key), `${name} ${key}`).toBe(true);
      for (const key of ["W/demo/complaints/cmp-1/ACK-1.pdf", "W/g07/sim/msg-1/1.png", "W/sim-001/NORTE/2026-10-07/batch-1.csv"]) expect(shortLived(name, key), `${name} ${key}`).toBe(false);
    }
    expect(shortLived("Media", "up/g07/msg-1/1.png")).toBe(true);
  });

  it("scans every Media prefix an image can land in, and not the quarantine", () => {
    const landings = ["wa/demo/wamid.X/123", "up/g07/msg-1/1.png", "W/demo/sim/msg-1/1.png", "qa/run1/qa-run1-sc03/up/msg-1/1.png", "qa/qamin/sim/msg-1/1.png"];
    for (const key of landings) expect(MEDIA_SCANNED_PREFIXES.some((prefix) => key.startsWith(prefix)), key).toBe(true);
    expect(MEDIA_SCANNED_PREFIXES.some((prefix) => `${QUARANTINE_PREFIX}wa/demo/x`.startsWith(prefix))).toBe(false);
    expect(MEDIA_SCANNED_PREFIXES.length).toBeLessThanOrEqual(5);
  });

  it("keeps every bucket inside the prefix the CI role and the boundary fence", () => {
    expect(bootstrap).toContain('!Sub "arn:${AWS::Partition}:s3:::${BucketPrefix}*"');
    for (const purpose of BROWSER_BUCKETS) expect(`${APP}-poc-${purpose}-776805327629`.startsWith(bucketPrefix(APP))).toBe(true);
  });
});

describe("register anchors (docs/architecture.md §8.3)", () => {
  const name = anchorLogGroupName(APP, "poc");

  it("uses the fixed name of §1, inside the fences of the bootstrap", () => {
    expect(name).toBe("/aws-cds-hackathon-poc-reclamo/poc/register-anchors");
    expect(section("## 1.", "## 2.")).toContain(`\`${name}\``);
    const fence = anchorLogGroupName("${AppName}", "${DeployStage}");
    for (const sid of ["DenyRemovingAnchors", "DenyAnchorWritesBesidesTheAnchorWriter"]) {
      const body = bootstrap.slice(bootstrap.indexOf(`Sid: ${sid}`), bootstrap.indexOf("- Sid:", bootstrap.indexOf(`Sid: ${sid}`) + 1));
      expect(body, sid).toContain(`log-group:${fence}*`);
    }
    const group = `arn:aws:logs:us-east-1:776805327629:log-group:${name}`;
    for (const arn of [group, `${group}:*`, `${group}:log-stream:demo-e1-REG`]) expect(stringLike(`${group}*`, arn), arn).toBe(true);
  });

  it("keeps 180 days, a retention CloudWatch Logs accepts", () => {
    expect(ANCHOR_RETENTION_DAYS).toBe(180);
    expect([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653]).toContain(ANCHOR_RETENTION_DAYS);
    expect(architecture).toContain("log group de anclas 180 días");
  });

  it("writes events only as AnchorWriter, or as the QaDriver in qa-* streams; reads only by filtering", () => {
    const putters = Object.entries(ANCHOR_ACCESS).filter(([, grants]) => grants.some((grant) => grant.actions.includes("logs:PutLogEvents")));
    expect(putters.map(([kind]) => kind).sort()).toEqual(["write", "write-qa-streams"]);
    expect(ANCHOR_ACCESS["write-qa-streams"].find((grant) => grant.actions.includes("logs:PutLogEvents"))?.streams).toBe("qa-*");
    expect(ANCHOR_ACCESS.read).toEqual([{ actions: ["logs:FilterLogEvents"] }]);
    for (const grants of Object.values(ANCHOR_ACCESS)) {
      for (const grant of grants) for (const action of grant.actions) expect(action).not.toMatch(/Delete|Retention|\*/);
    }
    expect(stringLike("qa-*", "qa-run1-sc18-e1-REG")).toBe(true);
    expect(stringLike("qa-*", "demo-e1-REG")).toBe(false);
  });
});
