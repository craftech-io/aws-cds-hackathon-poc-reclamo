import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_TEXT, WHATSAPP_TEXT } from "../packages/bff/src/copy/es-AR";
import { PERSONA_SCRIPTS } from "../packages/bff/src/copy/persona-scripts";
import { TEMPLATE_STATUS_PHRASES } from "../packages/bff/src/copy/template-status";
import { MASK_PATTERNS, maskSensitive } from "../packages/bff/src/lib/mask";
import { detectLanguage } from "../packages/bff/src/services/language";
import {
  BLOCKED_MESSAGES,
  CONTENT_FILTERS,
  G1_POLICIES,
  G1_REGEXES,
  G2_LIMITS,
  G2_POLICIES,
  GROUNDING_FILTERS,
  GUARDRAIL_KINDS,
  GUARDRAIL_TIER,
  INBOUND_TOPICS,
  OUTBOUND_TOPICS,
  PII_ENTITIES,
  bedrockCore,
  bedrockPattern,
  policiesDigest,
  type DeniedTopic,
} from "./guardrail-policies";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

// Bedrock limits of a denied topic (CLASSIC tier) and of a custom regex.
const TOPIC_NAME = /^[0-9a-zA-Z-_ !?.]+$/;
const REGEX_NAME = /^[0-9a-zA-Z-_ !?.]+$/;

const ALL_TOPICS: readonly DeniedTopic[] = [...new Set([...INBOUND_TOPICS, ...OUTBOUND_TOPICS])];
const examplesOf = (topic: DeniedTopic): string[] => [...topic.examples.es, ...topic.examples.en];
const ALL_EXAMPLES = ALL_TOPICS.flatMap(examplesOf);

/** The quoted triggers of a flow's "Disparador" line in docs/flows-catalog.md. */
function flowTriggers(flowId: string): string[] {
  const catalog = read("docs/flows-catalog.md");
  const block = catalog.slice(catalog.indexOf(`### ${flowId} ·`));
  const line = block.split("\n").find((candidate) => candidate.includes("Disparador:")) ?? "";
  return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/** Every quoted text of a "Disparador" line of the catalog. */
function catalogTexts(): string[] {
  return read("docs/flows-catalog.md")
    .split("\n")
    .filter((line) => line.includes("Disparador:"))
    .flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""));
}

// Where the texts that reach the normalizer or the gate live, now or once their work package lands:
// copy/ (fixed texts, persona scripts), channel fixtures, the mocks' data, the seed data, the scenario
// and local-flow texts. A directory that does not exist yet contributes nothing.
const CORPUS_ROOTS = [
  "packages/bff/src/copy",
  "packages/bff/src/channels",
  "packages/core-mock/src",
  "packages/network-mock/src",
  "scripts/seed/data",
  "scripts/scenarios",
  "tests/flows",
];
const CORPUS_FILE = /\.(eml|json|jsonl|txt|ts)$/;

function corpusFiles(path: string, out: string[] = []): string[] {
  let stats;
  try {
    stats = statSync(resolve(ROOT, path));
  } catch {
    return out;
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(resolve(ROOT, path))) if (entry !== "node_modules") corpusFiles(join(path, entry), out);
  } else if (CORPUS_FILE.test(path)) out.push(path);
  return out;
}

const g1Regexes = (): RegExp[] => (G1_POLICIES.sensitiveInformationPolicyConfig?.regexesConfigs ?? []).map((regex) => new RegExp(regex.pattern));
const firesG1Regex = (text: string): boolean => g1Regexes().some((regex) => regex.test(text));
const maskPattern = (kind: string): RegExp => {
  const pattern = MASK_PATTERNS.find(([label]) => label === kind)?.[1];
  if (!pattern) throw new Error(`no ${kind}`);
  return new RegExp(pattern.source, "u");
};

/** Content words (four letters or more, no accents) for a lexical-overlap check. */
function contentWords(text: string): Set<string> {
  const plain = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return new Set(plain.split(/[^a-z]+/).filter((word) => word.length >= 4));
}

function overlap(a: string, b: string): number {
  const left = contentWords(a);
  const right = contentWords(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

/** True when `text` is, or reads almost like, an example the topic classifier was taught to deny. */
const resemblesDeniedExample = (text: string): string | undefined => ALL_EXAMPLES.find((example) => overlap(text, example) >= 0.5);

const COLLECTION_CORPUS = "scripts/seed/data/evals/collection-corpus.json";

/** Service-labelled phrases of the single collection corpus (WP-14), whatever its exact shape. */
function corpusServicePhrases(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const text = record.text ?? record.phrase;
      const label = record.label ?? record.category ?? record.kind ?? record.expected;
      if (typeof text === "string" && typeof label === "string" && /^(service|servicio)$/i.test(label)) out.push(text);
      else Object.values(record).forEach(walk);
    }
  };
  walk(JSON.parse(read(COLLECTION_CORPUS)));
  return out;
}

/** What the customer and the agent say in service, none of which may look like a denied topic. */
function servicePhrases(): { source: string; text: string }[] {
  const fixed = [...Object.entries(WHATSAPP_TEXT), ...Object.entries(EMAIL_TEXT), ...Object.entries(TEMPLATE_STATUS_PHRASES)].map(([key, text]) => ({ source: `copy ${key}`, text }));
  const customers = PERSONA_SCRIPTS.flatMap((persona) =>
    persona.messages.filter((message) => message.intake.kind !== "OUT_OF_SCOPE").flatMap((message) => [
      { source: `${persona.id} es`, text: message.text },
      { source: `${persona.id} en`, text: message.en },
    ]),
  );
  const corpus = existsSync(resolve(ROOT, COLLECTION_CORPUS)) ? corpusServicePhrases().map((text) => ({ source: COLLECTION_CORPUS, text })) : [];
  return [...fixed, ...customers, ...corpus];
}

describe("[FL-056] [FL-057] denied topics: inbound on G1, outbound on G2", () => {
  it("declares the topics of docs/design-brief.md §8.5 within the Bedrock limits", () => {
    expect(INBOUND_TOPICS.map((topic) => topic.name)).toEqual(["CreditOffers", "LegalAdvice", "InvestmentAdvice"]);
    expect(OUTBOUND_TOPICS.map((topic) => topic.name)).toEqual(["DebtCollection", "CreditOffers", "LegalAdvice", "InvestmentAdvice", "CredentialRequest"]);
    for (const topic of ALL_TOPICS) {
      expect(topic.name).toMatch(TOPIC_NAME);
      expect(topic.name.length).toBeLessThanOrEqual(100);
      expect(topic.definition.length, topic.name).toBeLessThanOrEqual(200);
      const examples = examplesOf(topic);
      expect(examples.length, topic.name).toBeLessThanOrEqual(5);
      for (const example of examples) expect(example.length, example).toBeLessThanOrEqual(100);
    }
  });

  it("writes every definition and example in Spanish and English", () => {
    for (const topic of ALL_TOPICS) {
      const gloss = /^(.+) \((.+)\)\.$/.exec(topic.definition);
      expect(gloss, `${topic.name}: "<es> (<en>)."`).not.toBeNull();
      expect(detectLanguage(gloss?.[1] ?? ""), topic.name).toBe("SPANISH");
      expect(detectLanguage(gloss?.[2] ?? ""), topic.name).toBe("NOT_SPANISH");
      expect(topic.examples.es.length, topic.name).toBeGreaterThanOrEqual(2);
      expect(topic.examples.en.length, topic.name).toBeGreaterThanOrEqual(2);
      for (const example of topic.examples.es) expect(detectLanguage(example), example).not.toBe("NOT_SPANISH");
      for (const example of topic.examples.en) expect(detectLanguage(example), example).not.toBe("SPANISH");
    }
  });

  it("teaches the credit, legal and investment triggers of FL-056 and FL-057 to their own topic", () => {
    const owner = (trigger: string): string[] =>
      INBOUND_TOPICS.filter((topic) => topic.examples.es.some((example) => example.toLowerCase() === trigger.toLowerCase())).map((topic) => topic.name);
    const [credit, refinance] = flowTriggers("FL-056");
    const [lawsuit, invest] = flowTriggers("FL-057");
    expect(owner(credit ?? "")).toEqual(["CreditOffers"]);
    expect(owner(refinance ?? "")).toEqual(["CreditOffers"]);
    expect(owner(lawsuit ?? "")).toEqual(["LegalAdvice"]);
    expect(owner(invest ?? "")).toEqual(["InvestmentAdvice"]);
  });

  it("teaches every out-of-scope persona message except general chat to a G1 topic, in both languages", () => {
    const outOfScope = PERSONA_SCRIPTS.flatMap((persona) => persona.messages).filter((message) => message.intake.kind === "OUT_OF_SCOPE");
    const taught = outOfScope.filter((message) => INBOUND_TOPICS.some((topic) => topic.examples.es.includes(message.text)));
    expect(taught.length).toBe(outOfScope.length - 1);
    for (const message of taught) expect(INBOUND_TOPICS.some((topic) => topic.examples.en.includes(message.en)), message.en).toBe(true);
  });

  it("teaches G2 the outbound collection and credit-offer attempts of the catalog", () => {
    const outbound = (name: string): readonly string[] => OUTBOUND_TOPICS.find((topic) => topic.name === name)?.examples.es ?? [];
    const texts = catalogTexts();
    expect(texts).toContain("Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos");
    expect(outbound("DebtCollection")).toContain("Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos");
    expect(texts).toContain("¿Querés un préstamo nuevo con tasa preferencial?");
    expect(outbound("CreditOffers")).toContain("¿Querés un préstamo nuevo con tasa preferencial?");
  });

  it("shares the inbound topics with G2 unchanged and sends every topic as DENY on the CLASSIC tier", () => {
    for (const topic of INBOUND_TOPICS) expect(OUTBOUND_TOPICS).toContain(topic);
    for (const [policies, topics] of [
      [G1_POLICIES, INBOUND_TOPICS],
      [G2_POLICIES, OUTBOUND_TOPICS],
    ] as const) {
      expect(GUARDRAIL_TIER).toBe("CLASSIC");
      expect(policies.topicPolicyConfig?.tierConfigs).toEqual([{ tierName: "CLASSIC" }]);
      expect(policies.topicPolicyConfig?.topicsConfigs).toEqual(topics.map((topic) => ({ name: topic.name, definition: topic.definition, examples: examplesOf(topic), type: "DENY" })));
    }
  });

  it("lets no fixed text, persona complaint or service phrase of the corpus look like a denied example", () => {
    const phrases = servicePhrases();
    expect(phrases.length).toBeGreaterThan(50);
    const offenders = phrases.filter(({ text }) => resemblesDeniedExample(text) !== undefined).map(({ source, text }) => `${source}: "${text}" ~ "${resemblesDeniedExample(text)}"`);
    expect(offenders).toEqual([]);
  });
});

describe("[FL-058] [FL-059] G1 blocks only what the worker can classify (docs/architecture.md §9.1)", () => {
  it("sets prompt attack to HIGH on input and has no other content filter", () => {
    expect(CONTENT_FILTERS).toEqual([{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" }]);
    expect(G1_POLICIES.contentPolicyConfig).toEqual({
      tierConfigs: [{ tierName: "CLASSIC" }],
      filtersConfigs: [{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE", inputModalities: ["TEXT"], outputModalities: ["TEXT"] }],
    });
  });

  it("can only block on a denied topic, a prompt attack or a card number", () => {
    const sensitive = G1_POLICIES.sensitiveInformationPolicyConfig;
    const blocking = [
      ...(G1_POLICIES.topicPolicyConfig?.topicsConfigs ?? []).map(() => "TOPIC"),
      ...(G1_POLICIES.contentPolicyConfig?.filtersConfigs ?? []).filter((filter) => filter.inputStrength !== "NONE" || filter.outputStrength !== "NONE").map((filter) => filter.type),
      ...(sensitive?.piiEntitiesConfigs ?? []).filter((entity) => [entity.action, entity.inputAction, entity.outputAction].includes("BLOCK")).map((entity) => entity.type),
      ...(sensitive?.regexesConfigs ?? []).filter((regex) => [regex.action, regex.inputAction, regex.outputAction].includes("BLOCK")).map((regex) => regex.name),
    ];
    expect([...new Set(blocking)].sort()).toEqual(["CREDIT_DEBIT_CARD_NUMBER", "PROMPT_ATTACK", "TOPIC"]);
    expect(Object.keys(G1_POLICIES).sort()).toEqual(["contentPolicyConfig", "sensitiveInformationPolicyConfig", "topicPolicyConfig"]);
  });

  it("blocks card numbers and leaves contacts (emails, phones) alone", () => {
    expect(PII_ENTITIES).toEqual([
      { type: "CREDIT_DEBIT_CARD_NUMBER", inputAction: "BLOCK", outputAction: "BLOCK" },
      { type: "EMAIL", inputAction: "NONE", outputAction: "NONE" },
      { type: "PHONE", inputAction: "NONE", outputAction: "NONE" },
    ]);
    for (const entity of G1_POLICIES.sensitiveInformationPolicyConfig?.piiEntitiesConfigs ?? []) expect(entity.action).toBe(entity.inputAction);
  });
});

describe("[FL-059] document numbers: G1 anonymizes with mask.ts's regexes and never blocks on them", () => {
  it("anonymizes CUIT/CUIL, DNI and CBU/CVU on input only", () => {
    expect(GUARDRAIL_KINDS).toEqual(["CUIT", "DNI", "CBU"]);
    expect(G1_REGEXES.map((regex) => regex.kind)).toEqual([...GUARDRAIL_KINDS]);
    expect(G1_POLICIES.sensitiveInformationPolicyConfig?.regexesConfigs).toEqual(
      G1_REGEXES.map((regex) => ({
        name: regex.name,
        description: regex.description,
        pattern: regex.pattern,
        action: "ANONYMIZE",
        inputAction: "ANONYMIZE",
        inputEnabled: true,
        outputAction: "NONE",
        outputEnabled: false,
      })),
    );
  });

  it("derives each pattern from mask.ts and keeps no document regex of its own in infra/", () => {
    for (const kind of GUARDRAIL_KINDS) {
      const core = maskPattern(kind).source.replaceAll("\\d", "[0-9]");
      expect(core.includes(bedrockCore(kind))).toBe(true);
      expect(bedrockPattern(kind)).toContain(bedrockCore(kind));
    }
    expect(read("infra/guardrail-policies.ts")).toContain('import { MASK_PATTERNS, type MaskLabel } from "../packages/bff/src/lib/mask";');
    for (const file of ["infra/guardrail-policies.ts", "infra/guardrail.ts"]) {
      for (const token of ["{7,8}", "{22}", "{9}", "{8}", "{1,2}"]) expect(read(file).includes(token), `${file} contains ${token}`).toBe(false);
    }
  });

  it("fits Bedrock's custom regex rules: named, short, no lookaround, no \\d, no Unicode classes", () => {
    for (const regex of G1_REGEXES) {
      expect(regex.name).toMatch(REGEX_NAME);
      expect(regex.name.length).toBeLessThanOrEqual(100);
      expect(regex.description.length).toBeLessThanOrEqual(1000);
      expect(regex.pattern.length).toBeLessThanOrEqual(500);
      for (const unsupported of ["(?=", "(?!", "(?<=", "(?<!", "\\d", "\\p{"]) expect(regex.pattern.includes(unsupported), `${regex.name}: ${unsupported}`).toBe(false);
    }
  });

  it("fires on the same lines as mask.ts, with the boundaries that keep operation codes and amounts intact", () => {
    const samples = ["CUIT 20-30123456-7", "cuil 20301234567", "mi dni es 30.123.456", "dni 30123456 gracias", "CVU 0000003100000000000001", "operación NTE-20261022-004411", "reclamo R-2026-000123", "pagué $ 118.640,00 el 22/10", "el reintegro de $ 1.500.000 no llegó", "me cobraron 1.180.640,00", "$1.180.640", "cbu 0110 - 5995 - 2000 - 0012 - 3456 - 78", "dni 30  123  456", "CUIT 20 - 30123456 - 7", "cuit 20  30.123.456  7"];
    const lines = [...samples, ...CORPUS_ROOTS.flatMap((root) => corpusFiles(root)).flatMap((file) => read(file).split("\n"))];
    const pairs = GUARDRAIL_KINDS.map((kind) => ({ kind, bedrock: new RegExp(bedrockPattern(kind)), mask: maskPattern(kind) }));
    const mismatches = lines.flatMap((line) => pairs.filter(({ bedrock, mask }) => bedrock.test(line) !== mask.test(line)).map(({ kind }) => `${kind}: ${line.trim().slice(0, 120)}`));
    expect(mismatches).toEqual([]);
    expect(firesG1Regex("operación NTE-20261022-004411")).toBe(false);
    expect(firesG1Regex("mi dni es 30.123.456")).toBe(true);
  });

  it("fails closed when mask.ts changes a boundary it does not know", () => {
    expect(() => bedrockPattern("CUIT")).not.toThrow();
    expect(() => bedrockPattern("EMAIL" as never)).toThrow(/boundaries of EMAIL/);
  });

  it("lets no normalized fixture, copy text or catalog text trigger a G1 regex", () => {
    const files = CORPUS_ROOTS.flatMap((root) => corpusFiles(root));
    expect(files.length).toBeGreaterThan(0);
    const texts = [...catalogTexts().map((text) => ({ source: `docs/flows-catalog.md "${text}"`, text })), ...files.map((file) => ({ source: file, text: read(file) }))];
    expect(texts.filter(({ text }) => firesG1Regex(maskSensitive(text))).map(({ source }) => source)).toEqual([]);
  });

  it("has the normalizer mask every document number G1 would anonymize, first", () => {
    for (const text of ["CUIT 20-30123456-7", "cuil 20301234567", "mi dni es 30.123.456", "CVU 0000003100000000000001", "cbu 0110 - 5995 - 2000 - 0012 - 3456 - 78", "dni 30  123  456", "CUIT 20 - 30123456 - 7"]) {
      expect(firesG1Regex(text), text).toBe(true);
      expect(firesG1Regex(maskSensitive(text)), text).toBe(false);
    }
  });

  it("lets no service phrase trigger a G1 regex once normalized", () => {
    expect(servicePhrases().filter(({ text }) => firesG1Regex(maskSensitive(text))).map(({ source }) => source)).toEqual([]);
  });
});

describe("[FL-001] grounding and relevance (G2, ADR-0008 and ADR-0021 §10)", () => {
  /** The fixed status question of ADR-0021 §10, the relevance query the gate uses for small talk. */
  const statusQuestion = /pregunta fija de estado "([^"]+)"/.exec(read("docs/adr/0021-alta-abierta-responsable-whatsapp-y-lecciones.md"))?.[1] ?? "";

  it("keeps grounding at the provisional 0.75 and relevance at 0.5, nothing that rewrites the outbound text", () => {
    expect(GROUNDING_FILTERS).toEqual([
      { type: "GROUNDING", threshold: 0.75 },
      { type: "RELEVANCE", threshold: 0.5 },
    ]);
    expect(G2_POLICIES.contextualGroundingPolicyConfig?.filtersConfigs).toEqual([...GROUNDING_FILTERS]);
    expect(Object.keys(G2_POLICIES).sort()).toEqual(["contextualGroundingPolicyConfig", "topicPolicyConfig"]);
  });

  it("hands the gate the thresholds and the input limits of docs/architecture.md §9.4 through the G2 Linkable", () => {
    expect(G2_LIMITS).toEqual({ queryMaxChars: 1_000, groundingSourceMaxChars: 100_000, contentMaxChars: 5_000 });
    const source = read("infra/guardrail.ts");
    for (const property of ['groundingThreshold: threshold("GROUNDING")', 'relevanceThreshold: threshold("RELEVANCE")', "queryMaxChars: G2_LIMITS.queryMaxChars"]) expect(source).toContain(property);
  });

  it("uses a fixed status question that matches no denied-topic example and fits the query limit", () => {
    expect(statusQuestion).toBe("¿Cómo están mi cuenta y mi reclamo?");
    expect(statusQuestion.length).toBeLessThanOrEqual(G2_LIMITS.queryMaxChars);
    for (const example of ALL_EXAMPLES) {
      expect(example.toLowerCase(), example).not.toBe(statusQuestion.toLowerCase());
      expect(overlap(statusQuestion, example), example).toBeLessThan(0.5);
    }
    expect(firesG1Regex(statusQuestion)).toBe(false);
  });

  it("is the very question the gate builds, once outbound/g2-query.ts exists", () => {
    const query = "packages/bff/src/outbound/g2-query.ts";
    if (existsSync(resolve(ROOT, query))) expect(read(query)).toContain(statusQuestion);
  });
});

describe("versions and blocked messages", () => {
  it("publishes a new version whenever a policy changes", () => {
    expect(policiesDigest(G1_POLICIES)).toMatch(/^[0-9a-f]{16}$/);
    expect(policiesDigest(G1_POLICIES)).toBe(policiesDigest(structuredClone(G1_POLICIES)));
    expect(policiesDigest(G1_POLICIES)).not.toBe(policiesDigest(G2_POLICIES));
    const changed = { ...G2_POLICIES, contextualGroundingPolicyConfig: { filtersConfigs: [{ type: "GROUNDING", threshold: 0.8 }] } };
    expect(policiesDigest(changed)).not.toBe(policiesDigest(G2_POLICIES));
  });

  it("uses distinct sentinel tokens that are no sentence in either language", () => {
    const messages = Object.values(BLOCKED_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message).toMatch(/^[A-Z0-9_]{1,500}$/);
      expect(detectLanguage(message)).toBe("UNDETERMINED");
    }
  });
});
