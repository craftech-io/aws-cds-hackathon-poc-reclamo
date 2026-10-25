// The composer of the customer file (docs/design-brief.md §7 "Momento de la demo"; FL-064): a person
// picks the message kind and the channel and sends; `customers.compose` only ENQUEUES it and the gate
// decides in the worker, for a person exactly as for the agent. A "Recordatorio de mora" by WhatsApp
// lands on the tape in red with its permitted paths (GateTrail), never on the customer's phone.
import { useState } from "react";
import type { Channel, MessageKind } from "@reclamo/shared";
import { MESSAGE_KIND_GLOSS, MESSAGE_KIND_LABEL, capitalize, COMPLAINT_TYPE_LABEL } from "@reclamo/bff/copy/index";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { SelectField } from "../../components/SelectField";
import { useSession } from "../../context/SessionContext";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useAction } from "../../lib/use-remote";
import { customerCopy } from "./copy";
import { GateTrail } from "./GateTrail";

type CustomerFile = RouterOutputs["customers"]["get"];
type Queued = RouterOutputs["customers"]["compose"];

const CHANNELS: readonly Channel[] = ["WHATSAPP", "EMAIL"];
const NO_COMPLAINT = "NONE";

interface Draft {
  readonly kind: MessageKind;
  readonly channel: Channel;
  readonly text: string;
  readonly subject: string;
  readonly complaintId: string;
}

function draftFor(kind: MessageKind): string {
  return customerCopy.composer.drafts[kind] ?? "";
}

export function Composer({ file, onSent }: { readonly file: CustomerFile; readonly onSent: () => void }) {
  const { trpc } = useSession();
  const kinds = file.composeKinds;
  const first = kinds[0] ?? "OPERATOR_MESSAGE";
  const [draft, setDraft] = useState<Draft>({ kind: first, channel: "WHATSAPP", text: draftFor(first), subject: "", complaintId: NO_COMPLAINT });
  const [sent, setSent] = useState<Queued | undefined>(undefined);
  const send = useAction((input: Draft) =>
    trpc.customers.compose.mutate({
      customerId: file.customer.customerId,
      kind: input.kind,
      channel: input.channel,
      text: input.text.trim(),
      ...(input.channel === "EMAIL" && input.subject.trim() !== "" ? { subject: input.subject.trim() } : {}),
      ...(input.complaintId === NO_COMPLAINT ? {} : { complaintId: input.complaintId }),
    }),
  );

  const pickKind = (kind: MessageKind) => setDraft((current) => ({ ...current, kind, text: current.text === "" || current.text === draftFor(current.kind) ? draftFor(kind) : current.text }));
  const submit = async () => {
    setSent(undefined);
    const queued = await send.run(draft);
    if (queued) setSent(queued);
  };
  const openComplaints = file.complaints.filter((complaint) => complaint.open);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate">{customerCopy.composer.lead}</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.text.trim() !== "") void submit();
        }}
      >
        <div className="flex flex-wrap gap-3">
          <SelectField<MessageKind>
            label={customerCopy.composer.kind}
            value={draft.kind}
            options={kinds.map((kind) => ({ value: kind, label: `${MESSAGE_KIND_LABEL[kind]} · ${MESSAGE_KIND_GLOSS[kind]}` }))}
            onChange={pickKind}
          />
          <SelectField<Channel> label={customerCopy.composer.channel} value={draft.channel} options={CHANNELS.map((channel) => ({ value: channel, label: customerCopy.channel[channel] }))} onChange={(channel) => setDraft((current) => ({ ...current, channel }))} />
          {openComplaints.length > 0 ? (
            <SelectField<string>
              label={customerCopy.composer.complaint}
              value={draft.complaintId}
              options={[{ value: NO_COMPLAINT, label: customerCopy.composer.noComplaint }, ...openComplaints.map((complaint) => ({ value: complaint.complaintId, label: `${complaint.complaintNumber} · ${capitalize(COMPLAINT_TYPE_LABEL[complaint.type])}` }))]}
              onChange={(complaintId) => setDraft((current) => ({ ...current, complaintId }))}
            />
          ) : null}
        </div>
        {draft.channel === "EMAIL" ? (
          <label className={LABEL_CLASS}>
            {customerCopy.composer.subject}
            <input className={FIELD_CLASS} maxLength={200} value={draft.subject} onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))} />
          </label>
        ) : null}
        <label className={LABEL_CLASS}>
          {customerCopy.composer.text}
          <textarea className={FIELD_CLASS} rows={3} maxLength={900} required value={draft.text} onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))} />
        </label>
        <Button type="submit" disabled={send.state.status === "running" || draft.text.trim() === ""}>
          {customerCopy.composer.send}
        </Button>
      </form>
      {send.state.status === "error" ? <ApiErrorNotice error={send.state.error} /> : null}
      {sent ? (
        <div className="space-y-2">
          <p className="text-xs text-slate">{customerCopy.composer.queued}</p>
          <GateTrail key={sent.messageId} messageId={sent.messageId} customerId={file.customer.customerId} onChange={onSent} />
        </div>
      ) : null}
    </div>
  );
}
