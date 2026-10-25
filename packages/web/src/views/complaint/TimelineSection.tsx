// The unified timeline of a case (docs/design-brief.md §9 "Caso"): WhatsApp messages (a blocked
// attempt in red, with the collection categories the lexicon found), emails with their delivery
// proof, the tape's decisions (red for a block, with the English gloss and, under a person's own
// block, its permitted paths), tool calls and console actions, register entries, milestones, status
// changes and notes, in simulated time; plus what the world is still waiting for.
import type { ReactNode } from "react";
import { type Reroute, formatSimInstant } from "@reclamo/shared";
import { COMPLAINT_STATUS_LABEL, MESSAGE_KIND_LABEL, REROUTE_GLOSS, REROUTE_LABEL, TEMPLATE_GLOSS, TemplateName } from "@reclamo/bff/copy/index";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { mediaCopy, scanText } from "../../copy/media";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Button } from "../../components/Button";
import { RuleChips } from "../../components/RuleChips";
import { Section } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { useAction } from "../../lib/use-remote";
import { offeredRoutes } from "../customer/gate-model";
import { TapeBanner } from "../customer/TapeBanner";
import { inboxCopy } from "../inbox/copy";
import { actionText, outcomeText, timerKindText } from "./action-copy";
import type { CaseTimeline, TimelineItem } from "./api";
import { complaintCopy } from "./copy";
import { type TapeItem, actorKindOf, bannerEntryOf, isOpenOperatorBlock, itemKey, lexiconLabels, reroutedBlocks, shortHash } from "./timeline-model";

const text = complaintCopy.timeline;

const TYPE_TONE: Readonly<Record<TimelineItem["type"], BadgeTone>> = { MESSAGE: "info", EMAIL: "brand", TAPE: "neutral", ACTION: "neutral", MILESTONE: "warning", REGISTER: "success", STATUS: "neutral", NOTE: "neutral" };

function actorText(actor: string | null, direction?: "IN" | "OUT"): string {
  return text.actor[actorKindOf(actor, direction)];
}

function MessageBody({ item }: { readonly item: Extract<TimelineItem, { type: "MESSAGE" }> }) {
  const blocked = item.status === "BLOCKED";
  const categories = blocked ? lexiconLabels(item.body) : [];
  const template = TemplateName.safeParse(item.templateName);
  return (
    <div className={blocked ? "rounded-md border border-danger bg-danger-soft px-3 py-2" : ""}>
      <p className="text-xs text-slate">
        {item.direction === "IN" ? text.inbound : `${text.outbound} · ${actorText(item.sender, item.direction)}`}
        {item.kind ? ` · ${MESSAGE_KIND_LABEL[item.kind]}` : ""}
        {item.templateName ? ` · ${text.template} ${item.templateName}` : ""}
      </p>
      {item.media ? (
        <p className="mt-1 inline-block rounded bg-paper px-2 py-1 text-xs text-pine">
          {mediaCopy.receipt} · {scanText(item.media.scan)}
        </p>
      ) : null}
      {item.body ? <p className="mt-1 whitespace-pre-line text-sm text-ink">{item.body}</p> : null}
      {template.success ? (
        <p lang="en" className="mt-0.5 text-xs italic text-slate">
          EN: {TEMPLATE_GLOSS[template.data]}
        </p>
      ) : null}
      {blocked ? <p className="mt-1 text-xs font-semibold text-danger">{text.blockedAttempt}</p> : null}
      {categories.length > 0 ? (
        <p className="mt-1 text-xs text-danger">
          {text.lexicon}: {categories.join(" · ")}
        </p>
      ) : null}
      {item.disclosure ? <p className="mt-1 text-xs text-slate">{text.disclosure}</p> : null}
    </div>
  );
}

function EmailBody({ item }: { readonly item: Extract<TimelineItem, { type: "EMAIL" }> }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium text-ink">{item.subject}</p>
      <p className="text-xs text-slate">
        {MESSAGE_KIND_LABEL[item.kind]} · {item.toMasked}
      </p>
      <p className="text-xs">
        {text.delivery}: {item.deliveryProof ? <Badge tone={item.deliveryProof === "DELIVERED" ? "success" : item.deliveryProof === "SENT" ? "info" : "danger"}>{item.deliveryProof}</Badge> : <span className="text-slate">{text.noDelivery}</span>}
      </p>
      {item.attachments.length > 0 ? (
        <p className="text-xs text-slate">
          {text.attachments}: {item.attachments.map((attachment) => `${attachment.docKind} (${shortHash(attachment.sha256)})`).join(" · ")}
        </p>
      ) : null}
      {item.rawSha256 ? (
        <p className="text-xs text-slate">
          {text.rawHash}: <code className="font-mono">{shortHash(item.rawSha256)}</code>
        </p>
      ) : null}
    </div>
  );
}

interface RerouteProps {
  readonly item: TapeItem;
  readonly complaintId: string;
  readonly customerId: string;
  readonly onChange: () => void;
}

function RerouteButtons({ item, complaintId, customerId, onChange }: RerouteProps) {
  const { trpc } = useSession();
  const reroute = useAction(async (route: Reroute) => {
    const answer = await trpc.conversation.reroute.mutate({ tapeId: item.tapeId, route, customerId });
    onChange();
    return answer;
  });
  const routes = offeredRoutes({ ruleIds: item.ruleIds, kind: item.kind, sender: item.sender, complaintId, rerouteOf: undefined });
  if (routes.length === 0) return null;
  return (
    <>
      {routes.map((route) => (
        <Button key={route} variant={route === "FORMAL_EMAIL" ? "primary" : "secondary"} disabled={reroute.state.status === "running"} onClick={() => void reroute.run(route)}>
          {REROUTE_LABEL[route]} · {REROUTE_GLOSS[route]}
        </Button>
      ))}
      {reroute.state.status === "error" ? <ApiErrorNotice error={reroute.state.error} /> : null}
    </>
  );
}

interface BodyProps {
  readonly item: TimelineItem;
  readonly answered: ReadonlySet<string>;
  readonly complaintId: string;
  readonly customerId: string;
  readonly canWork: boolean;
  readonly onChange: () => void;
}

function ItemBody({ item, answered, complaintId, customerId, canWork, onChange }: BodyProps): ReactNode {
  switch (item.type) {
    case "MESSAGE":
      return <MessageBody item={item} />;
    case "EMAIL":
      return <EmailBody item={item} />;
    case "TAPE":
      return (
        <TapeBanner entry={bannerEntryOf(item)}>
          {canWork && isOpenOperatorBlock(item, answered) ? <RerouteButtons item={item} complaintId={complaintId} customerId={customerId} onChange={onChange} /> : null}
        </TapeBanner>
      );
    case "ACTION":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-pine" title={item.action}>
            {actionText(item.action)}
          </span>
          <span className="text-xs text-slate">{actorText(item.actor)}</span>
          {outcomeText(item.outcome) ? <Badge>{outcomeText(item.outcome)}</Badge> : null}
          <RuleChips ids={item.ruleIds} />
        </div>
      );
    case "MILESTONE":
      return (
        <p className="text-sm text-ink">
          {item.milestone && item.milestone in inboxCopy.milestone ? inboxCopy.milestone[item.milestone as keyof typeof inboxCopy.milestone] : timerKindText(item.kind)}
          {" · "}
          <span className="text-xs text-slate">{text.timerStatus[item.status] ?? item.status}</span>
        </p>
      );
    case "REGISTER":
      return (
        <p className="text-sm text-ink">
          {text.registerEntry(item.seq, text.registerEvent[item.eventType] ?? item.eventType)}
          {item.status ? ` · ${COMPLAINT_STATUS_LABEL[item.status]}` : ""} · <code className="font-mono text-xs text-slate">{shortHash(item.hash)}</code>
        </p>
      );
    case "STATUS":
      return <p className="text-sm text-ink">{text.statusChange(item.from ? COMPLAINT_STATUS_LABEL[item.from] : "—", COMPLAINT_STATUS_LABEL[item.to])}</p>;
    case "NOTE":
      return (
        <div className="text-sm">
          <p className="text-xs text-slate">
            {text.noteKind[item.kind] ?? item.kind} · {actorText(item.author)}
            {item.task ? ` · ${text.task[item.task.status]}` : ""}
          </p>
          <p className="mt-1 whitespace-pre-line text-ink">{item.text}</p>
        </div>
      );
  }
}

interface TimelineSectionProps {
  readonly timeline: CaseTimeline;
  readonly customerId: string;
  readonly canWork: boolean;
  readonly onChange: () => void;
}

export function TimelineSection({ timeline, customerId, canWork, onChange }: TimelineSectionProps) {
  const answered = reroutedBlocks(timeline.items);
  return (
    <Section id="timeline" title={complaintCopy.sections.timeline} description={text.lead}>
      {timeline.pending.length > 0 ? (
        <ul className="mb-3 space-y-1">
          {timeline.pending.map((pending) => (
            <li key={pending.pendingId} role="status" className="text-xs font-semibold text-warning">
              {text.pending[pending.reason] ?? pending.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {timeline.items.length === 0 ? <p className="text-sm text-slate">{text.empty}</p> : null}
      <ol className="space-y-3">
        {timeline.items.map((item) => (
          <li key={itemKey(item)} className="grid gap-2 border-l-2 border-mist pl-3 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
            <div className="flex flex-row items-center gap-2 sm:flex-col sm:items-start">
              <span className="whitespace-nowrap text-xs tabular-nums text-slate">{formatSimInstant(item.atSim)}</span>
              <Badge tone={TYPE_TONE[item.type]}>{text.type[item.type]}</Badge>
            </div>
            <div className="min-w-0">
              <ItemBody item={item} answered={answered} complaintId={timeline.complaintId} customerId={customerId} canWork={canWork} onChange={onChange} />
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
