// Invariants 1 to 7 (docs/seed-spec.md §14): the files are the ones the manifest fingerprinted, loans
// and instalments add up, every applied payment has its settlement line (or wallet movement) of the
// same customer and loan and its `OPC#` claim, pending batches hold exactly their business date,
// the fake receipts never match and C41's matches another payer, phones, emails, CVUs and documents
// are synthetic.
import { businessDateOf } from "../generate/calendar";
import { NON_ASSIGNABLE_PHONE, SYNTHETIC_CVU, SYNTHETIC_DOCUMENT, hasValidCheckDigit } from "../lib/codes";
import { sha256Hex } from "../lib/json";
import type { WorldTemplateFile } from "../lib/template";
import { type Json, type SeedOnDisk, claimKeys, entities, networkLines, publishedLines } from "./read";

type Report = (invariant: number, message: string) => void;
const TEMPLATE_NAMES = ["demo", "guest", "qa-min"] as const;
const RESERVED_DOMAIN = /@(example\.(com|net|org)|[^@]*\.(test|example|invalid|localhost))$/i;

export function checkFingerprints(seed: SeedOnDisk, report: Report): void {
  const recorded = (seed.manifest.files ?? {}) as Record<string, string>;
  for (const [path, bytes] of seed.files) {
    if (path === "data/manifest.json") continue;
    if (recorded[path] === undefined) report(1, `${path} is not in the manifest`);
    else if (recorded[path] !== sha256Hex(bytes)) report(1, `${path} differs from its manifest fingerprint`);
  }
  for (const path of Object.keys(recorded)) if (!seed.files.has(path)) report(1, `${path} is in the manifest but missing`);
}

function checkLoans(name: string, template: WorldTemplateFile, report: Report): void {
  const instalments = entities(template, "Instalment");
  for (const loan of entities(template, "Loan")) {
    const rows = instalments.filter((row) => row.loanId === loan.loanId);
    const count = Number(loan.instalmentsCount);
    if (count < 3 || count > 18 || rows.length !== count) report(2, `${name}: ${String(loan.loanId)} has ${rows.length} instalments (declared ${count})`);
    const principal = rows.reduce((sum, row) => sum + Number(row.principal), 0);
    if (principal !== loan.principal) report(2, `${name}: ${String(loan.loanId)} principal parts add ${principal}, not ${String(loan.principal)}`);
    for (const row of rows) {
      if (Number(row.principal) + Number(row.interest) + Number(row.vat) !== row.amount) report(2, `${name}: ${String(loan.loanId)} instalment ${String(row.number)} does not add up`);
    }
  }
}

function checkPayments(seed: SeedOnDisk, name: string, template: WorldTemplateFile, report: Report): void {
  const lines = publishedLines(seed, name);
  const loans = new Map(entities(template, "Loan").map((loan) => [String(loan.loanId), loan]));
  const claims = claimKeys(template);
  const movements = entities(template, "Movement");
  const seen = new Set<string>();
  for (const payment of entities(template, "Payment")) {
    const key = `${String(payment.network)}#${String(payment.operationCode)}`;
    if (seen.has(key)) report(3, `${name}: ${key} is applied twice`);
    seen.add(key);
    if (!claims.has(`OPC#${key}`)) report(3, `${name}: ${String(payment.paymentId)} has no OPC# claim`);
    if (loans.get(String(payment.loanId))?.customerId !== payment.customerId) report(3, `${name}: ${String(payment.paymentId)} pays a loan of another customer`);
    if (payment.network === "WALLET") {
      if (!movements.some((movement) => (movement.ref as Json).paymentId === payment.paymentId && movement.amount === payment.amount)) report(3, `${name}: wallet payment ${String(payment.paymentId)} has no movement`);
      continue;
    }
    const line = lines.find((candidate) => candidate.network === payment.network && candidate.operationCode === payment.operationCode);
    if (!line) report(3, `${name}: ${String(payment.paymentId)} has no line in a published settlement`);
    else if (line.amount !== payment.amount || line.customerRef !== payment.customerId || line.loanRef !== payment.loanId) report(3, `${name}: the line of ${String(payment.paymentId)} is not its amount, customer and loan`);
  }
  for (const line of lines) {
    if (businessDateOf(line.network, line.paidAt) !== line.businessDate) report(4, `${name}: ${line.operationCode} is in the batch of the wrong business date`);
    if (loans.get(line.loanRef)?.customerId !== line.customerRef) report(3, `${name}: line ${line.operationCode} names a loan of another customer`);
  }
  const batches = entities(template, "SettlementBatch");
  const held = networkLines(template);
  for (const line of held.filter((candidate) => candidate.status === "PENDING")) {
    if (businessDateOf(line.network as "NORTE" | "SUR", String(line.paidAt)) !== line.businessDate) report(4, `${name}: pending line ${String(line.operationCode)} is not of its business date`);
    if (claims.has(`OPC#${String(line.network)}#${String(line.operationCode)}`)) report(4, `${name}: pending line ${String(line.operationCode)} is already applied`);
  }
  for (const line of held.filter((candidate) => candidate.status === "MISSING")) report(4, `${name}: line ${String(line.operationCode)} has no batch`);
  for (const batch of batches) {
    const ofBatch = held.filter((line) => line.network === batch.network && line.businessDate === batch.businessDate);
    const payers = ofBatch.filter((line) => Number(String(line.customerRef).slice(4)) >= 1000).length;
    if (payers < 10 || ofBatch.length > 40) report(4, `${name}: batch ${String(batch.network)} ${String(batch.businessDate)} has ${ofBatch.length} lines (${payers} of other payers)`);
    if (batch.status === "PUBLISHED" && ofBatch.length !== lines.filter((line) => line.network === batch.network && line.businessDate === batch.businessDate).length) report(4, `${name}: batch ${String(batch.network)} ${String(batch.businessDate)} holds other lines than its CSV`);
  }
}

function checkFakeReceipts(seed: SeedOnDisk, report: Report): void {
  const truth = [...((seed.evals.receipts.images ?? []) as Json[]), ...((seed.evals.receipts.personas ?? []) as Json[])];
  const codes = new Set<string>();
  for (const name of TEMPLATE_NAMES) {
    for (const line of publishedLines(seed, name)) codes.add(line.operationCode);
    for (const line of networkLines(seed.templates[name])) codes.add(String(line.operationCode));
  }
  for (const entry of truth) {
    const code = String(((entry.expected as Json).fields as Json | undefined)?.operationCode ?? "");
    if (entry.variant === "fake-unknown" && (codes.has(code) || !hasValidCheckDigit(code))) report(5, `${String(entry.id)}: a fake-unknown code must have a valid digit and no line`);
    if (entry.variant === "fake-check" && hasValidCheckDigit(code)) report(5, `${String(entry.id)}: a fake-check code must have an invalid digit`);
  }
  const personaReceipts = (id: string): Json[] => truth.filter((entry) => entry.persona === id);
  const c18 = String(((personaReceipts("C18")[0]?.expected as Json | undefined)?.fields as Json | undefined)?.operationCode ?? "");
  if (!c18 || codes.has(c18)) report(5, "C18's receipt code must not be in any settlement");
  const c07 = String(((personaReceipts("C07")[0]?.expected as Json | undefined)?.fields as Json | undefined)?.operationCode ?? "");
  if (!c07 || hasValidCheckDigit(c07)) report(5, "C07's receipt must have an invalid check digit");
  const c41 = ((personaReceipts("C41")[0]?.expected as Json | undefined)?.fields ?? {}) as Json;
  const line = publishedLines(seed, "guest").find((candidate) => candidate.operationCode === c41.operationCode);
  if (!line || line.customerRef === "cus-0041") report(5, "C41's receipt code must be published on another customer's line");
}

function checkIdentifiers(name: string, template: WorldTemplateFile, report: Report): void {
  const phones = new Set<string>();
  for (const customer of entities(template, "Customer")) {
    const phone = String(customer.phoneE164);
    if (!NON_ASSIGNABLE_PHONE.test(phone)) report(6, `${name}: ${String(customer.customerId)} has a phone outside the non-assignable range`);
    if (phones.has(phone)) report(6, `${name}: phone of ${String(customer.customerId)} is not unique`);
    phones.add(phone);
    const email = String(customer.email);
    if (!email.endsWith("@simulator.amazonses.com") || RESERVED_DOMAIN.test(email)) report(6, `${name}: ${String(customer.customerId)} has an email outside the SES mailbox simulator`);
    if (!SYNTHETIC_DOCUMENT.test(String(customer.docNumber))) report(7, `${name}: ${String(customer.customerId)} has a document outside the synthetic range`);
  }
  for (const wallet of entities(template, "Wallet")) if (!SYNTHETIC_CVU.test(String(wallet.syntheticCvu))) report(7, `${name}: ${String(wallet.customerId)} has a CVU outside 9990 + 18 digits`);
}

export function checkBooks(seed: SeedOnDisk, report: Report): void {
  checkFingerprints(seed, report);
  for (const name of TEMPLATE_NAMES) {
    const template = seed.templates[name];
    checkLoans(name, template, report);
    checkPayments(seed, name, template, report);
    checkIdentifiers(name, template, report);
  }
  checkFakeReceipts(seed, report);
}
