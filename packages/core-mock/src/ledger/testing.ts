// Fixtures of the core for the unit tests (and the bff client's round trip): customers with their
// account, wallet, loans, instalments, payments, movements, charges and transfers, written with the
// same keys and entity tags the seed writes. Synthetic data only.
import type { StoredItem } from "../store/port";
import { SK, coreKeys } from "../store/keys";
import { createMemoryCoreStore, type MemoryCoreStore } from "../store/memory";
import type { LedgerContext } from "./context";

/** The demo's paused clock: Wednesday 07/10/2026 10:10, Argentina. */
export const SIM_NOW = "2026-10-07T10:10:00-03:00";
export const WORLD = "qa-run1-core";
export const PHONE_HASH = "a".repeat(64);

export interface InstalmentSpec {
  readonly number: number;
  readonly dueDate: string;
  readonly amount: number;
  readonly paid?: number;
  readonly lateInterest?: number;
}

export interface PaymentSpec {
  readonly paymentId: string;
  readonly network: "NORTE" | "SUR" | "TRANSFER" | "WALLET";
  readonly operationCode: string;
  readonly amount: number;
  readonly paidAtSim: string;
  readonly allocations: ReadonlyArray<{ instalment: number; amount: number }>;
}

export interface LoanSpec {
  readonly loanId: string;
  readonly principal: number;
  readonly annualRate?: number;
  readonly status?: "ACTIVE" | "CANCELLED" | "EARLY_CANCELLED";
  readonly disbursedAtSim?: string;
  readonly disbursement?: Record<string, unknown>;
  readonly instalments: readonly InstalmentSpec[];
  readonly payments?: readonly PaymentSpec[];
}

export interface MovementSpec {
  readonly movementId: string;
  readonly kind: "PAYMENT" | "CHARGE" | "TRANSFER_IN" | "TRANSFER_OUT" | "DISBURSEMENT" | "DEBIT" | "CREDIT";
  readonly atSim: string;
  readonly amount: number;
  readonly direction?: "IN" | "OUT";
  readonly status?: "COMPLETED" | "PENDING" | "REJECTED" | "REVERSED";
  readonly ref?: Record<string, unknown>;
}

export interface ChargeSpec {
  readonly chargeId: string;
  readonly feeCode: string;
  readonly amount: number;
  readonly chargedAtSim: string;
  readonly loanId?: string;
  readonly instalment?: number;
  readonly requested?: boolean;
  readonly basisAmount?: number;
}

export interface CustomerSpec {
  readonly customerId: string;
  readonly phoneHash?: string;
  readonly balance?: number;
  readonly accountStatus?: "ACTIVE" | "BLOCKED" | "CLOSING" | "CLOSED";
  readonly blockCategory?: string;
  readonly frozen?: boolean;
  readonly loans?: readonly LoanSpec[];
  readonly movements?: readonly MovementSpec[];
  readonly charges?: readonly ChargeSpec[];
  readonly transfers?: ReadonlyArray<{ transferId: string; amount: number; status: string; direction?: "IN" | "OUT"; atSim?: string }>;
  readonly expiresAt?: number;
}

function row(worldId: string, pk: string, sk: string, value: Record<string, unknown>, expiresAt?: number): StoredItem {
  return { ...value, pk, sk, worldId, version: 1, synthetic: true, ...coreKeys.worldIndex(worldId, pk, sk), ...(expiresAt === undefined ? {} : { expiresAt }) };
}

/** principal / interest / VAT of an instalment amount (VAT is 21 % of the interest). */
export function splitInstalment(amount: number): { principal: number; interest: number; vat: number } {
  const principal = Math.round(amount * 0.7);
  const interest = Math.round((amount - principal) / 1.21);
  return { principal, interest, vat: amount - principal - interest };
}

export function customerItems(worldId: string, spec: CustomerSpec): StoredItem[] {
  const pk = coreKeys.customerPk(worldId, spec.customerId);
  const at = (sk: string, value: Record<string, unknown>) => row(worldId, pk, sk, value, spec.expiresAt);
  const suffix = spec.customerId.replace(/\D/g, "").padStart(4, "0").slice(-4);
  const items: StoredItem[] = [
    at(SK.META, {
      entity: "Customer",
      customerId: spec.customerId,
      firstName: "Valeria",
      lastName: "Quiroga",
      docType: "DNI",
      docNumberMasked: `••••${suffix}`,
      phoneHash: spec.phoneHash ?? PHONE_HASH,
      phoneMasked: `+54 9 11 •••• ${suffix}`,
      emailMasked: `s***@simulator.amazonses.com`,
      liveE164: "+5491100001001",
      whatsapp: { optedIn: true, optedInAtSim: "2025-03-01T10:00:00-03:00", optInMedium: "SIGNED_ONBOARDING", optInTextVersion: "v001", optedOut: false },
    }),
    at(SK.ACCOUNT, { entity: "Account", customerId: spec.customerId, status: spec.accountStatus ?? "ACTIVE", ...(spec.blockCategory === undefined ? {} : { blockCategory: spec.blockCategory }) }),
    at(SK.WALLET, {
      entity: "Wallet",
      customerId: spec.customerId,
      balance: spec.balance ?? 0,
      syntheticCvu: `9990${"0".repeat(14)}${suffix}`,
      freeze: { active: spec.frozen ?? false, history: [] },
    }),
    row(worldId, coreKeys.phonePk(worldId, spec.phoneHash ?? PHONE_HASH), SK.CLAIM, { entity: "PhoneClaim", customerId: spec.customerId }),
  ];
  for (const loan of spec.loans ?? []) {
    items.push(row(worldId, coreKeys.loanOwnerPk(worldId, loan.loanId), SK.OWNER, { entity: "LoanOwner", customerId: spec.customerId }));
    items.push(
      at(coreKeys.loanSk(loan.loanId), {
        entity: "Loan",
        loanId: loan.loanId,
        customerId: spec.customerId,
        label: `Préstamo ${loan.loanId}`,
        principal: loan.principal,
        instalmentsCount: loan.instalments.length,
        annualRate: loan.annualRate ?? 0.95,
        status: loan.status ?? "ACTIVE",
        ...(loan.disbursedAtSim === undefined ? {} : { disbursedAtSim: loan.disbursedAtSim }),
        ...(loan.disbursement === undefined ? {} : { disbursement: loan.disbursement }),
      }),
    );
    for (const instalment of loan.instalments) {
      items.push(
        at(coreKeys.instalmentSk(loan.loanId, instalment.number), {
          entity: "Instalment",
          loanId: loan.loanId,
          number: instalment.number,
          dueDate: instalment.dueDate,
          ...splitInstalment(instalment.amount),
          amount: instalment.amount,
          lateInterest: instalment.lateInterest ?? 0,
          paid: instalment.paid ?? 0,
        }),
      );
    }
    for (const payment of loan.payments ?? []) {
      items.push(
        at(coreKeys.paymentSk(loan.loanId, payment.paymentId), {
          entity: "Payment",
          ...payment,
          allocations: [...payment.allocations],
          loanId: loan.loanId,
          customerId: spec.customerId,
          appliedAtSim: payment.paidAtSim,
          source: payment.network === "WALLET" ? "WALLET" : "SETTLEMENT",
          lateInterest: 0,
          opCodeKey: coreKeys.opCodeKey(worldId, payment.network, payment.operationCode),
        }),
      );
      items.push(
        row(worldId, coreKeys.claimPk(worldId, "OPC", `${payment.network}#${payment.operationCode}`), SK.CLAIM, {
          entity: "ActionClaim",
          kind: "OPC",
          actionId: `act-seed-${payment.paymentId}`,
          customerId: spec.customerId,
          complaintId: "seed",
          amount: payment.amount,
          idempotencyKey: `seed:${payment.paymentId}`,
        }),
      );
    }
  }
  for (const movement of spec.movements ?? []) {
    items.push(
      at(coreKeys.movementSk(movement.atSim, movement.movementId), {
        entity: "Movement",
        customerId: spec.customerId,
        direction: movement.direction ?? (movement.kind === "CREDIT" || movement.kind === "TRANSFER_IN" || movement.kind === "DISBURSEMENT" ? "IN" : "OUT"),
        description: `Operación ${movement.movementId}`,
        status: movement.status ?? "COMPLETED",
        ref: movement.ref ?? {},
        movementId: movement.movementId,
        kind: movement.kind,
        atSim: movement.atSim,
        amount: movement.amount,
      }),
    );
  }
  for (const charge of spec.charges ?? []) {
    items.push(row(worldId, coreKeys.chargeOwnerPk(worldId, charge.chargeId), SK.OWNER, { entity: "ChargeOwner", customerId: spec.customerId }));
    items.push(at(coreKeys.chargeSk(charge.chargeId), { entity: "Charge", customerId: spec.customerId, scheduleVersion: "v001", ...charge }));
  }
  for (const transfer of spec.transfers ?? []) {
    items.push(
      at(coreKeys.transferSk(transfer.transferId), {
        entity: "Transfer",
        customerId: spec.customerId,
        direction: transfer.direction ?? "OUT",
        atSim: transfer.atSim ?? "2026-10-06T12:00:00-03:00",
        transferId: transfer.transferId,
        amount: transfer.amount,
        status: transfer.status,
      }),
    );
  }
  return items;
}

/** A world in memory with these customers. */
export function coreWorld(customers: readonly CustomerSpec[], worldId: string = WORLD): MemoryCoreStore {
  return createMemoryCoreStore(customers.flatMap((customer) => customerItems(worldId, customer)));
}

export function ledgerContext(store: MemoryCoreStore, simNow: string = SIM_NOW, worldId: string = WORLD): LedgerContext {
  return { store, worldId, simNow, hashEmail: () => "f".repeat(64) };
}

/** The item at a key, or undefined. */
export function itemAt(store: MemoryCoreStore, pk: string, sk: string): StoredItem | undefined {
  return store.dump().find((item) => item.pk === pk && item.sk === sk);
}
