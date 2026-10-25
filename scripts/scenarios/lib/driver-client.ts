// The runner's only way into the stage (ADR-0009, docs/test-plan.md §4.1): `lambda:InvokeFunction` of the
// `QaDriver` with the credentials of the environment, which in CI is the bootstrap's `qa-runner` role
// through OIDC (no laptop path: the role trusts only deploy.yml and scenarios.yml on main). Never a human
// credential. Inputs and results are never logged: they can carry synthetic addresses of a QA world.
//
// Retries (docs/tool-catalog.md "Acciones del QaDriver"): a throttle means the function never ran, so it
// is always retried under the same key; any other transport failure is retried only for a probe or a
// read, which the driver never remembers. A changing action that timed out is not repeated behind the
// scenario's back: the step fails and the report says so.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { type QaActionName, type QaResponse, QaResponseSchema, UNREMEMBERED_ACTIONS } from "@reclamo/bff/qa-driver/contract";
import { procedureKind } from "@reclamo/bff/qa-driver/console";
import { realSleep } from "./eventually";

/** Fixed name of the function (infra/bff.ts `qaDriverName`): the qa-runner role may invoke nothing else. */
export const QA_DRIVER_FUNCTION_NAME = "aws-cds-hackathon-poc-reclamo-poc-qa-driver";
export const REGION = "us-east-1";

export type Invoke = (payload: string) => Promise<{ readonly statusCode: number; readonly functionError?: string; readonly payload: string }>;

export interface DriverClientOptions {
  readonly invoke?: Invoke;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface DriverClient {
  call(action: QaActionName, input: unknown, idempotencyKey: string): Promise<QaResponse>;
}

/** A Lambda error or a throttle: worth another try under the same key when the action allows it. */
export class TransportError extends Error {
  override readonly name = "TransportError";
  constructor(
    message: string,
    readonly throttled: boolean,
  ) {
    super(message);
  }
}

// An action answers within PROBE_BUDGET_MS (50 s) plus its own reads; the client waits a little longer.
const INVOKE_TIMEOUT_MS = 120_000;

export function lambdaInvoke(functionName: string = QA_DRIVER_FUNCTION_NAME): Invoke {
  // maxAttempts 1: the SDK must never repeat a changing action on its own (see the header).
  const client = new LambdaClient({ region: REGION, maxAttempts: 1, requestHandler: new NodeHttpHandler({ requestTimeout: INVOKE_TIMEOUT_MS, connectionTimeout: 5_000 }) });
  return async (payload) => {
    const answer = await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(payload) }));
    return { statusCode: answer.StatusCode ?? 0, ...(answer.FunctionError ? { functionError: answer.FunctionError } : {}), payload: new TextDecoder().decode(answer.Payload ?? new Uint8Array()) };
  };
}

/** Whether a call reads only: the driver never remembers it, so repeating it has no effect. */
export function isRead(action: QaActionName, input: unknown): boolean {
  if (action === "console") return procedureKind(String((input as { procedure?: unknown } | undefined)?.procedure ?? "")) === "query";
  return UNREMEMBERED_ACTIONS.has(action);
}

function throttled(error: unknown): boolean {
  if (error instanceof TransportError) return error.throttled;
  return error instanceof Error && /Throttl|TooManyRequests/i.test(`${error.name} ${error.message}`);
}

function transient(error: unknown): boolean {
  if (error instanceof TransportError) return true;
  return error instanceof Error && /ECONNRESET|socket hang up|TimeoutError|ETIMEDOUT|EPIPE/i.test(`${error.name} ${error.message}`);
}

export function createDriverClient(options: DriverClientOptions = {}): DriverClient {
  let invoke = options.invoke;
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? realSleep;
  return {
    async call(action, input, idempotencyKey) {
      invoke ??= lambdaInvoke();
      const payload = JSON.stringify({ action, idempotencyKey, input });
      const read = isRead(action, input);
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const answer = await invoke(payload);
          if (answer.statusCode === 429) throw new TransportError("the QA driver was throttled", true);
          if (answer.functionError !== undefined || answer.statusCode >= 500) throw new TransportError(`the QA driver failed (${answer.functionError ?? answer.statusCode})`, false);
          return QaResponseSchema.parse(JSON.parse(answer.payload)) as QaResponse;
        } catch (error) {
          lastError = error;
          const retry = throttled(error) || (read && transient(error));
          if (!retry || attempt === attempts - 1) break;
          await sleep(Math.min(8_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 250));
        }
      }
      throw lastError instanceof Error ? lastError : new TransportError(String(lastError), false);
    },
  };
}
