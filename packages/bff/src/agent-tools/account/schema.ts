// Target `account` (`ToolAccount`, docs/tool-catalog.md): reads of the customer's account in the
// simulated core. Every tool but `get_terms` needs the customer identified (`LAM-IDENTIFIED`); loans come
// from the session's customer (`LAM-SCOPE`). Amounts and dates come back with their text: the model
// copies, never computes. The zod here is the only source of the Gateway schema of these tools.
import { z } from "zod";
import { CalendarDate } from "@reclamo/shared";
import { boundedText, defineTool, idField } from "../common/define";

const OperationKind = z.enum(["PAYMENT", "CHARGE", "TRANSFER_IN", "TRANSFER_OUT", "DISBURSEMENT", "DEBIT", "ALL"]);
const TermsTopic = z.enum(["LOANS", "PAYMENTS", "LATE_INTEREST", "WALLET", "AUTO_DEBIT", "TRANSFERS", "EARLY_PAYOFF", "CLOSURE", "FEES", "COMPLAINT_RIGHTS", "DATA_PROTECTION"]);

/** What each topic covers, as the model reads it in the schema (reference.ts `TOPIC_CLAUSES` decides the clauses). */
const TOPIC_GUIDE =
  "Topic of the clauses: LOANS (the loan, its instalments and the disbursement fee), PAYMENTS (where instalments are paid, which instalment a payment goes to, cut-off times, when a network payment is credited), LATE_INTEREST (a late instalment, punitive interest and its 2-day tolerance, how debt notices are sent), WALLET (balance and movements, CVU, transfer cost, freezes, prepaid card), AUTO_DEBIT (the automatic debit, a failed or duplicated debit, cancelling it), TRANSFERS (incoming and outgoing transfers), EARLY_PAYOFF (paying the loan off early, its fee, the quote, the debt-free certificate), CLOSURE (closing the account, what happens with a loan or the balance, and the written confirmation of the closure), FEES (the fee schedule), COMPLAINT_RIGHTS (the complaint number, the 10-business-day answer, the written answer by email, a person, the regulator), DATA_PROTECTION (changing email, address or phone, what is never asked by chat, and what WhatsApp is never used for: collecting debts, offers; debt notices go by email).";

/** At most 8 clauses per call (docs/tool-catalog.md). */
export const MAX_CLAUSES = 8;

const loanId = () => idField("A loan of this customer, copied from get_account.");

export const ACCOUNT_TOOLS = {
  get_account: defineTool({
    name: "get_account",
    description: "Summary of the customer's account: status (and the category of a block), wallet balance, masked email and CVU, and the loans with their outstanding amount. Needs the customer identified.",
    fields: {},
    fences: { identified: true },
    callers: ["WORKER"],
    untrustedOutput: ["account.blockReason.text", "loans[].label"],
  }),

  list_operations: defineTool({
    name: "list_operations",
    description: "The customer's operations (payments, charges, transfers, disbursements, debits) between two dates, newest first: at most 90 days and 50 rows. A charge with alreadyReversed true was already returned to the customer. Needs the customer identified.",
    fields: {
      fromDate: CalendarDate.optional().describe("First day, YYYY-MM-DD. Left out: 30 days before toDate, or 90 days for kind CHARGE."),
      toDate: CalendarDate.optional().describe("Last day, YYYY-MM-DD."),
      kind: OperationKind.optional().describe("Kind of operation; ALL by default."),
    },
    check: (input, ctx) => {
      if (input.fromDate !== undefined && input.toDate !== undefined && input.fromDate > input.toDate) {
        ctx.addIssue({ code: "custom", path: ["fromDate"], message: "fromDate is after toDate" });
      }
    },
    fences: { identified: true },
    callers: ["WORKER"],
    untrustedOutput: ["operations[].description"],
  }),

  get_loan: defineTool({
    name: "get_loan",
    description: "One loan of the customer: principal, instalments paid, status, outstanding amount, cancellation date and the next due instalment. Needs the customer identified.",
    fields: { loanId: loanId() },
    scoped: { loanId: "LOAN" },
    fences: { identified: true },
  }),

  get_instalments: defineTool({
    name: "get_instalments",
    description: "The instalments of one loan of the customer with their due dates, amounts, status and the payments applied to each. Needs the customer identified.",
    fields: { loanId: loanId() },
    scoped: { loanId: "LOAN" },
    fences: { identified: true },
  }),

  get_fee_rules: defineTool({
    name: "get_fee_rules",
    description: "The fee schedule of the fictitious lender (what each fee is, its basis, when it applies and its clauses). Needs the customer identified.",
    fields: { feeCode: boundedText(40, "A fee code, to read only that fee.").optional() },
    fences: { identified: true },
    untrustedOutput: ["fees[].label", "fees[].basis", "fees[].whenApplies"],
  }),

  get_terms: defineTool({
    name: "get_terms",
    description:
      "Public clauses of the product terms (synthetic terms of a fictitious lender) by topic or id, at most 8: the only source to answer how something works (conditions, fees, deadlines, payments, the wallet, closure, data, the rights of a complaint). Quote the clause text. COMPLAINT_RIGHTS clauses are our reading of the rules, not legal advice: say so when you quote them. Does not need the customer identified.",
    fields: {
      topic: TermsTopic.optional().describe(TOPIC_GUIDE),
      clauseIds: z.array(boundedText(40, "A clause id.")).max(MAX_CLAUSES).optional().describe("Clause ids, as get_fee_rules or check_charge returned them."),
    },
    untrustedOutput: ["clauses[].title", "clauses[].text"],
  }),

  quote_early_payoff: defineTool({
    name: "quote_early_payoff",
    description: "Quotes the early payoff of one loan of the customer: total, breakdown (principal, accrued interest, fee and its clause) and until when it is valid. Needs the customer identified.",
    fields: { loanId: loanId() },
    scoped: { loanId: "LOAN" },
    fences: { identified: true },
  }),
} as const;
