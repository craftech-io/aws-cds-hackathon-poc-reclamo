// The in-process signature of a tool handler (docs/tool-catalog.md "Invocación directa"): the
// worker, the `Bff` and the `QaDriver` call a target's handler with the principal they already
// authenticated (queue, JWT, QA role). A `caller` never travels in a Lambda invocation: every
// deployed entry accepts only `{sessionToken, …}` and refuses a `caller` as `INVALID`, so nothing
// here authenticates anyone.
import { z } from "zod";
import { StaffRole } from "./enums";
import { Id, StaffId } from "./ids";
import { WorldId } from "./world-kind";

export const CallerKind = z.enum(["WORKER", "CHANNEL", "CONSOLE", "QA", "SCHEDULER"]);
export type CallerKind = z.infer<typeof CallerKind>;

export const Caller = z
  .object({
    kind: CallerKind,
    worldId: WorldId,
    staffId: StaffId.optional(),
    role: StaffRole.optional(),
    /** The event, request or step the call belongs to (idempotency and audit). */
    eventId: Id,
  })
  .strict()
  .refine((caller) => caller.kind !== "CONSOLE" || (caller.staffId !== undefined && caller.role !== undefined), {
    message: "a console caller carries its staff id and role",
    path: ["staffId"],
  });
export type Caller = z.infer<typeof Caller>;

/** True when an input names a `caller`: a deployed entry refuses it before reading anything. */
export function carriesCaller(input: unknown): boolean {
  return typeof input === "object" && input !== null && Object.hasOwn(input, "caller");
}
