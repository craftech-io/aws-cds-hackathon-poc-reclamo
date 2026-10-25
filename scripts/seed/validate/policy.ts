// Invariants 8 to 11 (docs/seed-spec.md §14): every seeded charge gets from `check_charge` the verdict
// its scenario needs, the seeded duplicate debits are detected and C26's are not, every historical
// outbound has its `ALLOWED` and `DISPATCH` on the tape and passes the policy at its own instant, and
// no WhatsApp text of the seed (messages, templates) is collection or has a button over its limit.
// They run the real core (WP-15) and channel-policy (WP-17) when those load (real-logic.ts), the
// contract's reference logic otherwise.
import { BUTTON_TITLE_LIMIT, WHATSAPP_TEMPLATES, templateButtonTitles } from "@reclamo/bff/copy/index";
import type { WorldTemplateFile } from "../lib/template";
import { type Json, type SeedOnDisk, debitsOf, entities } from "./read";
import type { RealLogic } from "./real-logic";
import { checkCharge, duplicateDebits, looksLikeCollection, replyAllowed } from "./reference-logic";
import { holidayDates } from "./register";

type Report = (invariant: number, message: string) => void;

function chargeVerdict(real: RealLogic, template: WorldTemplateFile, charge: Json, others: readonly Json[], earlierSameFee: readonly Json[]): { verdict: string; reason: string } {
  const loans = new Map(entities(template, "Loan").map((loan) => [String(loan.loanId), loan]));
  const instalments = new Map(entities(template, "Instalment").map((row) => [`${String(row.loanId)}#${String(row.number)}`, row]));
  const payments = entities(template, "Payment").filter((payment) => payment.loanId === charge.loanId);
  if (real.evaluateCharge && real.parseCoreItem) {
    const parse = real.parseCoreItem;
    const loan = loans.get(String(charge.loanId));
    const instalment = instalments.get(`${String(charge.loanId)}#${String(charge.instalment)}`);
    return real.evaluateCharge({
      charge: parse("Charge", charge),
      ...(loan ? { loan: parse("Loan", loan) } : {}),
      ...(instalment ? { instalment: parse("Instalment", instalment) } : {}),
      payments: payments.map((payment) => parse("Payment", payment)),
      otherCharges: others.map((other) => parse("Charge", other)),
    });
  }
  return checkCharge({ charge, loans, instalments, payments, earlierSameFee });
}

function checkCharges(real: RealLogic, name: string, template: WorldTemplateFile, expected: Record<string, string>, report: Report): void {
  const charges = entities(template, "Charge").sort((a, b) => Date.parse(String(a.chargedAtSim)) - Date.parse(String(b.chargedAtSim)) || (String(a.chargeId) < String(b.chargeId) ? -1 : 1));
  charges.forEach((charge, index) => {
    const others = charges.filter((other) => other.customerId === charge.customerId && other.chargeId !== charge.chargeId);
    const earlierSameFee = charges.slice(0, index).filter((other) => other.feeCode === charge.feeCode && other.customerId === charge.customerId);
    const result = chargeVerdict(real, template, charge, others, earlierSameFee);
    const wanted = expected[String(charge.chargeId)];
    if (!wanted) report(8, `${name}: charge ${String(charge.chargeId)} has no seeded verdict in the manifest`);
    else if (result.verdict !== wanted) report(8, `${name}: check_charge gives ${result.verdict} (${result.reason}) for ${String(charge.chargeId)}, the seed says ${wanted}`);
  });
}

function checkDuplicates(real: RealLogic, name: string, template: WorldTemplateFile, report: Report): void {
  const debits = debitsOf(template);
  const detect = (ofLoan: Json[]): Json[] => (real.findDuplicates ? real.findDuplicates(ofLoan) : duplicateDebits(ofLoan));
  for (const loanId of new Set(debits.map((debit) => String(debit.loanId)))) {
    const ofLoan = debits.filter((debit) => debit.loanId === loanId);
    const found = new Set(detect(ofLoan).map((debit) => String(debit.debitId)));
    const seeded = new Set(ofLoan.filter((debit) => debit.paymentId === undefined).map((debit) => String(debit.debitId)));
    for (const id of seeded) if (!found.has(id)) report(9, `${name}: the seeded duplicate ${id} is not detected`);
    for (const id of found) if (!seeded.has(id)) report(9, `${name}: ${id} is detected as a duplicate but it was applied`);
  }
  if (name !== "qa-min" && detect(debits.filter((debit) => debit.customerId === "cus-0026")).length > 0) report(9, `${name}: C26 must be NOT_DUPLICATE`);
  for (const id of ["cus-0003", "cus-0025"]) {
    if (!debits.some((debit) => debit.customerId === id)) continue;
    if (detect(debits.filter((debit) => debit.customerId === id)).length !== 1) report(9, `${name}: ${id} must have exactly one detected duplicate`);
  }
}

function realReply(real: RealLogic, seed: SeedOnDisk, template: WorldTemplateFile, message: Json, inbound: readonly Json[], customer: Json | undefined): { allowed: boolean; rule?: string } | undefined {
  if (!real.evaluateAsOf) return undefined;
  const settings = template.settings as Json;
  const all = entities(template, "Message").filter((candidate) => candidate.customerId === message.customerId);
  const answered = inbound.filter((entry) => Date.parse(String(entry.atSim)) <= Date.parse(String(message.atSim))).at(-1);
  const decision = real.evaluateAsOf({
    worldId: "demo",
    customerId: message.customerId,
    message: { messageId: message.messageId, channel: message.channel, kind: message.kind, sender: message.sender, body: message.body, sentAtSim: message.sentAtSim ?? message.atSim, simulated: true },
    trigger: "CUSTOMER_MESSAGE",
    ...(answered ? { answers: answered.messageId } : {}),
    ...(customer?.whatsapp ? { consent: customer.whatsapp } : {}),
    conversation: { control: "AGENT", controlHistory: [] },
    history: all.map((entry) => ({ messageId: entry.messageId, direction: entry.direction, channel: entry.channel, ...(entry.kind ? { kind: entry.kind } : {}), status: entry.status, atSim: entry.atSim })),
    settings: { contactHours: settings.contactHours, maxProactivePerDay: settings.maxProactivePerDay, holidays: holidayDates(seed) },
  });
  return decision.decision === "ALLOWED" ? { allowed: true } : { allowed: false, rule: decision.ruleIds.join("+") };
}

function checkTape(real: RealLogic, seed: SeedOnDisk, name: string, template: WorldTemplateFile, report: Report): void {
  const tape = entities(template, "TapeEntry");
  const messages = entities(template, "Message");
  const customers = new Map(entities(template, "Customer").map((customer) => [String(customer.customerId), customer]));
  for (const message of messages.filter((candidate) => candidate.direction === "OUT")) {
    const entries = tape.filter((entry) => entry.messageId === message.messageId);
    if (!entries.some((entry) => entry.decision === "ALLOWED")) report(10, `${name}: outbound ${String(message.messageId)} has no ALLOWED entry`);
    if (!entries.some((entry) => entry.decision === "DISPATCH")) report(10, `${name}: outbound ${String(message.messageId)} has no DISPATCH entry`);
    const inbound = messages.filter((candidate) => candidate.direction === "IN" && candidate.customerId === message.customerId).sort((a, b) => Date.parse(String(a.atSim)) - Date.parse(String(b.atSim)));
    const customer = customers.get(String(message.customerId));
    const verdict = realReply(real, seed, template, message, inbound, customer) ?? replyAllowed({ message, inbound, customer });
    if (!verdict.allowed) report(10, `${name}: outbound ${String(message.messageId)} breaks ${verdict.rule ?? "the policy"} at its instant`);
    if (message.channel === "WHATSAPP" && (real.isCollection ?? looksLikeCollection)(String(message.body))) report(11, `${name}: outbound ${String(message.messageId)} reads as collection`);
  }
  for (const entry of tape.filter((candidate) => candidate.decision === "ALLOWED" || candidate.decision === "DISPATCH")) {
    if (!messages.some((message) => message.messageId === entry.messageId) && !String(entry.tapeId).startsWith("tp-blk-")) report(10, `${name}: tape entry ${String(entry.tapeId)} has no message`);
  }
  const rules = tape.filter((entry) => entry.decision === "BLOCKED" || entry.decision === "DEFERRED").map((entry) => ((entry.ruleIds as string[]) ?? [])[0]).sort();
  const wanted = ["CH-CONTACT-HOURS", "CH-NO-CREDIT-OFFER", "CH-WA-24H", "CH-WA-24H", "CH-WA-NO-COLLECTION", "CH-WA-NO-COLLECTION"];
  if (rules.join() !== wanted.join()) report(10, `${name}: the historical blocks are ${rules.join(", ")}`);
}

function checkTemplates(real: RealLogic, report: Report): void {
  for (const template of Object.values(WHATSAPP_TEMPLATES)) {
    if ((real.isCollection ?? looksLikeCollection)(template.body)) report(11, `template ${template.name} reads as collection`);
    for (const title of templateButtonTitles(template.name)) if (title.length > BUTTON_TITLE_LIMIT.QUICK_REPLY) report(11, `template ${template.name}: button "${title}" over ${BUTTON_TITLE_LIMIT.QUICK_REPLY}`);
  }
}

export function checkPolicy(seed: SeedOnDisk, real: RealLogic, report: Report): void {
  const verdicts = ((seed.manifest.facts as Json | undefined)?.chargeVerdicts ?? {}) as Record<string, Record<string, string>>;
  for (const name of ["demo", "guest", "qa-min"] as const) {
    const template = seed.templates[name];
    checkCharges(real, name, template, verdicts[name === "qa-min" ? "qa-min" : "full"] ?? {}, report);
    checkDuplicates(real, name, template, report);
    checkTape(real, seed, name, template, report);
  }
  checkTemplates(real, report);
}
