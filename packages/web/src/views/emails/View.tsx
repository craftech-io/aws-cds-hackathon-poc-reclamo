// Emails (docs/design-brief.md §9; FL-093): every email the principal's world sent, newest first, and
// the one chosen exactly as it left: headers, HTML (sandboxed), text, attachments, SES events and the
// SHA-256 of the stored `.eml` next to the one recorded at send time. Only the world's own emails: the
// BFF lists them from the principal's world and never returns an address in clear. Read-only.
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import type { Column } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { useRemote } from "../../lib/use-remote";
import { EmailDetailPanel } from "./EmailDetail";
import { emailsCopy } from "./copy";
import { type EmailRef, type EmailSummary, kindText, proofText, proofTone, refOf, sentText } from "./emails-model";

const PAGE = 50;
const MAX = 200;
const cols = emailsCopy.columns;

const COLUMNS: readonly Column<EmailSummary>[] = [
  { id: "sent", header: cols.sent, cell: (email) => <span className="whitespace-nowrap text-xs text-slate">{sentText(email)}</span> },
  {
    id: "subject",
    header: cols.subject,
    cell: (email) => (
      <span className="block min-w-48">
        <span className="block font-medium text-ink">{email.subject}</span>
        <span className="block text-xs text-slate">
          {kindText(email.kind)} · {cols.attachments}: {email.attachments}
        </span>
      </span>
    ),
  },
  { id: "proof", header: cols.proof, cell: (email) => <Badge tone={proofTone(email.deliveryProof)}>{proofText(email.deliveryProof)}</Badge> },
];

export function EmailsView() {
  const { trpc } = useSession();
  const view = consoleCopy.views.emails;
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<EmailRef | undefined>(undefined);
  const list = useRemote(`emails.list:${limit}`, (signal) => trpc.emails.list.query({ limit }, { signal }));

  return (
    <div className="space-y-6">
      <PageHeader title={view.title} description={view.description} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-label={emailsCopy.list.title} className="min-w-0 space-y-3">
          <RemoteBlock state={list.state} onRetry={list.reload}>
            {(page) => (
              <DataTable
                columns={COLUMNS}
                rows={page.emails}
                keyOf={(email) => email.mailId}
                caption={emailsCopy.list.caption}
                emptyTitle={emailsCopy.list.empty}
                emptyLead={emailsCopy.list.emptyLead}
                onRowClick={(email) => setSelected(refOf(email))}
                {...(selected !== undefined ? { activeKey: selected.mailId } : {})}
                {...(page.cursor !== null && limit < MAX
                  ? {
                      footer: (
                        <Button variant="secondary" onClick={() => setLimit((current) => Math.min(MAX, current + PAGE))}>
                          {emailsCopy.list.more}
                        </Button>
                      ),
                    }
                  : {})}
              />
            )}
          </RemoteBlock>
        </section>
        <div className="min-w-0">
          {selected === undefined ? (
            <p className="rounded-card border border-dashed border-mist bg-white px-6 py-10 text-center text-sm text-slate">{emailsCopy.detail.none}</p>
          ) : (
            <EmailDetailPanel key={selected.mailId} email={selected} onClose={() => setSelected(undefined)} />
          )}
        </div>
      </div>
    </div>
  );
}
