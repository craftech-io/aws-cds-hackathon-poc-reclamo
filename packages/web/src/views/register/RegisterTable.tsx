// The entries of one register page: the complaint register (every event of every number, with the
// minimum data of the filing) or the refund register (reversals and refunds with their amounts),
// each with its `seq` and the start of its hash so a row can be matched against an export.
import { Table, type Column } from "../../components/Table";
import { registerCopy } from "./copy";
import { type RefundRow, type RegisterPage, type RegisterRow, amountText, isRefundRow, isRegisterRow, registerDetail, shortHash, simText } from "./register-model";

const cols = registerCopy.columns;

function HashCell({ hash }: { readonly hash: string }) {
  return (
    <code className="font-mono text-xs text-slate" title={hash}>
      {shortHash(hash)}
    </code>
  );
}

const SEQ: Column<{ readonly seq: number }> = { id: "seq", header: cols.seq, cell: (row) => <span className="tabular-nums">{row.seq}</span>, align: "right" };
const AT: Column<{ readonly atSim: string }> = { id: "at", header: cols.at, cell: (row) => <span className="whitespace-nowrap text-xs text-slate">{simText(row.atSim)}</span> };
const HASH: Column<{ readonly hash: string }> = { id: "hash", header: cols.hash, cell: (row) => <HashCell hash={row.hash} /> };

const REGISTER_COLUMNS: readonly Column<RegisterRow>[] = [
  SEQ,
  AT,
  { id: "number", header: cols.number, cell: (row) => <span className="whitespace-nowrap font-mono text-sm font-semibold text-seal-deep">{row.complaintNumber}</span> },
  { id: "event", header: cols.event, cell: (row) => registerCopy.events[row.eventType] },
  {
    id: "detail",
    header: cols.detail,
    cell: (row) => (
      <span className="text-sm text-ink">
        {registerDetail(row)}
        {row.bodySha256 ? (
          <span className="block text-xs text-slate">
            {registerCopy.answerHash}: <HashCell hash={row.bodySha256} />
          </span>
        ) : null}
      </span>
    ),
  },
  { id: "channel", header: cols.channel, cell: (row) => (row.channel === "WHATSAPP" ? "WhatsApp" : "Email") },
  { id: "origin", header: cols.origin, cell: (row) => registerCopy.origins[row.origin] ?? row.origin },
  HASH,
];

const REFUND_COLUMNS: readonly Column<RefundRow>[] = [
  SEQ,
  AT,
  { id: "number", header: cols.number, cell: (row) => <span className="whitespace-nowrap font-mono text-sm">{row.complaintNumber ?? "—"}</span> },
  { id: "cause", header: cols.cause, cell: (row) => registerCopy.causes[row.cause] },
  { id: "product", header: cols.product, cell: (row) => row.product },
  { id: "amount", header: cols.amount, cell: (row) => amountText(row.amountCents), align: "right" },
  { id: "interest", header: cols.interest, cell: (row) => amountText(row.interestCents), align: "right" },
  { id: "creditNote", header: cols.creditNote, cell: (row) => row.creditNoteId ?? "—" },
  HASH,
];

export function RegisterTable({ page }: { readonly page: RegisterPage }) {
  if (page.chain === "RRI") {
    return <Table columns={REFUND_COLUMNS} rows={page.entries.filter(isRefundRow)} keyOf={(row) => String(row.seq)} emptyTitle={registerCopy.list.empty} caption={registerCopy.list.caption} />;
  }
  return <Table columns={REGISTER_COLUMNS} rows={page.entries.filter(isRegisterRow)} keyOf={(row) => String(row.seq)} emptyTitle={registerCopy.list.empty} caption={registerCopy.list.caption} />;
}

