// `/app/customers/:id` (docs/design-brief.md §9 "Cliente"; FL-064, FL-065, FL-066): the customer's
// file read from the lender core (read only) and the composer, where the "Recordatorio de mora" by
// WhatsApp is tried and the same gate that fences the agent stops the person (red on the tape, with
// the formal notice by email and the human queue as the permitted paths).
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { Link, useRouter } from "../../lib/router";
import { useRemoteInput } from "../../lib/use-remote";
import { customerIdOf } from "../complaint/paths";
import { CONSOLE_HOME } from "../../routes";
import { ChallengeSection, ComplaintsSection, LoansSection, OperationsSection, ProfileSection, WalletSection } from "./AccountSections";
import { Composer } from "./Composer";
import { customerCopy } from "./copy";

function NotFound() {
  return (
    <Callout tone="warning" title={customerCopy.notFound}>
      <Link to={CONSOLE_HOME} className="font-semibold text-seal-deep underline">
        {customerCopy.backToInbox}
      </Link>
    </Callout>
  );
}

export function CustomerView() {
  const { trpc } = useSession();
  const { path } = useRouter();
  const customerId = customerIdOf(path);
  const remote = useRemoteInput("customers.get", customerId === undefined ? undefined : { customerId }, (input, signal) => trpc.customers.get.query(input, { signal }));

  return (
    <div className="space-y-4">
      <RemoteBlock state={remote.state} onRetry={remote.reload} idle={<NotFound />}>
        {(file) => (
          <div className="space-y-4">
            <PageHeader title={`${file.customer.firstName} ${file.customer.lastName}`} description={`${copy.views.customer.title} · ${customerCopy.lead}`} />
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
              <div className="min-w-0 space-y-4">
                <ProfileSection file={file} />
                <WalletSection file={file} />
                <LoansSection file={file} />
                <OperationsSection file={file} />
              </div>
              <div className="min-w-0 space-y-4">
                <Section id="composer" title={customerCopy.sections.composer}>
                  <Composer file={file} onSent={remote.reload} />
                </Section>
                <ComplaintsSection file={file} />
                <ChallengeSection file={file} onUnlocked={remote.reload} />
              </div>
            </div>
          </div>
        )}
      </RemoteBlock>
    </div>
  );
}
