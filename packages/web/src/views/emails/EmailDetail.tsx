// One email exactly as it left (FL-093): the headers (recipient masked), the integrity of the stored
// `.eml`, the attached PDFs (fetched to `blob:` and saved) and the SES events (the proof, before the long
// previews), then the HTML in an `iframe sandbox` without scripts (`srcdoc`: no network, no access to the
// console) and the plain text.
import { formatSimInstant } from "@reclamo/shared";
import type { ReactNode } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useSession } from "../../context/SessionContext";
import { useAction, useRemoteInput } from "../../lib/use-remote";
import { shortHash } from "../register/register-model";
import { emailsCopy } from "./copy";
import { downloadPresigned } from "./download";
import { type EmailDetail as Detail, type EmailRef, attachmentIndexes, attachmentName, eventText, integrityVerdict, kindText, proofText, proofTone, realText } from "./emails-model";

const copy = emailsCopy.detail;

function Block({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate">{title}</h3>
      {children}
    </section>
  );
}

function Header({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
      <dt className="font-semibold text-slate">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

function Integrity({ detail }: { readonly detail: Detail }) {
  const verdict = integrityVerdict(detail.integrity);
  const { sha256, recorded, bytes } = detail.integrity;
  return (
    <Block title={copy.integrity}>
      <p className="text-xs text-slate">{copy.integrityLead}</p>
      <dl className="space-y-1">
        <Header label={copy.shaNow}>
          <code data-eml-sha256={sha256 ?? ""} className="break-all font-mono text-xs">
            {sha256 ?? copy.missing}
          </code>
          {bytes !== null ? <span className="ml-2 text-xs text-slate">{copy.bytes(bytes)}</span> : null}
        </Header>
        <Header label={copy.shaRecorded}>
          <code className="break-all font-mono text-xs">{recorded ?? "—"}</code>
        </Header>
      </dl>
      <Badge tone={verdict === "matches" ? "success" : "danger"}>{verdict === "matches" ? copy.matches : verdict === "differs" ? copy.differs : copy.missing}</Badge>
    </Block>
  );
}

function Attachment({ email, index, detail }: { readonly email: EmailRef; readonly index: number; readonly detail: Detail }) {
  const { trpc } = useSession();
  const name = attachmentName(detail, index);
  const sha = detail.view?.attachments[index]?.sha256;
  const download = useAction<void, void>(async () => {
    const link = await trpc.emails.attachmentUrl.query({ ...email, index });
    await downloadPresigned(link.url, link.contentType, name);
  });
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-mist px-3 py-2">
      <span className="font-mono text-sm text-ink">{name}</span>
      {sha !== undefined ? (
        <code className="font-mono text-xs text-slate" title={sha}>
          {shortHash(sha)}
        </code>
      ) : null}
      <Button variant="secondary" onClick={() => void download.run()} disabled={download.state.status === "running"}>
        {download.state.status === "running" ? copy.downloading : copy.download}
      </Button>
      {download.state.status === "error" ? <ApiErrorNotice error={download.state.error} /> : null}
    </li>
  );
}

function Body({ email, detail }: { readonly email: EmailRef; readonly detail: Detail }) {
  const view = detail.view;
  const indexes = attachmentIndexes(detail);
  return (
    <article aria-label={copy.title} className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-lg font-semibold text-pine">{detail.subject}</h2>
        <Badge tone={proofTone(detail.deliveryProof)}>{proofText(detail.deliveryProof)}</Badge>
      </div>
      <Block title={copy.headers}>
        <dl className="space-y-1">
          <Header label={copy.from}>{view?.headers.from ?? "—"}</Header>
          <Header label={copy.to}>{detail.toMasked}</Header>
          <Header label={copy.subject}>{detail.subject}</Header>
          <Header label={copy.date}>{formatSimInstant(detail.sentAtSim)}</Header>
          {detail.sentAtReal !== null ? <Header label={copy.dateReal}>{realText(detail.sentAtReal)}</Header> : null}
          <Header label={emailsCopy.columns.kind}>{kindText(detail.kind)}</Header>
          {detail.complaintId !== null ? <Header label={copy.complaint}>{detail.complaintId}</Header> : null}
        </dl>
      </Block>
      <Integrity detail={detail} />
      <Block title={copy.attachments}>
        {indexes.length === 0 ? (
          <p className="text-sm text-slate">{copy.noAttachments}</p>
        ) : (
          <ul className="space-y-2">
            {indexes.map((index) => (
              <Attachment key={index} email={email} index={index} detail={detail} />
            ))}
          </ul>
        )}
      </Block>
      <Block title={copy.events}>
        <p className="text-xs text-slate">{copy.eventsLead}</p>
        {detail.events.length === 0 ? (
          <p className="text-sm text-slate">{copy.noEvents}</p>
        ) : (
          <ol className="space-y-1 text-sm">
            {detail.events.map((event, position) => (
              <li key={`${event.type}-${position}`} className="flex flex-wrap gap-3">
                <span className="tabular-nums text-xs text-slate">{realText(event.atReal)}</span>
                <span className="text-ink">{eventText(event.type)}</span>
              </li>
            ))}
          </ol>
        )}
      </Block>
      {view === null ? (
        <p role="alert" className="text-sm text-danger">
          {copy.noView}
        </p>
      ) : (
        <>
          <Block title={copy.html}>
            <p className="text-xs text-slate">{copy.htmlNote}</p>
            <iframe title={copy.htmlFrame} sandbox="" srcDoc={view.html} referrerPolicy="no-referrer" className="h-96 w-full rounded-md border border-mist bg-white" />
          </Block>
          <Block title={copy.text}>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-mist bg-paper p-4 font-sans text-sm text-ink">{view.text}</pre>
          </Block>
        </>
      )}
    </article>
  );
}

export function EmailDetailPanel({ email, onClose }: { readonly email: EmailRef; readonly onClose: () => void }) {
  const { trpc } = useSession();
  const detail = useRemoteInput("emails.get", email, (input, signal) => trpc.emails.get.query(input, { signal }));
  return (
    <div className="space-y-4 rounded-card border border-mist bg-white p-5 shadow-card">
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          {copy.close}
        </Button>
      </div>
      <RemoteBlock state={detail.state} onRetry={detail.reload}>
        {(data) => <Body email={email} detail={data} />}
      </RemoteBlock>
    </div>
  );
}
