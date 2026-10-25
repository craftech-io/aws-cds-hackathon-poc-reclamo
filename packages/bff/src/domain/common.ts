// Building blocks of the domain schemas: ids, actors, stamps and JSON payloads. Every entity the
// BFF stores is a zod schema over these (docs/architecture.md §5); the connector parses what it
// reads with them, so the domain never handles a row it has not validated.
import { z } from "zod";
import { IsoInstant } from "@reclamo/shared";

// Ids are shared with every edge (packages/shared/src/ids.ts).
export { ComplaintNumber, CustomerId, Id, StaffId } from "@reclamo/shared";

/** World epoch: grows on every reset and never goes back. */
export const Epoch = z.number().int().nonnegative();

export const Version = z.number().int().positive();

/** Integer centavos: amounts are stored exact and shown as `Money` by the edge that answers. */
export const Cents = z.number().int();

/** A SHA-256 or HMAC-SHA256 in lowercase hex. */
export const HexHash = z.string().regex(/^[0-9a-f]{64}$/, "expected a 64-character hex hash");

/** Who did something: the agent, a staff member, the system's deterministic code or the QA driver. */
export const Actor = z.union([z.literal("AGENT"), z.literal("SYSTEM"), z.literal("QA"), z.string().regex(/^OPERATOR:stf-[a-z0-9]+(?:-[a-z0-9]+)*$/)]);
export type Actor = z.infer<typeof Actor>;

/** Plain data (evidence details, tool results, payloads): nothing that is not JSON. */
export const JsonObject = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof JsonObject>;

/** Fields the connector stamps on every item it writes (real time). */
export const Stamps = {
  createdAt: IsoInstant.optional(),
  updatedAt: IsoInstant.optional(),
  /** Written by the seed (docs/seed-spec.md). */
  synthetic: z.literal(true).optional(),
};

/** Versioned entities change only with a conditional update on `version`. */
export const Versioned = {
  ...Stamps,
  version: Version,
};
