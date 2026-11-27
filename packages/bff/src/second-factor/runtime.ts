/// <reference path="../../sst-env.d.ts" />
// The SMS code inside the stage (docs/architecture-guests.md §17): DynamoDB through the Bff's own grants,
// `PhoneHashKey` for the hashes (read through `Resource`, lib/secrets.ts), Amazon SNS for the SMS, and the
// invocations of `WorldJanitor` and `LeadNotifier` by their linked names. Built once per container; the
// cache of passed sessions lives as long as the container, the logger is per request.
import type { AuditSink } from "../auth/audit";
import type { RepoContext } from "../connector/codec";
import { createConnector } from "../connector/create";
import { DynamoStore } from "../connector/dynamo/engine";
import { signupCaps } from "../guests/caps";
import { lambdaProvisionInvoker } from "../guests/runtime";
import { leadsRepo } from "../leads/repo";
import type { Logger } from "../lib/log";
import { keySecret } from "../lib/secrets";
import { snsSmsTransport } from "../outbound/transports/sms";
import { secondFactorHashes } from "./hashes";
import { PassCache, type SecondFactorDeps, type SecondFactorService, secondFactorService } from "./service";

let shared: Omit<SecondFactorDeps, "log" | "invoker" | "audit"> | undefined;

export function stageSecondFactor(log: Logger, audit: AuditSink): SecondFactorService {
  if (!shared) {
    const store = new DynamoStore();
    const ctx: RepoContext = { store, now: () => new Date() };
    const connector = createConnector(store, { now: ctx.now });
    shared = {
      ctx,
      worlds: connector.worlds,
      leads: leadsRepo(ctx),
      caps: signupCaps(ctx),
      hashes: secondFactorHashes(keySecret("PhoneHashKey")),
      sms: snsSmsTransport(),
      cache: new PassCache(),
    };
  }
  return secondFactorService({ ...shared, invoker: lambdaProvisionInvoker(log), audit, log });
}
