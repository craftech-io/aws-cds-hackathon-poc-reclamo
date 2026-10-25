// Keys of the `Core` table (docs/architecture.md §5). Every partition of a world starts with
// `W#<worldId>#`, so the IAM fences on `dynamodb:LeadingKeys` and the world factory's `WorldIndex`
// cover the core like every other table. The seed (`scripts/seed`) writes the template items with
// these same builders; the factory only substitutes the world.
//
//   W#<w>#CUS#<customerId>          META · ACCOUNT · WALLET · LOAN#<loanId> · LOAN#<loanId>#INST#<nn> ·
//                                   LOAN#<loanId>#PAY#<paymentId> · WALLET#MOV#<utc>#<movementId> ·
//                                   CHG#<chargeId> · TRF#<transferId> · CN#<creditNoteId> · QUOTE#<quoteId>
//   W#<w>#PHONE#<phoneHash>         CLAIM   (one customer per phone in a world)
//   W#<w>#LOAN#<loanId>             OWNER   (the routes that name only a loan find its customer)
//   W#<w>#CHG#<chargeId>            OWNER   (idem for a charge)
//   W#<w>#OPC#<network>#<code>      CLAIM   (natural-key claims of money actions; also REV#, RFD#, TRV#)

export const SK = {
  META: "META",
  ACCOUNT: "ACCOUNT",
  WALLET: "WALLET",
  CLAIM: "CLAIM",
  OWNER: "OWNER",
} as const;

export type ClaimKind = "OPC" | "REV" | "RFD" | "TRV";

function world(worldId: string): string {
  return `W#${worldId}#`;
}

export const coreKeys = {
  customerPk: (worldId: string, customerId: string): string => `${world(worldId)}CUS#${customerId}`,
  phonePk: (worldId: string, phoneHash: string): string => `${world(worldId)}PHONE#${phoneHash}`,
  loanOwnerPk: (worldId: string, loanId: string): string => `${world(worldId)}LOAN#${loanId}`,
  chargeOwnerPk: (worldId: string, chargeId: string): string => `${world(worldId)}CHG#${chargeId}`,
  /** `OPC#<network>#<operationCode>`, `REV#<chargeId>`, `RFD#<debitId>`, `TRV#<transferId>`. */
  claimPk: (worldId: string, kind: ClaimKind, naturalKey: string): string => `${world(worldId)}${kind}#${naturalKey}`,

  loanSk: (loanId: string): string => `LOAN#${loanId}`,
  /** Children of a loan; the trailing `#` keeps `L-0010` from matching `L-0010a`. */
  loanChildrenPrefix: (loanId: string): string => `LOAN#${loanId}#`,
  instalmentSk: (loanId: string, number: number): string => `LOAN#${loanId}#INST#${String(number).padStart(2, "0")}`,
  paymentSk: (loanId: string, paymentId: string): string => `LOAN#${loanId}#PAY#${paymentId}`,
  /** Movements sort by their instant in UTC, so items written with any offset still sort in time. */
  movementSk: (atSim: string, movementId: string): string => `WALLET#MOV#${utcSortKey(atSim)}#${movementId}`,
  chargeSk: (chargeId: string): string => `CHG#${chargeId}`,
  transferSk: (transferId: string): string => `TRF#${transferId}`,
  creditNoteSk: (creditNoteId: string): string => `CN#${creditNoteId}`,
  quoteSk: (quoteId: string): string => `QUOTE#${quoteId}`,

  /** Partition of `ByOperationCode`. */
  opCodeKey: (worldId: string, network: string, operationCode: string): string => `${world(worldId)}${network}#${operationCode}`,
  /** Partition of `ByCvu`. */
  cvuKey: (worldId: string, syntheticCvu: string): string => `${world(worldId)}CVU#${syntheticCvu}`,
  /** Attributes of `WorldIndex` (keys only), written on every item. */
  worldIndex: (worldId: string, pk: string, sk: string): { worldIndexKey: string; worldIndexSort: string } => ({
    worldIndexKey: world(worldId),
    worldIndexSort: `${pk}|${sk}`,
  }),
};

export const MOVEMENT_PREFIX = "WALLET#MOV#";

/** `2026-10-06T21:40:00Z` for `2026-10-06T18:40:00-03:00`: second precision, always UTC. */
export function utcSortKey(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`not an instant: ${instant}`);
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}
