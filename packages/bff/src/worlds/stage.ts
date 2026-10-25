/// <reference path="../../sst-env.d.ts" />
// The world factory's adapters inside the stage (`WorldJanitor`, and `seed:load` / `console:invite` in
// `sst shell`): DynamoDB, the `Seed` bucket, the world buckets, the Scheduler, the Memory of the linked
// `Agent`, `AnchorWriter`, `WorldJanitor` itself and, where linked, the console's user pool. Everything
// is read through `Resource` (lib/resource.ts, lib/secrets.ts), lazily, so building the deps never
// fails; `assertLinked` checks what every build needs before anything is written.
import { AdminDeleteUserCommand, CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ListSchedulesCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { z } from "zod";
import { ToolError } from "@reclamo/shared";
import { authConfig } from "../auth/config";
import { lambdaAnchorRequester } from "../complaints/anchors";
import { createConnector } from "../connector/create";
import { DynamoStore } from "../connector/dynamo/engine";
import { awsClientConfig } from "../lib/clients";
import { deriveSubkey, ulid } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import { bucketName, readLinked, tableName } from "../lib/resource";
import { keySecret } from "../lib/secrets";
import { SCHEDULER_TIMEOUTS, SchedulerLink, eventBridgeScheduler, unqualifiedFunctionArn } from "../timers/scheduler-client";
import type { AccountSummary, GuestAccounts, JanitorInvoker, ScheduleRemover, WorldKeys, WorldsDeps } from "./deps";
import { agentCoreMemoryAdmin } from "./memory-admin";
import { s3WorldObjects } from "./objects";
import { s3TemplateSource } from "./template";

const FunctionLink = z.object({ name: z.string().min(1) });
const LAMBDA_TIMEOUTS = { requestTimeoutMs: 2_000, connectionTimeoutMs: 1_000, maxAttempts: 2 } as const;
const COGNITO_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

/**
 * `InvocationType: Event` of `WorldJanitor` with only `{kind, worldId, requestId}`: the linked function
 * (the `Bff`, `seed:load`), or the janitor itself by the ARN of the running invocation (a continuation).
 */
export function lambdaJanitorInvoker(log: Logger, options: { readonly self?: string; readonly client?: Pick<LambdaClient, "send"> } = {}): JanitorInvoker {
  let lambda = options.client;
  return {
    async invoke(event) {
      let functionName: string;
      try {
        functionName = options.self ?? readLinked("WorldJanitor", FunctionLink).name;
      } catch {
        // seed:load in a shell without the link: the hourly pass picks the ticket up.
        log.warn("worlds.janitor_not_linked", { kind: event.kind });
        return;
      }
      lambda ??= new LambdaClient(awsClientConfig(LAMBDA_TIMEOUTS));
      const payload = { kind: event.kind, worldId: event.worldId, requestId: event.requestId };
      await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(payload)) }));
    },
  };
}

function quoted(value: string): string {
  if (!/^[A-Za-z0-9@._+-]{1,128}$/.test(value)) throw new ToolError("INVALID", "invalid account filter", "ACCOUNT_FILTER");
  return `"${value}"`;
}

/** The console's user pool, for the cleanups (`ListUsers`, `AdminDeleteUser`; fenced in code). */
export function cognitoGuestAccounts(client?: Pick<CognitoIdentityProviderClient, "send">): GuestAccounts {
  let cognito = client;
  const pool = () => authConfig().userPoolId;
  const send = () => (cognito ??= new CognitoIdentityProviderClient(awsClientConfig(COGNITO_TIMEOUTS)));
  return {
    async list(filter) {
      const expression = filter.usernamePrefix
        ? `username ^= ${quoted(filter.usernamePrefix)}`
        : filter.sub
          ? `sub = ${quoted(filter.sub)}`
          : `cognito:user_status = ${quoted(filter.status ?? "UNCONFIRMED")}`;
      const accounts: AccountSummary[] = [];
      let token: string | undefined;
      do {
        const page = await send().send(new ListUsersCommand({ UserPoolId: pool(), Filter: expression, Limit: 60, PaginationToken: token }));
        for (const user of page.Users ?? []) {
          if (!user.Username || !user.UserCreateDate) continue;
          const worldId = user.Attributes?.find((attribute) => attribute.Name === "custom:worldId")?.Value;
          accounts.push({ username: user.Username, status: user.UserStatus ?? "UNKNOWN", createdAt: user.UserCreateDate, ...(worldId ? { worldId } : {}) });
        }
        token = page.PaginationToken;
      } while (token && accounts.length < 2_000);
      return accounts;
    },
    async delete(username) {
      try {
        await send().send(new AdminDeleteUserCommand({ UserPoolId: pool(), Username: username }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "UserNotFoundException")) throw error;
      }
    },
  };
}

/** Deletes through the one Scheduler client (timers/scheduler-client.ts); lists the app's group by prefix. */
export function stageSchedules(client?: Pick<SchedulerClient, "send">): ScheduleRemover {
  const scheduler = eventBridgeScheduler();
  let lister = client;
  return {
    delete: (name) => scheduler.delete(name),
    async list(prefix) {
      lister ??= new SchedulerClient(awsClientConfig(SCHEDULER_TIMEOUTS));
      const group = readLinked("Scheduler", SchedulerLink).groupName;
      const names: string[] = [];
      let token: string | undefined;
      do {
        const page = await lister.send(new ListSchedulesCommand({ GroupName: group, NamePrefix: prefix, MaxResults: 100, NextToken: token }));
        names.push(...(page.Schedules ?? []).flatMap((schedule) => (schedule.Name ? [schedule.Name] : [])));
        token = page.NextToken;
      } while (token && names.length < 5_000);
      return names;
    },
  };
}

function stageKeys(): () => WorldKeys {
  let keys: WorldKeys | undefined;
  return () => {
    if (!keys) {
      const phoneHashKey = keySecret("PhoneHashKey");
      keys = { chainKey: keySecret("RegisterChainKey"), phoneHash: deriveSubkey("PhoneHashKey", phoneHashKey, "phone-hash"), emailHash: deriveSubkey("PhoneHashKey", phoneHashKey, "email-hash") };
    }
    return keys;
  };
}

export type StageWorldsDeps = WorldsDeps & { readonly assertLinked: () => void };

/** The deps of the stage, built lazily (see the header). */
export function stageWorldsDeps(options: { readonly log?: Logger; readonly selfArn?: string } = {}): StageWorldsDeps {
  const log = options.log ?? createLogger({ bindings: { service: "worlds" } });
  const store = new DynamoStore();
  const now = () => new Date();
  const keys = stageKeys();
  let linkedPool = true;
  try {
    authConfig();
  } catch {
    linkedPool = false;
  }
  return {
    store,
    connector: createConnector(store, { now }),
    templates: s3TemplateSource(() => bucketName("Seed")),
    objects: s3WorldObjects({ log }),
    schedules: stageSchedules(),
    memory: agentCoreMemoryAdmin({ log }),
    anchors: lambdaAnchorRequester(log),
    invoker: lambdaJanitorInvoker(log, options.selfArn ? { self: unqualifiedFunctionArn(options.selfArn) } : {}),
    keys,
    log,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newId: () => ulid(now().getTime()),
    ...(linkedPool ? { accounts: cognitoGuestAccounts() } : {}),
    assertLinked: () => {
      try {
        tableName("Worlds");
        bucketName("Seed");
        keys();
      } catch (error) {
        throw new ToolError("UNAVAILABLE", "the world factory is not linked here (tables, Seed bucket, keys)", "FACTORY_NOT_LINKED", { cause: error });
      }
    },
  };
}
