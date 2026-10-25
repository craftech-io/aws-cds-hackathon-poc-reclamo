/// <reference path="../../sst-env.d.ts" />
// Adapters of the self-signup inside the stage: the linked `GuestSignup` client (with the secret
// Cognito generated), `PhoneHashKey` for the hashes, the DNS resolver, and the asynchronous
// invocations of `WorldJanitor` and `LeadNotifier` by their linked names. Everything is read through
// `Resource` (lib/resource.ts, lib/secrets.ts), never `process.env`, and built once per container.
// The post-confirmation trigger reaches the janitor through `WorldJanitorInvoke` (its fixed name,
// infra/world-janitor-link.ts), the Bff through the linked Function `WorldJanitor`. A function that is
// not linked is skipped with a warning: the ticket waits for the janitor's provisioning pass.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { RepoContext } from "../connector/codec";
import { createConnector } from "../connector/create";
import { DynamoStore } from "../connector/dynamo/engine";
import { awsClientConfig } from "../lib/clients";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { keySecret } from "../lib/secrets";
import { signupCaps } from "./caps";
import { createGuestCognito } from "./cognito-port";
import { dnsMailDomainResolver } from "./email-domain";
import { leadHashes } from "../leads/keys";
import { type GuestWorldService, guestWorldService } from "./world-status";
import type { ProvisionInvoker } from "./provision";
import { leadsRepo } from "../leads/repo";
import type { SignupServiceDeps } from "./service-deps";

/** `GuestSignup` (infra/auth.ts): the confidential client and whether the pool mails through SES. */
export const GuestSignupLink = z.object({
  userPoolId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  region: z.string().min(1),
  mailReady: z.boolean(),
});

const FunctionLink = z.object({ name: z.string().min(1) });

/** The first of `names` linked to this function. */
function linkedFunction(names: readonly string[]): string | undefined {
  for (const name of names) {
    try {
      return readLinked(name, FunctionLink).name;
    } catch {
      // Not linked here: try the next name.
    }
  }
  return undefined;
}

/** Link names of each target, in order: the trigger links the janitor by name, the Bff its Function. */
export const INVOKE_LINKS = { createWorld: ["WorldJanitorInvoke", "WorldJanitor"], notifyLead: ["LeadNotifier"] } as const;

const LAMBDA_TIMEOUTS = { requestTimeoutMs: 2_000, connectionTimeoutMs: 1_000, maxAttempts: 2 } as const;

/** `InvocationType: Event` by linked function name; the payload is only what the contract allows. */
export function lambdaProvisionInvoker(log: Logger, client: LambdaClient = new LambdaClient(awsClientConfig(LAMBDA_TIMEOUTS))): ProvisionInvoker {
  const invoke = async (linkNames: readonly string[], payload: object): Promise<void> => {
    const functionName = linkedFunction(linkNames);
    if (!functionName) {
      log.warn("signup.function_not_linked", { target: linkNames.join("|") });
      return;
    }
    await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(payload)) }));
  };
  return {
    createWorld: (request) => invoke(INVOKE_LINKS.createWorld, request),
    notifyLead: (request) => invoke(INVOKE_LINKS.notifyLead, request),
  };
}

let shared: Omit<SignupServiceDeps, "log" | "invoker"> | undefined;

/** The services' adapters over DynamoDB, Cognito and DNS; the logger and the invoker are per request. */
export function stageSignupDeps(log: Logger): SignupServiceDeps {
  if (!shared) {
    const link = readLinked("GuestSignup", GuestSignupLink);
    const store = new DynamoStore();
    const ctx: RepoContext = { store, now: () => new Date() };
    shared = {
      ctx,
      connector: createConnector(store, { now: ctx.now }),
      leads: leadsRepo(ctx),
      caps: signupCaps(ctx),
      cognito: createGuestCognito(link),
      clientId: link.clientId,
      hashes: leadHashes(keySecret("PhoneHashKey")),
      resolver: dnsMailDomainResolver(),
      mailReady: () => link.mailReady,
    };
  }
  return { ...shared, invoker: lambdaProvisionInvoker(log), log };
}

/** `guest.status` and `guest.requestWorld` over the same adapters (the Bff's own table grants). */
export function stageGuestWorld(log: Logger): GuestWorldService {
  const deps = stageSignupDeps(log);
  return guestWorldService({ ctx: deps.ctx, connector: deps.connector, leads: deps.leads, caps: deps.caps, invoker: deps.invoker, log });
}
