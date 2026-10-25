// What a target Lambda runs with, built once per container on its first invocation: the DynamoDB
// connector, `SessionKey` (lib/secrets.ts reads it through `Resource`, never `process.env`), real time
// and the core's answer about what belongs to the customer. Each target's handler.ts exports
// `handler = lambdaEntry(create…, ownership)`, the entry the infra points its Function at.
import { dynamoConnector } from "../../connector/dynamo/connector";
import { createLogger } from "../../lib/log";
import { keySecret } from "../../lib/secrets";
import type { ToolResponse } from "./context";
import type { GatewayTargetRuntime, ToolDeps } from "./handler";
import type { LambdaContextLike } from "./principal";
import type { CoreOwnership } from "./scope";

export function productionToolDeps(ownership: CoreOwnership): ToolDeps {
  return {
    connector: dynamoConnector(),
    sessionKey: () => keySecret("SessionKey"),
    wallClock: () => new Date(),
    loggerFor: (correlationId) => createLogger({ correlationId }),
    ownership,
  };
}

export type ToolLambdaHandler = (event: unknown, context?: LambdaContextLike) => Promise<ToolResponse>;

/**
 * The deployed entry of a target: only `handle` (a Gateway call with the turn's token) is reachable; the
 * in-process `invoke` is never exported through it. Nothing is built at import time, so a test can import
 * the module freely.
 */
export function lambdaEntry(create: (deps: ToolDeps) => GatewayTargetRuntime, ownership: () => CoreOwnership): ToolLambdaHandler {
  let target: GatewayTargetRuntime | undefined;
  return (event, context) => {
    target ??= create(productionToolDeps(ownership()));
    return target.handle(event, context);
  };
}
