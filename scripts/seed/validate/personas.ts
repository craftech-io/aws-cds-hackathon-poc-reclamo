// Invariant 14 and the artifact checks of docs/seed-spec.md §8, §9, §12, §13: every persona has a
// scenario, a script and the receipts its script attaches; the amounts the flows quote are the
// generated ones; every complaint script names a type for the classifier's rules; the receipts are
// 900 × 1400, at most 1 MB, carry `ReceiptCode` exactly when they are readable and are counted per
// variant; the evals and load inputs have their sizes; NameCheck lists exactly the names in use.
import { PERSONA_SCRIPTS } from "@reclamo/bff/copy/persona-scripts";
import { readPng } from "../lib/png";
import { type Json, type SeedOnDisk, entities } from "./read";

type Report = (invariant: number, message: string) => void;

/** Amounts docs/flows-catalog.md quotes for these personas (FL-010, FL-024, FL-034, FL-036, FL-038, FL-064). */
export const FLOW_QUOTES: Readonly<Record<string, Record<string, string>>> = {
  C01: { principal: "$ 960.000,00", instalment: "$ 118.640,00" },
  C03: { duplicateDebit: "$ 146.300,00" },
  C09: { overdueInstalment: "$ 64.210,00", dueDate: "2026-09-25" },
  C13: { payment: "$ 312.400,00" },
  C23: { charge: "$ 38.900,00" },
  C24: { charge: "$ 212.000,00" },
};

const READABLE = new Set(["legible", "fake-check", "fake-unknown", "injection", "other-payer", "tampered-chunk"]);

/** Persona files plus the eval set (docs/seed-spec.md §9). */
export const RECEIPT_COUNTS: Readonly<Record<string, number>> = {
  legible: 8 + 20,
  blurry: 2 + 15,
  "fake-check": 1 + 10,
  "fake-unknown": 1 + 5,
  injection: 1 + 5,
  "not-receipt": 1 + 5,
  "other-payer": 1,
  "tampered-chunk": 3,
};

function checkPersonas(seed: SeedOnDisk, report: Report): void {
  const guest = seed.templates.guest;
  if (PERSONA_SCRIPTS.length !== 41 || guest.personas.length !== 41) report(14, `there must be 41 personas (scripts ${PERSONA_SCRIPTS.length}, template ${guest.personas.length})`);
  for (const script of PERSONA_SCRIPTS) {
    const persona = guest.personas.find((candidate) => candidate.id === script.id);
    if (!persona || persona.scenario === "" || persona.flows.length === 0) report(14, `${script.id} lacks its scenario or flows in the template`);
    if (!guest.items.some((item) => item.entity === "Customer" && (item.data as Json).customerId === persona?.customerId)) report(14, `${script.id} has no customer in the core`);
    for (const message of script.messages) {
      if (message.intake.kind === "RECLAMO" && !message.intake.type) report(14, `${script.id}: a complaint script without its type`);
      const attachment = message.attachment;
      if (attachment?.kind !== "RECEIPT_IMAGE") continue;
      if (!guest.receipts.some((receipt) => receipt.personaId === script.id && receipt.variant === attachment.variant && receipt.seq === attachment.seq)) report(14, `${script.id}: no ${attachment.variant} receipt #${attachment.seq} for its script`);
    }
  }
  const quoted = ((seed.manifest.facts as Json | undefined)?.quoted ?? {}) as Record<string, Record<string, string>>;
  for (const [persona, amounts] of Object.entries(FLOW_QUOTES)) {
    for (const [field, value] of Object.entries(amounts)) if (quoted[persona]?.[field] !== value) report(14, `${persona}.${field} is ${String(quoted[persona]?.[field])} in the manifest, the flows quote ${value}`);
  }
}

function checkReceipts(seed: SeedOnDisk, report: Report): void {
  const counts: Record<string, number> = {};
  const hashes = (seed.manifest.seedReceiptHashes ?? {}) as Record<string, string>;
  for (const [path, bytes] of seed.files) {
    if (!path.startsWith("media/receipts/")) continue;
    const variant = path.split("/")[2] ?? "";
    counts[variant] = (counts[variant] ?? 0) + 1;
    const info = readPng(new Uint8Array(bytes));
    if (bytes.length > 1_048_576) report(16, `${path} is larger than 1 MB`);
    if (info.width !== 900 || info.height !== 1400 || !info.crcOk) report(16, `${path} is not a valid 900 × 1400 PNG`);
    const chunks = info.texts.map(([key]) => key);
    const readable = READABLE.has(variant);
    if (readable && (chunks.length !== 1 || chunks[0] !== "ReceiptCode")) report(16, `${path} must carry exactly the ReceiptCode chunk`);
    if (!readable && chunks.length > 0) report(16, `${path} must carry no text chunk`);
    if (!hashes[path.slice("media/".length)]) report(16, `${path} has no SeedReceiptHash in the manifest`);
  }
  for (const [variant, count] of Object.entries(RECEIPT_COUNTS)) if (counts[variant] !== count) report(14, `${count} ${variant} receipts expected, ${counts[variant] ?? 0} found`);
  const images = (seed.evals.receipts.images ?? []) as Json[];
  const sr = (seed.evals.receipts.srSubset ?? []) as Json[];
  if (images.length !== 64) report(14, `the receipt eval has ${images.length} images, not 64`);
  const srPersonas = sr.map((entry) => String(entry.persona)).sort().join();
  if (srPersonas !== "C01,C04,C11,C12,C13,C14,C15,C16,C16,C17,C19,C41") report(14, `the SR subset is ${srPersonas}`);
}

function checkEvalsAndLoad(seed: SeedOnDisk, report: Report): void {
  const size = (value: Json, key: string): number => ((value[key] ?? []) as unknown[]).length;
  if (size(seed.evals.grounding, "entries") !== 40) report(14, "the grounding eval must have 40 questions");
  if (size(seed.evals.classifier, "entries") !== 120) report(14, "the classifier eval must have 120 messages");
  const corpus = (seed.evals.collectionCorpus.entries ?? []) as Json[];
  const collection = corpus.filter((entry) => entry.label === "COLLECTION" && !String(entry.id).startsWith("col-adv-")).length;
  const adversarial = corpus.filter((entry) => entry.label === "COLLECTION" && String(entry.id).startsWith("col-adv-")).length;
  const service = corpus.length - collection - adversarial;
  if (collection !== 80 || service !== 80 || adversarial < 10) report(11, `the collection corpus must have 80 + 80 sentences and the adversarial ones (has ${collection} + ${service} + ${adversarial})`);
  if (seed.load.simulated.length !== 300) report(14, "simulated-complaints.jsonl must have 300 presentations");
  if (seed.load.batch.length !== 30) report(14, "batch-inputs.jsonl must have 30 presentations");
  for (const entry of [...seed.load.simulated, ...seed.load.batch]) {
    for (const forbidden of ["result", "expected", "outcome"]) if (forbidden in entry) report(14, `${String(entry.id)}: load inputs never carry results (${forbidden})`);
  }
  const clauseIds = new Set((((seed.reference.terms as Json | undefined)?.clauses ?? []) as Json[]).map((clause) => String(clause.id)));
  if (clauseIds.size !== 45) report(14, `the product terms have ${clauseIds.size} clauses, not 45`);
  for (const entry of (seed.evals.grounding.entries ?? []) as Json[]) {
    for (const id of (entry.expectedClauseIds ?? []) as string[]) if (!clauseIds.has(id)) report(14, `${String(entry.id)} expects an unknown clause ${id}`);
  }
}

function checkNameCheck(seed: SeedOnDisk, report: Report): void {
  const checked = ((seed.reference.nameCheck ?? []) as Json[]).filter((entry) => entry.kind === "PERSON").map((entry) => String(entry.name));
  const used = [...new Set(entities(seed.templates.demo, "Customer").map((customer) => `${String(customer.firstName)} ${String(customer.lastName)}`))].sort();
  if (checked.join("|") !== used.join("|")) report(16, "NameCheck must list exactly the person names in use");
}

export function checkPersonasAndArtifacts(seed: SeedOnDisk, report: Report): void {
  checkPersonas(seed, report);
  checkReceipts(seed, report);
  checkEvalsAndLoad(seed, report);
  checkNameCheck(seed, report);
}
