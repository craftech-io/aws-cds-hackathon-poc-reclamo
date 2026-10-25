// Builds the whole seed in memory (docs/seed-spec.md): the lender's books with the 41 personas and
// the other payers, the settlement batches, the historical register of each template, the
// conversations and tape, the receipts, the evals and the load inputs. Deterministic: every random
// draw comes from a named stream of generate/rng.ts.
import { QA_MIN_PERSONAS } from "../lib/constants";
import type { ModelsTemplateFile, WorldTemplateFile } from "../lib/template";
import { localInstant } from "./calendar";
import { type ConversationBundle, buildConversations } from "./conversations";
import { classifierEval } from "./evals-classifier";
import { collectionCorpus } from "./evals-corpus";
import { groundingEval } from "./evals-grounding";
import { type HistoryBundle, buildHistory } from "./history";
import { type MoneyHistory, buildMoneyHistory } from "./history-money";
import { type OpenComplaint, planHistory } from "./history-plan";
import { type Ledger, newLedger } from "./ledger";
import { type LoadInput, batchInputs, simulatedComplaints } from "./load-inputs";
import { buildPayers } from "./payers";
import { PERSONA_SPECS } from "./persona-specs";
import { buildPersonas } from "./personas";
import { type ReceiptFile, buildReceipts } from "./receipt-catalog";
import { reference } from "./reference";
import { rngFor } from "./rng";
import { type Batch, assembleBatches, batchesFor } from "./settlements";
import { type TemplateParts, buildModels, buildTemplate, personaCustomerId } from "./worlds";

export interface SeedBundle {
  readonly reference: Record<string, unknown>;
  readonly templates: Readonly<Record<"demo" | "guest" | "qa-min", WorldTemplateFile>>;
  readonly models: ModelsTemplateFile;
  readonly batches: Readonly<Record<"demo" | "guest" | "qa-min" | "models", readonly Batch[]>>;
  readonly receipts: readonly ReceiptFile[];
  readonly evals: { readonly grounding: unknown; readonly receipts: unknown; readonly classifier: unknown; readonly collectionCorpus: unknown };
  readonly load: { readonly simulated: readonly LoadInput[]; readonly batch: readonly LoadInput[] };
  /** The full ledger (personas and payers) of `demo`/`guest`/`models`, and the one of `qa-min`. */
  readonly ledger: Ledger;
  readonly qaLedger: Ledger;
}

/** The three presentations still with a person at the start (docs/seed-spec.md §4). */
export const OPEN_COMPLAINTS: readonly OpenComplaint[] = [
  { customerId: "cus-0017", type: "PAYMENT_NOT_REFLECTED", filedAt: localInstant("2026-10-06", "15:20"), handoff: "RECEIPT_DOUBT" },
  { customerId: "cus-1003", type: "UNRECOGNIZED_CHARGE", filedAt: localInstant("2026-10-07", "08:40"), handoff: "CUSTOMER_ASKED" },
  { customerId: "cus-1008", type: "DATA_CHANGE", filedAt: localInstant("2026-10-07", "09:30"), handoff: "RISKY_DATA_CHANGE" },
];

/** Personas that also have a closed complaint in the history (none of the guided tour). */
const PERSONAS_WITH_HISTORY = ["cus-0005", "cus-0008", "cus-0022", "cus-0036", "cus-0039"];

function books(): { ledger: Ledger; sources: ReturnType<typeof buildPersonas>; batches: Batch[] } {
  const ledger = newLedger();
  const sources = buildPersonas(ledger);
  buildPayers(ledger);
  const personas = new Set(PERSONA_SPECS.map((spec) => personaCustomerId(spec.id)));
  return { ledger, sources, batches: assembleBatches(ledger, personas) };
}

function restrict(ledger: Ledger, customers: ReadonlySet<string>): Ledger {
  const mine = <T extends { customerId: string }>(rows: readonly T[]): T[] => rows.filter((row) => customers.has(row.customerId));
  return {
    customers: mine(ledger.customers),
    loans: mine(ledger.loans),
    payments: mine(ledger.payments),
    debits: mine(ledger.debits),
    movements: mine(ledger.movements),
    charges: mine(ledger.charges),
    transfers: mine(ledger.transfers),
    codeSeq: ledger.codeSeq,
  };
}

interface History {
  readonly history: HistoryBundle;
  readonly money: MoneyHistory;
  readonly conversations: ConversationBundle;
}

function history(ledger: Ledger, name: string, total: number, open: readonly OpenComplaint[], answered: number, personaIds: readonly string[]): History {
  const payers = ledger.customers.filter((customer) => !customer.persona).map((customer) => customer.customerId);
  const personaPool = PERSONAS_WITH_HISTORY.filter((id) => ledger.customers.some((customer) => customer.customerId === id));
  const plans = planHistory({ total, open, answered, customers: [...payers, ...personaPool], rng: rngFor(`history:${name}`) });
  const documents = new Map(ledger.customers.map((customer) => [customer.customerId, customer.document]));
  const built = buildHistory(plans, documents);
  const money = buildMoneyHistory(built.complaints, ledger, rngFor(`money:${name}`));
  const openByCustomer = new Map<string, string[]>();
  for (const complaint of built.complaints.filter((candidate) => candidate.plan.state === "HUMAN_REVIEW")) {
    openByCustomer.set(complaint.plan.customerId, [...(openByCustomer.get(complaint.plan.customerId) ?? []), complaint.complaintId]);
  }
  const conversations = buildConversations(personaIds.map(personaCustomerId), openByCustomer, payers, rngFor(`conversations:${name}`));
  return { history: built, money, conversations };
}

/** The open complaint of C17 carries the receipt he sends again (FL-021). */
function attachOpenReceipt(bundle: History, receipts: readonly ReceiptFile[]): void {
  const complaint = bundle.history.complaints.find((candidate) => candidate.plan.customerId === "cus-0017" && candidate.plan.state === "HUMAN_REVIEW");
  const receipt = receipts.find((candidate) => candidate.id === "c17-1");
  if (!complaint || !receipt?.truth.fields) throw new Error("C17's open complaint or receipt is missing");
  const { fields } = receipt.truth;
  Object.assign(complaint.meta, { subject: { loanId: "L-0017", instalment: 5, operationCode: fields.operationCode } });
  const at = String(complaint.meta.filedAtSim);
  const common = { worldId: complaint.meta.worldId, complaintId: complaint.complaintId, actor: "AGENT", synthetic: true };
  bundle.history.evidence.push(
    { ...common, evidenceId: `evd-${complaint.complaintId.slice(4)}-img`, kind: "RECEIPT_IMAGE", atSim: at, details: { seedKey: `receipts/${receipt.path}`, sha256: receipt.sha256, contentType: "image/png" } },
    { ...common, evidenceId: `evd-${complaint.complaintId.slice(4)}-read`, kind: "RECEIPT_READING", refId: `rdg-${complaint.complaintId.slice(4)}`, atSim: at, details: { result: "READ", source: "BOTH_AGREE", fields } },
  );
}

function evalEntry(receipt: ReceiptFile): Record<string, unknown> {
  return { id: receipt.id, file: `receipts/${receipt.path}`, variant: receipt.variant, sha256: receipt.sha256, ...(receipt.persona ? { persona: receipt.persona } : {}), expected: receipt.truth };
}

export function buildSeed(): SeedBundle {
  const full = books();
  const fullHistory = history(full.ledger, "full", 122, OPEN_COMPLAINTS, 4, PERSONA_SPECS.map((spec) => spec.id));
  const openNumber = fullHistory.history.complaints.find((complaint) => complaint.plan.customerId === "cus-0017" && complaint.plan.state === "HUMAN_REVIEW")?.number ?? "";
  const receipts = buildReceipts(full.ledger, full.sources, openNumber);
  attachOpenReceipt(fullHistory, receipts);
  const allIds = PERSONA_SPECS.map((spec) => spec.id);
  const fullParts: TemplateParts = { ledger: full.ledger, batches: full.batches, ...fullHistory, receipts, personaIds: allIds };

  const qa = books();
  const qaCustomers = new Set(qa.ledger.customers.filter((customer) => !customer.persona || (QA_MIN_PERSONAS as readonly string[]).includes(customer.persona)).map((customer) => customer.customerId));
  const qaLedger = restrict(qa.ledger, qaCustomers);
  const qaBatches = batchesFor(qa.batches, qaCustomers);
  const qaHistory = history(qaLedger, "qa-min", 20, [], 0, QA_MIN_PERSONAS);
  const qaParts: TemplateParts = { ledger: qaLedger, batches: qaBatches, ...qaHistory, receipts, personaIds: QA_MIN_PERSONAS };

  return {
    reference: reference(full.ledger.customers),
    templates: { demo: buildTemplate("demo", fullParts), guest: buildTemplate("guest", fullParts), "qa-min": buildTemplate("qa-min", qaParts) },
    models: buildModels(fullParts),
    batches: { demo: full.batches, guest: full.batches, "qa-min": qaBatches, models: full.batches },
    receipts,
    evals: {
      grounding: { version: "v001", threshold: { clauseRecall: 1, groundingScore: 0.75, forbidden: 0 }, entries: groundingEval() },
      receipts: {
        version: "v001",
        images: receipts.filter((receipt) => receipt.eval).map(evalEntry),
        srSubset: receipts.filter((receipt) => receipt.sr).map(evalEntry),
        personas: receipts.filter((receipt) => receipt.persona).map(evalEntry),
      },
      classifier: { version: "v001", entries: classifierEval() },
      collectionCorpus: { version: "v002", entries: collectionCorpus() },
    },
    load: { simulated: simulatedComplaints(rngFor("load:simulated")), batch: batchInputs(rngFor("load:batch")) },
    ledger: full.ledger,
    qaLedger,
  };
}
