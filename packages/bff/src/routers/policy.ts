// `policy` router (docs/tool-catalog.md "Procedimientos de la consola"; docs/design-brief.md §7 and §9
// "Política de canal"; ADR-0002; ADR-0017): what the outbound gate decides with, as the console shows
// it next to "nuestra lectura, no asesoramiento legal".
//
//   rules         every `CH-*` rule (plus G2 and the deterministic check) with its text and English
//                 gloss, the rule-set and lexicon versions, and the parameters of THIS world
//   modes         the world's channel modes: email always live (outbound only), WhatsApp as the world's
//                 settings say within what the stage allows; and whether the agent is cut
//   setAgentKill  a SUPERVISOR of `demo` with a recent sign-in turns `KILL#AGENT` on or off (the global
//                 cut of the agent, no deploy), audited `AGENT_KILL_SET`; the role matrix enforces who
import { z } from "zod";
import { BLOCK_SOURCE_GLOSS, BLOCK_SOURCE_REASON, BlockSource, STAFF_GLOSS, STAFF_TEXT } from "../copy";
import { COLLECTION_LEXICON_VERSION } from "../channel-policy/collection-lexicon";
import { POLICY_VERSION } from "../channel-policy/engine";
import { RULE_SET_VERSION } from "../channel-policy/kinds";
import { worldWhatsAppMode } from "../channels/whatsapp/registry";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import type { WorldSettings } from "../domain/world";
import { type ChannelModes, channelModes, stageAllowsLiveWhatsApp } from "../lib/resource";
import type { ContextDeps } from "./deps";
import { auditConsole } from "./register";
import { accessProcedure } from "./roles";
import { type WorldContext, router } from "./trpc";

export interface PolicyPorts {
  readonly connector: Connector;
  /** `ChannelModes` of the stage (infra/channel-modes.ts). */
  readonly stageModes: () => ChannelModes;
}

declare module "./deps" {
  interface ContextDeps {
    /** `policy.*` (routers/policy.ts); the linked resources when absent. */
    readonly policyPorts?: PolicyPorts;
  }
}

let stagePorts: PolicyPorts | undefined;

function policyPortsOf(deps: ContextDeps): PolicyPorts {
  if (deps.policyPorts) return deps.policyPorts;
  stagePorts ??= { connector: dynamoConnector(), stageModes: channelModes };
  return stagePorts;
}

async function settingsOf(ctx: WorldContext, connector: Connector): Promise<WorldSettings | undefined> {
  return connector.worlds.getSettings(ctx.principal.worldId);
}

/** The parameters of the world the rules read (`SETTINGS`), every one labelled as the world's. */
function parametersOf(settings: WorldSettings | undefined) {
  if (settings === undefined) return null;
  return {
    contactHours: settings.contactHours,
    maxProactivePerDay: settings.maxProactivePerDay,
    rateLimitPerHour: settings.rateLimitPerHour,
    turnCaps: settings.turnCaps,
    imageReadsPerDay: settings.imageReadsPerDay,
    caps: settings.caps,
    channelModes: settings.channelModes,
  };
}

export const SetAgentKillInput = z
  .object({ on: z.boolean(), reason: z.string().trim().min(1).max(200).optional() })
  .strict();

export const policyRouter = router({
  rules: accessProcedure("policy.rules").query(async ({ ctx }) => {
    const { connector } = policyPortsOf(ctx.deps);
    return {
      policyVersion: POLICY_VERSION,
      ruleSetVersion: RULE_SET_VERSION,
      lexiconVersion: COLLECTION_LEXICON_VERSION,
      notLegalAdvice: { es: STAFF_TEXT.NOT_LEGAL_ADVICE, en: STAFF_GLOSS.NOT_LEGAL_ADVICE },
      rules: BlockSource.options.map((ruleId) => ({ ruleId, ...BLOCK_SOURCE_REASON[ruleId], gloss: BLOCK_SOURCE_GLOSS[ruleId] })),
      parameters: parametersOf(await settingsOf(ctx, connector)),
    };
  }),

  modes: accessProcedure("policy.modes").query(async ({ ctx }) => {
    const ports = policyPortsOf(ctx.deps);
    const { worldId } = ctx.principal;
    const [settings, globalKill, worldKill] = await Promise.all([settingsOf(ctx, ports.connector), ports.connector.runtime.getKill(), ports.connector.runtime.getKill(worldId)]);
    const stage = ports.stageModes();
    return {
      email: "live" as const,
      whatsapp: worldWhatsAppMode(worldId, settings, stage),
      whatsappConfigured: settings?.channelModes.whatsapp ?? null,
      stageAllowsLiveWhatsApp: stageAllowsLiveWhatsApp(worldId, stage),
      agentKill: { global: globalKill !== undefined, world: worldKill !== undefined, since: globalKill?.atReal ?? worldKill?.atReal ?? null },
    };
  }),

  setAgentKill: accessProcedure("policy.setAgentKill")
    .input(SetAgentKillInput)
    .mutation(async ({ ctx, input }) => {
      const { connector } = policyPortsOf(ctx.deps);
      const atReal = ctx.deps.wallClock().toISOString();
      const by = `OPERATOR:${ctx.principal.staffId}`;
      await connector.runtime.setKill({ on: input.on, by, atReal, ...(input.reason ? { reason: input.reason } : {}) });
      await auditConsole(ctx, connector, "AGENT_KILL_SET", { scope: "GLOBAL", on: String(input.on) });
      ctx.log.warn("policy.agent_kill_set", { on: input.on });
      return { scope: "GLOBAL" as const, killed: input.on, atReal };
    }),
});
