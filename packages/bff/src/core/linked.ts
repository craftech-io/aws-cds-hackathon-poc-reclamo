// The core client of a Lambda, wired from what SST links into it (through lib/resource.ts, never
// `process.env`):
//
//   CoreMock   `url`: the core's Function URL (the functions with capability `MOCK_CORE`)
//
// One instance per container, reused across invocations.
import { z } from "zod";
import { readLinked } from "../lib/resource";
import { type CoreClient, createCoreClient } from "./client";
import { sigV4Signer } from "./signer";

const CoreMockLink = z.object({ url: z.url() });

let client: CoreClient | undefined;

export function linkedCoreClient(): CoreClient {
  client ??= createCoreClient({ endpoint: readLinked("CoreMock", CoreMockLink).url, sign: sigV4Signer() });
  return client;
}
