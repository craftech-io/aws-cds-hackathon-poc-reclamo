// Lambda entry of the `QaDriver` (`aws-cds-hackathon-poc-reclamo-poc-qa-driver`, no URL; its resource
// policy admits only the bootstrap's `qa-runner` role; ADR-0009, docs/architecture.md §14). It is invoked
// directly with `{ action, idempotencyKey, input }` and always answers `{ ok, … }` (qa-driver/driver.ts).
// Linked resources are read through lib/resource.ts (`Resource`, never `process.env`), lazily, by the
// ports of qa-driver/stage-ports.ts.
import { createLogger } from "../lib/log";
import type { QaResponse } from "../qa-driver/contract";
import { type QaDriver, createQaDriver } from "../qa-driver/driver";
import { ACTION_HANDLERS } from "../qa-driver/handlers";
import { stagePorts } from "../qa-driver/stage-ports";

let driver: QaDriver | undefined;

export const handler = async (event: unknown): Promise<QaResponse> => {
  driver ??= createQaDriver({
    ports: stagePorts(),
    handlers: ACTION_HANDLERS,
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "qa-driver" } }),
  });
  return driver(event);
};
