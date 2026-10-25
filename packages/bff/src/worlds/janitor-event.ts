// The inputs `WorldJanitor` accepts (worlds/janitor.ts), in a module of their own so the infra specs
// can check the scheduled inputs without loading the world factory.
import { z } from "zod";
import { WorldId } from "@reclamo/shared";

/** Ticket ids are ULIDs (lib/crypto.ts `ulid`). */
const RequestId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a ULID");

const Ticketed = <K extends string>(kind: K) => z.object({ kind: z.literal(kind), worldId: WorldId, requestId: RequestId }).strict();
const Pass = <K extends string>(kind: K) => z.object({ kind: z.literal(kind) }).strict();

export const JanitorEvent = z.discriminatedUnion("kind", [
  Ticketed("WORLD_CREATE"),
  Ticketed("WORLD_RESET"),
  Ticketed("MEMORY_PURGE"),
  Pass("PROVISION_PASS"),
  Pass("HOURLY_PASS"),
  Pass("NIGHTLY_PASS"),
]);
export type JanitorEvent = z.infer<typeof JanitorEvent>;
