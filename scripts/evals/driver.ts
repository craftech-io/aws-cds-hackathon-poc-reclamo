// The evaluations' only way into the stage (ADR-0009, docs/test-plan.md §4.1): `lambda:InvokeFunction`
// of the `QaDriver` with the `qa-runner` role CI assumes through OIDC. Every call carries the key
// `<runId>/<scenario>/<step>[/<label>]` (scenario `ev1`…`ev3[-<world>]`), so a retried transport
// failure replays instead of acting twice. Inputs and results are never logged: a world's rows carry
// synthetic addresses.
//
// Before anything leaves the machine the input is parsed with the driver's own schema
// (qa-driver/inputs.ts): an action or an input shape the deployed contract does not have yet is
// `BLOCKED` here, never sent and never a pass.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { QA_ACTIONS, type QaActionName, QaResponseSchema, RunId, idempotencyKeyOf } from "../../packages/bff/src/qa-driver/contract";
import { ACTION_INPUTS } from "../../packages/bff/src/qa-driver/inputs";

export const STAGE = "poc";
/**
 * Fixed name the bootstrap fences `qa-runner` to (infra/bff.ts `qaDriverFunctionName`,
 * infra/bootstrap/ci-role.yaml `InvokeTheQaDriverOnly`); infra/ modules need SST's globals to load.
 */
export const QA_DRIVER_FUNCTION = `aws-cds-hackathon-poc-reclamo-${STAGE}-qa-driver`;

/** The driver works at most 90 s per call (PROBE_BUDGET_MS plus its own wrap-up). */
const INVOKE_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;

export type Invoke = (payload: string) => Promise<{ readonly statusCode: number; readonly functionError?: string; readonly payload: string }>;

/** A refusal of the driver (or of the local contract check): code and reason, never a body. */
export class DriverRefusal extends Error {
  override readonly name = "DriverRefusal";
  constructor(
    readonly action: string,
    readonly code: string,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(`${action}: ${code}${reason === undefined ? "" : ` ${reason}`} (${message})`);
  }

  /** What is missing on the stage, not what the stage got wrong: the gate is BLOCKED, not FAILED. */
  get blocked(): boolean {
    return this.code === "LOCAL_CONTRACT" || this.reason === "NOT_WIRED";
  }
}

class TransportError extends Error {
  override readonly name = "TransportError";
}

export interface CallRef {
  /** `ev1`, `ev2-path`, `ev3-w01`: the scenario segment of the key (and of the world id). */
  readonly scenario: string;
  readonly step: number;
  readonly label?: string;
}

export interface EvalDriver {
  readonly runId: string;
  call<T = unknown>(action: string, input: unknown, ref: CallRef): Promise<T>;
}

export function lambdaInvoke(functionName: string = QA_DRIVER_FUNCTION, region = "us-east-1"): Invoke {
  const client = new LambdaClient({ region, maxAttempts: 1, requestHandler: new NodeHttpHandler({ requestTimeout: INVOKE_TIMEOUT_MS, connectionTimeout: 5_000 }) });
  return async (payload) => {
    const answer = await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(payload) }));
    return { statusCode: answer.StatusCode ?? 0, ...(answer.FunctionError ? { functionError: answer.FunctionError } : {}), payload: new TextDecoder().decode(answer.Payload ?? new Uint8Array()) };
  };
}

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryable(error: unknown): boolean {
  return error instanceof TransportError || (error instanceof Error && /Throttl|TooManyRequests|ECONNRESET|ETIMEDOUT|socket hang up|TimeoutError/i.test(`${error.name} ${error.message}`));
}

/** The input checked against the driver's schema: undefined when it fits. */
export function localContractProblem(action: string, input: unknown): string | undefined {
  if (!(QA_ACTIONS as readonly string[]).includes(action)) return "the deployed driver contract has no such action";
  const parsed = ACTION_INPUTS[action as QaActionName].safeParse(input);
  return parsed.success ? undefined : `the driver contract refuses this input (${parsed.error.issues.map((issue) => issue.path.join(".") || "input").join(", ")})`;
}

export interface DriverOptions {
  readonly runId: string;
  readonly invoke?: Invoke;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createEvalDriver(options: DriverOptions): EvalDriver {
  const runId = RunId.parse(options.runId);
  const sleep = options.sleep ?? sleepReal;
  let invoke = options.invoke;
  return {
    runId,
    async call<T>(action: string, input: unknown, ref: CallRef): Promise<T> {
      const problem = localContractProblem(action, input);
      if (problem !== undefined) throw new DriverRefusal(action, "LOCAL_CONTRACT", undefined, problem);
      const idempotencyKey = idempotencyKeyOf({ runId, scenario: ref.scenario, step: ref.step, ...(ref.label === undefined ? {} : { label: ref.label }) });
      const payload = JSON.stringify({ action, idempotencyKey, input });
      invoke ??= lambdaInvoke();
      let lastError: unknown;
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        try {
          const answer = await invoke(payload);
          if (answer.functionError !== undefined || answer.statusCode >= 500) throw new TransportError(`the QA driver failed (${answer.functionError ?? answer.statusCode})`);
          const parsed = QaResponseSchema.parse(JSON.parse(answer.payload));
          if (!parsed.ok) throw new DriverRefusal(action, parsed.error.code, parsed.error.reason, parsed.error.message);
          return parsed.result as T;
        } catch (error) {
          lastError = error;
          if (!retryable(error) || attempt === ATTEMPTS - 1) break;
          await sleep(Math.min(8_000, 1_000 * 2 ** attempt));
        }
      }
      throw lastError instanceof Error ? lastError : new TransportError(String(lastError));
    },
  };
}

export interface EventuallyOptions {
  readonly timeoutMs: number;
  readonly everyMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Repeats a non-blocking probe until `done` says so; the last answer is returned either way. */
export async function eventually<T>(probe: () => Promise<T>, done: (value: T) => boolean, options: EventuallyOptions): Promise<{ readonly value: T; readonly met: boolean }> {
  const sleep = options.sleep ?? sleepReal;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return { value, met: true };
    if (now() + options.everyMs > deadline) return { value, met: false };
    await sleep(options.everyMs);
  }
}

/** `<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`: evaluations run only in CI (docs/test-plan.md §4.1). */
export function runIdFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  if (env.CI !== "true") throw new Error("evaluations run only in CI (scenarios.yml, suite eval)");
  const id = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  return RunId.parse(`${id ?? ""}-${attempt}`);
}
