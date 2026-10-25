// The evidence of a case (docs/design-brief.md §9 "Caso"; FL-017): the receipt image, shown from a
// `blob:` URL the console made from the bytes it fetched (never the presigned URL itself), the fields
// the reader took from it (the model's reading and the deterministic fallback, side by side, with
// their agreement), and every other piece the code used: the settlement line, the network status,
// the clause. A reading alone never applies a payment: the settlement line does.
import { type ReactNode, useEffect, useState } from "react";
import { formatSimInstant, pesosFromCents } from "@reclamo/shared";
import { Badge } from "../../components/Badge";
import { NETWORK_LABEL } from "../../copy/console-labels";
import { MoneyText } from "../../components/MoneyText";
import { Section } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { isAbortError } from "../../lib/api-error";
import type { CaseView } from "./api";
import { complaintCopy } from "./copy";
import { type EvidenceGroup, type EvidenceView, type ReceiptReading, evidenceGroups, loadEvidenceBlob, readingOf } from "./evidence-model";
import { evidenceRows } from "./evidence-rows";

const text = complaintCopy.evidence;

type ImageState = { readonly status: "loading" } | { readonly status: "ready"; readonly url: string; readonly synthetic: boolean } | { readonly status: "error" };

function ReceiptImage({ complaintId, evidence }: { readonly complaintId: string; readonly evidence: EvidenceView }) {
  const { trpc } = useSession();
  const [state, setState] = useState<ImageState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({ status: "loading" });
    trpc.complaints.evidenceUrl
      .query({ complaintId, evidenceId: evidence.evidenceId }, { signal: controller.signal })
      .then(async (file) => {
        const blob = await loadEvidenceBlob(file, controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl, synthetic: file.kind === "INLINE" });
      })
      .catch((error: unknown) => {
        if (!isAbortError(error) && !controller.signal.aborted) setState({ status: "error" });
      });
    return () => {
      controller.abort();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [trpc, complaintId, evidence.evidenceId]);

  if (state.status === "loading") return <p className="text-xs text-slate">{text.loadingImage}</p>;
  if (state.status === "error") return <p className="text-xs text-danger">{text.imageFailed}</p>;
  return (
    <figure className="space-y-1">
      <img src={state.url} alt={text.imageAlt} className="max-h-96 w-auto max-w-full rounded-md border border-mist bg-white object-contain" />
      {state.synthetic ? <figcaption className="text-xs text-slate">{text.synthetic}</figcaption> : null}
    </figure>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-mist/70 py-1 last:border-b-0">
      <dt className="text-xs text-slate">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-ink">{children}</dd>
    </div>
  );
}

function Reading({ reading }: { readonly reading: ReceiptReading }) {
  const { fields } = reading;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={reading.result === "READ" ? "success" : "warning"}>
          {text.result}: {text.readingResult[reading.result] ?? text.unavailable}
        </Badge>
        <Badge tone={reading.source === "DISAGREE" ? "danger" : "info"}>{text.source[reading.source] ?? reading.source}</Badge>
      </div>
      {fields ? (
        <dl>
          <Row label={text.fields.network}>{NETWORK_LABEL[fields.network] ?? fields.network}</Row>
          <Row label={text.fields.operationCode}>
            <code className="font-mono text-xs">{fields.operationCode}</code>
          </Row>
          <Row label={text.fields.amount}>
            <MoneyText value={pesosFromCents(fields.amount)} />
          </Row>
          <Row label={text.fields.paidAtLocal}>{formatSimInstant(`${fields.paidAtLocal}:00-03:00`)}</Row>
          {fields.payerReference ? <Row label={text.fields.payerReference}>{fields.payerReference}</Row> : null}
        </dl>
      ) : null}
      <dl>
        <Row label={text.bedrock}>{reading.bedrock?.unavailable ? text.unavailable : (text.legibility[reading.bedrock?.legibility ?? ""] ?? "—")}</Row>
        <Row label={text.fallback}>{reading.fallback?.present ? text.fallbackPresent(reading.fallback.agrees) : text.fallbackMissing}</Row>
        {reading.problem ? <Row label={text.problem}>{reading.problem}</Row> : null}
      </dl>
      {reading.disagreement ? (
        <p className="text-xs text-danger">
          {text.disagreement}: {text.bedrock} {reading.disagreement.bedrock.operationCode} {pesosFromCents(reading.disagreement.bedrock.amount).text}
          {reading.disagreement.fallback ? ` · ${text.fallback} ${reading.disagreement.fallback.operationCode} ${pesosFromCents(reading.disagreement.fallback.amount).text}` : ""}
        </p>
      ) : null}
      {reading.suspiciousText ? <p className="text-xs font-semibold text-warning">{text.suspicious}</p> : null}
    </div>
  );
}

function Details({ evidence }: { readonly evidence: EvidenceView }) {
  const rows = evidenceRows(evidence.kind, evidence.details);
  if (rows.length === 0) return null;
  return (
    <dl>
      {rows.map((row) => (
        <Row key={row.label} label={row.label}>
          {row.code ? <code className="break-all font-mono text-xs">{row.value}</code> : row.value}
        </Row>
      ))}
    </dl>
  );
}

function EvidenceBody({ complaintId, evidence }: { readonly complaintId: string; readonly evidence: EvidenceView }) {
  const reading = readingOf(evidence);
  if (evidence.kind === "RECEIPT_IMAGE") return <ReceiptImage complaintId={complaintId} evidence={evidence} />;
  return reading ? <Reading reading={reading} /> : <Details evidence={evidence} />;
}

function EvidenceCard({ complaintId, group }: { readonly complaintId: string; readonly group: EvidenceGroup }) {
  const { evidence, readings } = group;
  return (
    <article aria-label={text.kind[evidence.kind]} className="space-y-2 rounded-card border border-mist bg-paper p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate">{text.kind[evidence.kind]}</p>
        <span className="text-xs text-slate">{formatSimInstant(evidence.atSim)}</span>
      </header>
      <EvidenceBody complaintId={complaintId} evidence={evidence} />
      {readings.map((reading) => (
        <section key={reading.evidenceId} aria-label={text.kind[reading.kind]} className="space-y-2 border-t border-mist pt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">{text.kind[reading.kind]}</p>
          <EvidenceBody complaintId={complaintId} evidence={reading} />
        </section>
      ))}
    </article>
  );
}

export function EvidenceSection({ view }: { readonly view: CaseView }) {
  return (
    <Section id="evidence" title={complaintCopy.sections.evidence} description={text.lead}>
      {view.evidence.length === 0 ? (
        <p className="text-sm text-slate">{text.empty}</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {evidenceGroups(view.evidence).map((group) => (
            <EvidenceCard key={group.evidence.evidenceId} complaintId={view.complaint.complaintId} group={group} />
          ))}
        </div>
      )}
    </Section>
  );
}
