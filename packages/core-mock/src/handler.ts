/// <reference path="../../../sst-env.d.ts" />
// Lambda entry of `CoreMock` (Function URL with `AWS_IAM`; docs/architecture-integrations.md §5).
// Only Function URL events are answered: anything else is refused before the app runs. Linked
// resources, read through `Resource` and validated with zod (never `process.env`):
//
//   Core          the mock's own table (`name`)
//   MockCallers   `roles`: the role ARN of each function that may invoke a mock, by logical name
//   PhoneHashKey  secret; its `email-hash` subkey hashes a new email of a data-change request
import { createHmac, hkdfSync } from "node:crypto";
import { errorResponse } from "@reclamo/core-contract";
import { normalizeEmail } from "@reclamo/shared";
import type { LambdaFunctionURLResult } from "aws-lambda";
import { Resource } from "sst";
import { z } from "zod";
import { type CoreAppDeps, type CoreEvent, createCoreApp } from "./app";
import { MockCallersLink, callerDirectory } from "./http/caller";
import { toCoreRequest } from "./http/event";
import { coreLogLine } from "./log";
import { coreDocumentClient, createDynamoCoreStore } from "./store/dynamo";

const TableLink = z.object({ name: z.string().min(1) });
const SecretLink = z.object({ value: z.string().min(32) });

function linked<T>(logicalName: string, schema: z.ZodType<T>): T {
  // `Resource` is a Proxy that throws for anything not linked; zod checks the shape it returns.
  return schema.parse(Reflect.get(Resource, logicalName));
}

/** Same derivation as packages/bff/src/lib/crypto.ts (`PhoneHashKey` → `email-hash`), so hashes compare. */
function emailHasher(secret: string): (email: string) => string {
  const key = Buffer.from(hkdfSync("sha256", secret, "aws-cds-hackathon-poc-reclamo", "PhoneHashKey/email-hash", 32));
  return (email) => createHmac("sha256", key).update(normalizeEmail(email)).digest("hex");
}

let deps: Omit<CoreAppDeps, "onEvent"> | undefined;

function linkedDeps(): Omit<CoreAppDeps, "onEvent"> {
  deps ??= {
    store: createDynamoCoreStore({ tableName: linked("Core", TableLink).name, client: coreDocumentClient() }),
    callers: callerDirectory(linked("MockCallers", MockCallersLink)),
    hashEmail: emailHasher(linked("PhoneHashKey", SecretLink).value),
  };
  return deps;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

export async function handler(event: unknown): Promise<LambdaFunctionURLResult> {
  const request = toCoreRequest(event);
  if (request === undefined) {
    write(coreLogLine("core request refused", { operation: "unknown", status: 400, detail: "NOT_A_FUNCTION_URL_EVENT" }));
    const { statusCode, body } = errorResponse("INVALID", "the core answers only through its Function URL");
    return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }
  const app = createCoreApp({ ...linkedDeps(), onEvent: (coreEvent: CoreEvent) => write(coreLogLine("core request", coreEvent, request.requestId)) });
  const response = await app(request);
  return { statusCode: response.statusCode, headers: { ...response.headers }, body: response.body };
}
