// Bedrock Guardrails G1 and G2, each with a published numbered version (docs/design-brief.md §8.5,
// docs/architecture.md §9.1 and §9.4, docs/build-plan.md WP-22). The policies are plain data in
// infra/guardrail-policies.ts; this module only turns them into resources and Linkables.
//
// Why two. The Harness applies one guardrail to every model call and has no place for a grounding
// source, and a grounding check without a source is undefined. So G1 carries what needs no source
// (inbound denied topics, prompt attack, PII) and serves both the worker's pre-filter and the Harness,
// while G2 carries the outbound denied topics plus grounding and relevance for the outbound gate,
// which passes the turn's results (`Runtime/W#<w>#TURN#`) and the cited clauses as source.
//
// Versions. Bedrock evaluates the DRAFT unless a numbered version is named. `GuardrailVersion` has no
// updatable field, so its description carries a digest of the policies: any change replaces the
// version and every Linkable points to the new number on the same deploy.
//
// Who uses what (least privilege, docs/architecture.md §14): the Linkable `GuardrailG1` grants
// `bedrock:ApplyGuardrail` on G1 only (InboundWhatsApp and the event workers' pre-filter, QaDriver
// `guardrail.probe`); `GuardrailG2` on G2 only (everything that runs the outbound gate, QaDriver
// `gate.probe`). The Harness execution role gets G1 from infra/agentcore-iam.ts and the model call
// gets `harnessGuardrailConfig` (WP-31). The console Bff links neither.
//
// Cost: per text unit evaluated; nothing bills while no text is evaluated.
//
// Verify (after a deploy; ids and versions from the stack outputs or `bedrock list-guardrails`):
//   aws --profile craftech-demos bedrock get-guardrail --guardrail-identifier <g1Id> --guardrail-version <g1Version>
//     topicPolicy.topics = CreditOffers, LegalAdvice, InvestmentAdvice · contentPolicy.filters = PROMPT_ATTACK HIGH/NONE ·
//     sensitiveInformationPolicy: CREDIT_DEBIT_CARD_NUMBER BLOCK, EMAIL/PHONE NONE, regexes AR_* ANONYMIZE
//   aws --profile craftech-demos bedrock get-guardrail --guardrail-identifier <g2Id> --guardrail-version <g2Version>
//     topicPolicy.topics = DebtCollection, CreditOffers, LegalAdvice, InvestmentAdvice, CredentialRequest ·
//     contextualGroundingPolicy.filters = GROUNDING 0.75, RELEVANCE 0.5
//   aws --profile craftech-demos bedrock-runtime apply-guardrail --guardrail-identifier <g1Id> --guardrail-version <g1Version> \
//     --source INPUT --content '[{"text":{"text":"¿Les puedo hacer juicio?"}}]'
//     → action GUARDRAIL_INTERVENED, topic LegalAdvice BLOCKED
//   … the same with '[{"text":{"text":"Te paso el CUIT 20-30123456-7"}}]' → only ANONYMIZED (never a block)

import { BLOCKED_MESSAGES, G1_POLICIES, G2_LIMITS, G2_POLICIES, GROUNDING_FILTERS, policiesDigest } from "./guardrail-policies";

/** `<app>-<stage>-g1`: `[0-9a-zA-Z-_]+`, at most 50 characters. */
function guardrailName(suffix: "g1" | "g2"): string {
  return `${$app.name}-${$app.stage}-${suffix}`.slice(0, 50);
}

export const g1 = new aws.bedrock.Guardrail("GuardrailG1", {
  name: guardrailName("g1"),
  description: "G1: worker pre-filter and Harness model calls. Inbound denied topics, prompt attack, cards blocked, document numbers anonymized.",
  blockedInputMessaging: BLOCKED_MESSAGES.g1Input,
  blockedOutputsMessaging: BLOCKED_MESSAGES.g1Output,
  ...G1_POLICIES,
});

export const g1Version = new aws.bedrock.GuardrailVersion(
  "GuardrailG1Version",
  { guardrailArn: g1.guardrailArn, description: `G1 policies ${policiesDigest(G1_POLICIES)}` },
  { dependsOn: [g1] },
);

export const g2 = new aws.bedrock.Guardrail("GuardrailG2", {
  name: guardrailName("g2"),
  description: "G2: outbound gate with the turn results and cited clauses as source. Outbound denied topics, grounding, relevance.",
  blockedInputMessaging: BLOCKED_MESSAGES.g2Input,
  blockedOutputsMessaging: BLOCKED_MESSAGES.g2Output,
  ...G2_POLICIES,
});

export const g2Version = new aws.bedrock.GuardrailVersion(
  "GuardrailG2Version",
  { guardrailArn: g2.guardrailArn, description: `G2 policies ${policiesDigest(G2_POLICIES)}` },
  { dependsOn: [g2] },
);

/**
 * The Harness side (infra/agentcore.ts, WP-31): the Converse `guardrailConfig` travels in
 * `model.bedrockModelConfig.additionalParams`, the only place the pinned aws-native schema passes
 * provider parameters through. The trace lets the worker read which policy intervened.
 */
export const harnessGuardrailConfig = {
  guardrailConfig: {
    guardrailIdentifier: g1.guardrailId,
    guardrailVersion: g1Version.version,
    trace: "enabled",
  },
};

/** G1 for `ApplyGuardrail` with source INPUT: `readLinked("GuardrailG1", …)` → id, version, sentinels. */
export const GuardrailG1 = new sst.Linkable("GuardrailG1", {
  properties: {
    arn: g1.guardrailArn,
    id: g1.guardrailId,
    version: g1Version.version,
    blockedInputMessage: BLOCKED_MESSAGES.g1Input,
    blockedOutputMessage: BLOCKED_MESSAGES.g1Output,
  },
  include: [sst.aws.permission({ actions: ["bedrock:ApplyGuardrail"], resources: [g1.guardrailArn] })],
});

const threshold = (type: "GROUNDING" | "RELEVANCE"): number => {
  const filter = GROUNDING_FILTERS.find((candidate) => candidate.type === type);
  if (filter === undefined) throw new Error(`infra/guardrail-policies.ts has no ${type} filter for G2.`);
  return filter.threshold;
};

/** G2 for `ApplyGuardrail` with source OUTPUT, with the thresholds and the input limits the gate respects. */
export const GuardrailG2 = new sst.Linkable("GuardrailG2", {
  properties: {
    arn: g2.guardrailArn,
    id: g2.guardrailId,
    version: g2Version.version,
    groundingThreshold: threshold("GROUNDING"),
    relevanceThreshold: threshold("RELEVANCE"),
    queryMaxChars: G2_LIMITS.queryMaxChars,
    groundingSourceMaxChars: G2_LIMITS.groundingSourceMaxChars,
    contentMaxChars: G2_LIMITS.contentMaxChars,
    blockedInputMessage: BLOCKED_MESSAGES.g2Input,
    blockedOutputMessage: BLOCKED_MESSAGES.g2Output,
  },
  include: [sst.aws.permission({ actions: ["bedrock:ApplyGuardrail"], resources: [g2.guardrailArn] })],
});
