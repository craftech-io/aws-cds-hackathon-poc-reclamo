// What the `PolicyAudit` Lambda accepts (policy-audit/run.ts), in a module of their own so the infra
// specs can check the scheduled input without loading the audit.
import { z } from "zod";
import { WorldId } from "@reclamo/shared";

export const OnDemand = z.object({ worldId: WorldId }).strict();
const Daily = z.object({ kind: z.literal("DAILY") }).strict();
const Scheduled = z.object({ source: z.enum(["aws.events", "aws.scheduler"]), "detail-type": z.string().max(200).optional() }).passthrough();

export const PolicyAuditRequest = z.union([OnDemand, Daily, Scheduled]);
