// The asynchronous invocations of the self-signup (guests/runtime.ts): the post-confirmation trigger
// reaches WorldJanitor through `WorldJanitorInvoke` (its fixed name), never through the Function, which
// would make the user pool wait for the janitor (infra/world-janitor-link.ts).
import type { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../lib/log";
import { INVOKE_LINKS, lambdaProvisionInvoker } from "./runtime";

const linked = vi.hoisted(() => ({ names: {} as Record<string, { name: string }> }));
vi.mock("sst", () => ({ Resource: new Proxy({}, { get: (_target, name) => (typeof name === "string" ? linked.names[name] : undefined) }) }));

function recorder() {
  const sent: Array<{ FunctionName?: string; InvocationType?: string; payload: unknown }> = [];
  const client = {
    send: async (command: InvokeCommand) => {
      sent.push({ FunctionName: command.input.FunctionName, InvocationType: command.input.InvocationType, payload: JSON.parse(new TextDecoder().decode(command.input.Payload as Uint8Array)) });
      return {};
    },
  } as unknown as LambdaClient;
  const warnings: string[] = [];
  const log = createLogger({ sink: (line) => void warnings.push(line) });
  return { sent, client, log, warnings };
}

const REQUEST = { kind: "WORLD_CREATE", worldId: "gs-0001", requestId: "01J0000000000000000000000A" } as const;

// `readLinked` caches a link once read, so the unlinked case runs first.
describe("lambdaProvisionInvoker", () => {
  it("skips with a warning when neither link is there: the ticket waits for the provisioning pass", async () => {
    linked.names = {};
    const { sent, client, log, warnings } = recorder();
    await lambdaProvisionInvoker(log, client).createWorld(REQUEST);
    expect(sent).toEqual([]);
    expect(warnings.join("\n")).toContain("signup.function_not_linked");
  });

  it("invokes the janitor by the fixed name of WorldJanitorInvoke, asynchronously, with only the request", async () => {
    linked.names = { WorldJanitorInvoke: { name: "reclamo-poc-world-janitor" } };
    const { sent, client, log } = recorder();
    await lambdaProvisionInvoker(log, client).createWorld(REQUEST);
    expect(sent).toEqual([{ FunctionName: "reclamo-poc-world-janitor", InvocationType: "Event", payload: REQUEST }]);
    expect(INVOKE_LINKS.createWorld[0]).toBe("WorldJanitorInvoke");
  });
});
