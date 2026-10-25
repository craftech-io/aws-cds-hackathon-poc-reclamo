// The simulated lender's books as `Core` and `Networks` items of a template, in the formats the mocks
// read (packages/core-mock/src/store/items.ts with the keys of store/keys.ts, and
// packages/network-mock/src/store/items.ts): customers, accounts, wallets, loans and instalments,
// applied payments with their `OPC#` claims, wallet movements (automatic debits included), charges,
// transfers, owner rows, and the networks' world config, batches, lines, codes and transfer states.
import { coreKeys } from "@reclamo/core-mock/store/keys";
import { maskEmail, normalizeEmail, normalizePhone } from "@reclamo/shared";
import { TEST_PHONE_HASH_KEY, WORLD_PLACEHOLDER } from "../lib/constants";
import { hmacHex } from "../lib/json";
import type { TemplateItem } from "../lib/template";
import { localInstant } from "./calendar";
import { HOLIDAY_DATES } from "./holidays";
import type { Json } from "./history";
import { type Ledger, appliedByInstalment } from "./ledger";
import type { Batch } from "./settlements";

const W = `W#${WORLD_PLACEHOLDER}#`;

export function item(table: TemplateItem["table"], pk: string, sk: string, entity: string, data: Json): TemplateItem {
  return { table, pk: `${W}${pk}`, sk, entity, data };
}

/** An item whose partition key a mock's own builder made (already `W#<worldId>#…`). */
function keyed(table: TemplateItem["table"], pk: string, sk: string, entity: string, data: Json): TemplateItem {
  return { table, pk, sk, entity, data };
}

/** Email of a customer in a template: `demo` keeps the plain tag; every other world prefixes its id. */
export function customerEmail(customerId: string, bounce: boolean, perWorld: boolean): string {
  return `${bounce ? "bounce" : "success"}+${perWorld ? `${WORLD_PLACEHOLDER}-` : ""}${customerId}@simulator.amazonses.com`;
}

/** `+54 9 11 •••• 1001`. */
export function phoneMasked(phone: string): string {
  return `+54 9 11 •••• ${phone.slice(-4)}`;
}

/** Hash of a normalized address with the template key (the factory recomputes it with PhoneHashKey). */
export function templateHash(address: string, channel: "phone" | "email"): string {
  return hmacHex(TEST_PHONE_HASH_KEY, channel === "phone" ? normalizePhone(address) : normalizeEmail(address));
}

const ONBOARDING_OPT_IN = localInstant("2025-11-03", "10:00");

function customerRows(ledger: Ledger, mine: ReadonlySet<string>, perWorldEmail: boolean): TemplateItem[] {
  const items: TemplateItem[] = [];
  for (const customer of ledger.customers.filter((candidate) => mine.has(candidate.customerId))) {
    const pk = coreKeys.customerPk(WORLD_PLACEHOLDER, customer.customerId);
    const email = customerEmail(customer.customerId, customer.bounce, perWorldEmail);
    items.push(
      keyed("Core", pk, "META", "Customer", {
        customerId: customer.customerId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        docType: "DNI",
        docNumberMasked: `••••${customer.document.slice(-4)}`,
        phoneHash: templateHash(customer.phone, "phone"),
        phoneMasked: phoneMasked(customer.phone),
        emailMasked: maskEmail(email.replaceAll(WORLD_PLACEHOLDER, "w")),
        emailHash: templateHash(email.replaceAll(WORLD_PLACEHOLDER, "w"), "email"),
        whatsapp: customer.optIn ? { optedIn: true, optedInAtSim: ONBOARDING_OPT_IN, optInMedium: "SIGNED_ONBOARDING", optInTextVersion: "v001", optedOut: false } : { optedIn: false, optedOut: false },
        phoneE164: customer.phone,
        email,
        docNumber: customer.document,
        address: customer.address,
        synthetic: true,
      }),
      keyed("Core", pk, "ACCOUNT", "Account", { customerId: customer.customerId, status: customer.blocked ? "BLOCKED" : "ACTIVE", ...(customer.blocked ? { blockCategory: customer.blocked } : {}), dataChanges: [], synthetic: true }),
      keyed("Core", pk, "WALLET", "Wallet", { customerId: customer.customerId, balance: customer.walletBalance, syntheticCvu: customer.cvu, freeze: { active: false, history: [] }, synthetic: true }),
    );
  }
  return items;
}

function loanRows(ledger: Ledger, mine: ReadonlySet<string>): TemplateItem[] {
  const items: TemplateItem[] = [];
  for (const loan of ledger.loans.filter((candidate) => mine.has(candidate.customerId))) {
    const pk = coreKeys.customerPk(WORLD_PLACEHOLDER, loan.customerId);
    const covered = appliedByInstalment(ledger, loan);
    const cancelled = loan.rows.every((row) => covered.get(row.number) === row.amount);
    const lastApplied = ledger.payments.filter((payment) => payment.loanId === loan.loanId && payment.applied).map((payment) => payment.appliedAt ?? payment.paidAt).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    const { disbursement } = loan;
    items.push(
      keyed("Core", pk, coreKeys.loanSk(loan.loanId), "Loan", {
        loanId: loan.loanId,
        customerId: loan.customerId,
        label: loan.label,
        principal: loan.principal,
        instalmentsCount: loan.count,
        annualRate: loan.annualRate,
        status: cancelled ? "CANCELLED" : "ACTIVE",
        disbursedAtSim: disbursement.at,
        ...(cancelled && lastApplied ? { cancelledAtSim: lastApplied } : {}),
        disbursement: {
          status: disbursement.status,
          gross: disbursement.gross,
          originationFee: disbursement.originationFee,
          net: disbursement.net,
          ...(disbursement.creditedAt ? { creditedAtSim: disbursement.creditedAt } : {}),
          ...(disbursement.expectedBy ? { expectedBySim: disbursement.expectedBy } : {}),
          ...(disbursement.returnedAt ? { returnedAtSim: disbursement.returnedAt } : {}),
        },
        synthetic: true,
      }),
      keyed("Core", coreKeys.loanOwnerPk(WORLD_PLACEHOLDER, loan.loanId), "OWNER", "LoanOwner", { customerId: loan.customerId, synthetic: true }),
    );
    for (const row of loan.rows) {
      items.push(keyed("Core", pk, coreKeys.instalmentSk(loan.loanId, row.number), "Instalment", { loanId: loan.loanId, ...row, lateInterest: 0, paid: covered.get(row.number) ?? 0, synthetic: true }));
    }
  }
  return items;
}

function paymentRows(ledger: Ledger, mine: ReadonlySet<string>): TemplateItem[] {
  const items: TemplateItem[] = [];
  for (const payment of ledger.payments.filter((candidate) => candidate.applied && mine.has(candidate.customerId))) {
    const loan = ledger.loans.find((candidate) => candidate.loanId === payment.loanId);
    if (!loan) throw new Error(`payment ${payment.paymentId} without its loan`);
    const appliedAt = payment.appliedAt ?? payment.paidAt;
    let left = payment.amount;
    const allocations = payment.instalments
      .map((number) => {
        const amount = Math.min(left, loan.rows[number - 1]?.amount ?? 0);
        left -= amount;
        return { instalment: number, amount };
      })
      .filter((allocation) => allocation.amount > 0);
    const actionId = `act-${payment.paymentId}`;
    items.push(
      keyed("Core", coreKeys.customerPk(WORLD_PLACEHOLDER, payment.customerId), coreKeys.paymentSk(payment.loanId, payment.paymentId), "Payment", {
        paymentId: payment.paymentId,
        loanId: payment.loanId,
        customerId: payment.customerId,
        network: payment.network,
        operationCode: payment.operationCode,
        amount: payment.amount,
        paidAtSim: payment.paidAt,
        appliedAtSim: appliedAt,
        source: payment.network === "WALLET" ? "WALLET" : "SETTLEMENT",
        allocations,
        lateInterest: 0,
        actionId,
        opCodeKey: coreKeys.opCodeKey(WORLD_PLACEHOLDER, payment.network, payment.operationCode),
        synthetic: true,
      }),
      keyed("Core", coreKeys.claimPk(WORLD_PLACEHOLDER, "OPC", `${payment.network}#${payment.operationCode}`), "CLAIM", "ActionClaim", {
        kind: "OPC",
        actionId,
        customerId: payment.customerId,
        complaintId: `seed-${payment.paymentId}`,
        amount: payment.amount,
        idempotencyKey: `seed:${payment.paymentId}`,
        synthetic: true,
      }),
    );
  }
  return items;
}

function walletRows(ledger: Ledger, mine: ReadonlySet<string>): TemplateItem[] {
  const items: TemplateItem[] = [];
  for (const { at, ...movement } of ledger.movements.filter((candidate) => mine.has(candidate.customerId))) {
    items.push(keyed("Core", coreKeys.customerPk(WORLD_PLACEHOLDER, movement.customerId), coreKeys.movementSk(at, movement.movementId), "Movement", { ...movement, atSim: at, synthetic: true }));
  }
  for (const charge of ledger.charges.filter((candidate) => mine.has(candidate.customerId))) {
    const { expected: _expected, chargedAt, reversal, ...rest } = charge;
    items.push(
      keyed("Core", coreKeys.customerPk(WORLD_PLACEHOLDER, charge.customerId), coreKeys.chargeSk(charge.chargeId), "Charge", {
        ...rest,
        chargedAtSim: chargedAt,
        scheduleVersion: "v001",
        ...(reversal ? { reversal: { actionId: reversal.actionId, creditNoteId: reversal.creditNoteId, complaintId: reversal.complaintId, amount: reversal.amount, compensatoryInterest: reversal.compensatoryInterest, creditedAtSim: reversal.at } } : {}),
        synthetic: true,
      }),
      keyed("Core", coreKeys.chargeOwnerPk(WORLD_PLACEHOLDER, charge.chargeId), "OWNER", "ChargeOwner", { customerId: charge.customerId, synthetic: true }),
    );
  }
  for (const transfer of ledger.transfers.filter((candidate) => mine.has(candidate.customerId))) {
    items.push(
      keyed("Core", coreKeys.customerPk(WORLD_PLACEHOLDER, transfer.customerId), coreKeys.transferSk(transfer.transferId), "Transfer", {
        transferId: transfer.transferId,
        customerId: transfer.customerId,
        direction: transfer.direction,
        amount: transfer.amount,
        atSim: transfer.at,
        status: transfer.status,
        counterpartMasked: transfer.counterpartyMasked,
        synthetic: true,
      }),
      item("Networks", `TRF#${transfer.transferId}`, "STATUS", "TransferStatus", {
        worldId: WORLD_PLACEHOLDER,
        transferId: transfer.transferId,
        customerId: transfer.customerId,
        direction: transfer.direction,
        amount: transfer.amount,
        status: transfer.status,
        ...(transfer.traceId ? { traceId: transfer.traceId } : {}),
        ...(transfer.status === "COMPLETED" ? { completedAtSim: transfer.at } : {}),
        ...(transfer.expectedBy ? { expectedBySim: transfer.expectedBy } : {}),
        ...(transfer.rejectReason ? { rejectReason: transfer.rejectReason } : {}),
        ...(transfer.reversedAt ? { reversedAtSim: transfer.reversedAt } : {}),
        transitions: [],
        version: 1,
      }),
    );
  }
  return items;
}

export function coreItems(ledger: Ledger, customerIds: ReadonlySet<string>, perWorldEmail: boolean): TemplateItem[] {
  return [...customerRows(ledger, customerIds, perWorldEmail), ...loanRows(ledger, customerIds), ...paymentRows(ledger, customerIds), ...walletRows(ledger, customerIds)];
}

/** The networks' items of a template: world config, batches, every line with its code claim. */
export function networkItems(batches: readonly Batch[]): TemplateItem[] {
  const items: TemplateItem[] = [
    item("Networks", "NET#WORLD", "CONFIG", "NetworkWorld", {
      worldId: WORLD_PLACEHOLDER,
      holidays: [...HOLIDAY_DATES],
      settlementDelays: { NORTE: { businessDays: 1, publishAt: "08:30", cutoff: "18:00" }, SUR: { businessDays: 2, publishAt: "11:00", cutoff: "16:00" } },
      version: 1,
    }),
  ];
  for (const batch of batches) {
    const published = batch.status === "PUBLISHED";
    items.push(
      item("Networks", `NET#${batch.network}`, `BATCH#${batch.businessDate}`, "SettlementBatch", {
        network: batch.network,
        businessDate: batch.businessDate,
        status: batch.status,
        publishAtSim: batch.publishAt,
        ...(published ? { publishedAtSim: batch.publishAt, s3Key: `W/${WORLD_PLACEHOLDER}/${batch.network}/${batch.businessDate}/batch-1.csv`, lineCount: batch.lines.length, sha256: batch.sha256 } : {}),
        worldId: WORLD_PLACEHOLDER,
        seq: 1,
        deferred: false,
        version: 1,
      }),
    );
    for (const line of batch.lines) {
      const stored = { worldId: WORLD_PLACEHOLDER, line, origin: "SEED", createdBatch: false };
      items.push(
        item("Networks", `NET#${batch.network}`, `LINE#${batch.businessDate}#${line.operationCode}`, "SettlementLine", stored),
        item("Networks", `NET#${batch.network}`, `OPC#${line.operationCode}`, "OperationCodeClaim", stored),
      );
    }
  }
  return items;
}
