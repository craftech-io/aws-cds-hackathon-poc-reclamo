// The read-only half of the customer file (docs/design-brief.md §9 "Cliente"): who the customer is
// (masked as the core hands it out), the wallet, the loans with their instalments, the operations of
// the last 60 days, this world's complaints of the customer and the identity challenge, which a
// person may unlock (audited).
import type { ReactNode } from "react";
import { COMPLAINT_STATUS_LABEL, COMPLAINT_TYPE_LABEL, PDF_INSTALMENT_STATUS, capitalize } from "@reclamo/bff/copy/index";
import { formatDate, formatPesos, formatSimInstant, pesosFromCents } from "@reclamo/shared";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { MoneyText } from "../../components/MoneyText";
import { Section } from "../../components/Section";
import { type Column, Table } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { Link } from "../../lib/router";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useAction } from "../../lib/use-remote";
import { complaintPath } from "../complaint/paths";
import { customerCopy } from "./copy";

export type CustomerFile = RouterOutputs["customers"]["get"];
type Loan = CustomerFile["customer"]["loans"][number];
type Instalment = Loan["instalments"][number];
type Operation = CustomerFile["operations"][number];

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

function whatsappText(consent: CustomerFile["customer"]["whatsapp"]): string {
  if (consent.optedOut) return customerCopy.whatsapp.optedOut;
  return consent.optedIn ? customerCopy.whatsapp.optedIn : customerCopy.whatsapp.none;
}

export function ProfileSection({ file }: { readonly file: CustomerFile }) {
  const { customer, conversation } = file;
  return (
    <Section id="profile" title={customerCopy.sections.profile} description={customerCopy.synthetic}>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={customerCopy.profile.document}>
          {customer.document.type} {customer.document.numberMasked}
        </Field>
        <Field label={customerCopy.profile.phone}>{customer.phoneMasked}</Field>
        <Field label={customerCopy.profile.email}>{customer.emailMasked}</Field>
        <Field label={customerCopy.profile.whatsapp}>{whatsappText(customer.whatsapp)}</Field>
        <Field label={customerCopy.profile.account}>{customerCopy.status.account[customer.account.status]}</Field>
        <Field label={customerCopy.profile.conversation}>{conversation ? customerCopy.control[conversation.control] : "—"}</Field>
      </dl>
    </Section>
  );
}

export function WalletSection({ file }: { readonly file: CustomerFile }) {
  const { wallet } = file.customer;
  return (
    <Section id="wallet" title={customerCopy.sections.wallet}>
      <dl className="grid gap-4 sm:grid-cols-3">
        <Field label={customerCopy.wallet.balance}>
          <MoneyText value={wallet.balanceMoney} />
        </Field>
        <Field label={customerCopy.wallet.cvu}>{wallet.cvuMasked}</Field>
        <Field label={customerCopy.wallet.frozen}>{wallet.outgoingFrozen ? <Badge tone="warning">{customerCopy.wallet.frozen}</Badge> : customerCopy.wallet.notFrozen}</Field>
      </dl>
    </Section>
  );
}

const INSTALMENT_COLUMNS: readonly Column<Instalment>[] = [
  { id: "number", header: customerCopy.loans.number, cell: (row) => row.number },
  { id: "due", header: customerCopy.loans.due, cell: (row) => formatDate(row.dueDate) },
  { id: "amount", header: customerCopy.loans.amount, align: "right", cell: (row) => <MoneyText value={pesosFromCents(row.amount)} /> },
  { id: "left", header: customerCopy.loans.left, align: "right", cell: (row) => <MoneyText value={pesosFromCents(row.outstanding)} /> },
  { id: "status", header: customerCopy.loans.status, cell: (row) => <Badge tone={row.status === "OVERDUE" ? "danger" : row.status === "PAID" ? "success" : "neutral"}>{PDF_INSTALMENT_STATUS[row.status]}</Badge> },
];

export function LoansSection({ file }: { readonly file: CustomerFile }) {
  const { loans } = file.customer;
  return (
    <Section id="loans" title={customerCopy.sections.loans}>
      {loans.length === 0 ? <p className="text-sm text-slate">{customerCopy.loans.none}</p> : null}
      <div className="space-y-5">
        {loans.map((loan) => (
          <div key={loan.loanId} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-pine">{loan.label}</p>
              <Badge tone={loan.status === "IN_ARREARS" ? "danger" : "neutral"}>{customerCopy.status.loan[loan.status]}</Badge>
              <span className="text-xs text-slate">{customerCopy.loans.instalments(loan.instalments.filter((row) => row.status === "PAID").length, loan.instalments.length)}</span>
              <span className="text-xs text-slate">
                {customerCopy.loans.outstanding}: <MoneyText value={loan.outstandingMoney} />
              </span>
            </div>
            <Table variant="inset" columns={INSTALMENT_COLUMNS} rows={loan.instalments} keyOf={(row) => String(row.number)} caption={customerCopy.loans.caption(loan.label)} emptyTitle={customerCopy.loans.none} />
          </div>
        ))}
      </div>
    </Section>
  );
}

const OPERATION_COLUMNS: readonly Column<Operation>[] = [
  { id: "at", header: customerCopy.operations.at, cell: (row) => <span className="whitespace-nowrap text-xs">{formatSimInstant(row.atSim)}</span> },
  { id: "description", header: customerCopy.operations.description, cell: (row) => row.description },
  {
    id: "amount",
    header: customerCopy.operations.amount,
    align: "right",
    cell: (row) => <MoneyText value={{ amount: (row.direction === "OUT" ? -row.amount : row.amount) / 100, text: `${row.direction === "OUT" ? "-" : ""}${formatPesos(row.amount)}` }} />,
  },
  { id: "status", header: customerCopy.operations.status, cell: (row) => customerCopy.status.operation[row.status] },
];

export function OperationsSection({ file }: { readonly file: CustomerFile }) {
  return (
    <Section id="operations" title={customerCopy.sections.operations} description={file.operationsTruncated ? customerCopy.operations.truncated : undefined}>
      <Table variant="inset" columns={OPERATION_COLUMNS} rows={file.operations} keyOf={(row) => row.operationId} caption={customerCopy.operations.caption} emptyTitle={customerCopy.operations.none} />
    </Section>
  );
}

export function ComplaintsSection({ file }: { readonly file: CustomerFile }) {
  return (
    <Section id="complaints" title={customerCopy.sections.complaints}>
      {file.complaints.length === 0 ? (
        <p className="text-sm text-slate">{customerCopy.complaints.none}</p>
      ) : (
        <ul className="divide-y divide-mist">
          {file.complaints.map((complaint) => (
            <li key={complaint.complaintId} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <Link to={complaintPath(complaint.complaintId)} className="font-mono font-semibold text-seal-deep underline">
                {complaint.complaintNumber}
              </Link>
              <span className="text-ink">{capitalize(COMPLAINT_TYPE_LABEL[complaint.type])}</span>
              <Badge tone={complaint.open ? "info" : "neutral"}>{COMPLAINT_STATUS_LABEL[complaint.status]}</Badge>
              <span className="text-xs text-slate">{complaint.deadlineText}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function ChallengeSection({ file, onUnlocked }: { readonly file: CustomerFile; readonly onUnlocked: () => void }) {
  const { trpc } = useSession();
  const unlock = useAction(async () => {
    const answer = await trpc.customers.unlockChallenge.mutate({ customerId: file.customer.customerId });
    onUnlocked();
    return answer;
  });
  const { challenge } = file;
  const counted = challenge.failures > 0;
  return (
    <Section id="challenge" title={customerCopy.sections.challenge} description={customerCopy.challenge.audited}>
      <div className="space-y-3">
        <p className={`text-sm ${challenge.locked ? "font-semibold text-danger" : "text-ink"}`}>
          {challenge.locked ? customerCopy.challenge.locked : counted ? customerCopy.challenge.counted(challenge.failures, challenge.attemptsLeft) : customerCopy.challenge.clear}
        </p>
        {challenge.locked || counted ? (
          <Button variant="secondary" disabled={unlock.state.status === "running"} onClick={() => void unlock.run(undefined)}>
            {customerCopy.challenge.unlock}
          </Button>
        ) : null}
        {unlock.state.status === "done" ? <Callout tone="success">{unlock.state.data.cleared ? customerCopy.challenge.unlocked : customerCopy.challenge.nothing}</Callout> : null}
        {unlock.state.status === "error" ? <ApiErrorNotice error={unlock.state.error} /> : null}
      </div>
    </Section>
  );
}
