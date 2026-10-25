// `Reference/TEMPLATE#WHATSAPP/<name>`: the four `UTILITY` templates with what Meta said about them
// (docs/architecture-integrations.md §3.1). The seed writes them `LOCAL_ONLY`;
// scripts/channels/whatsapp-templates.ts registers them and records `metaTemplateId` and `status`.
// The live transport sends only an `APPROVED` one; the simulated one renders any that exists.
import { z } from "zod";
import { TemplateName } from "../../copy";
import type { Connector } from "../../connector/port";
import type { TemplateStatusReader } from "./transport";

export const TEMPLATE_REFERENCE = { type: "TEMPLATE", scope: "WHATSAPP" } as const;

export const TemplateStatus = z.enum(["LOCAL_ONLY", "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"]);
export type TemplateStatus = z.infer<typeof TemplateStatus>;

export const TemplateRecord = z.object({
  name: TemplateName,
  status: TemplateStatus,
  category: z.literal("UTILITY"),
  language: z.literal("es_AR"),
  metaTemplateId: z.string().min(1).max(64).optional(),
});
export type TemplateRecord = z.infer<typeof TemplateRecord>;

/** Reads a template's status from `Reference`; `undefined` when the seed never wrote it. */
export function referenceTemplateStatus(data: Pick<Connector, "reference">): TemplateStatusReader {
  return {
    async status(name) {
      if (!TemplateName.safeParse(name).success) return undefined;
      return (await data.reference.get(TemplateRecord, TEMPLATE_REFERENCE.type, TEMPLATE_REFERENCE.scope, name))?.status;
    },
  };
}
