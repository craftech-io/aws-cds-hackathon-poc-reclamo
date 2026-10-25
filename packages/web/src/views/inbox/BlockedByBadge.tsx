// Who a complaint waits for (FL-097), as the inbox and the case show it: a network wait is the
// network's, never the customer's.
import { Badge, type BadgeTone } from "../../components/Badge";
import { type BlockedByKey, inboxCopy } from "./copy";

const BLOCKED_TONE: Readonly<Record<BlockedByKey, BadgeTone>> = { CUSTOMER: "info", NETWORK: "brand", PERSON: "warning", AGENT: "neutral", NONE: "neutral" };

export function BlockedByBadge({ blockedBy }: { readonly blockedBy: BlockedByKey }) {
  return <Badge tone={BLOCKED_TONE[blockedBy]}>{inboxCopy.blockedBy[blockedBy]}</Badge>;
}
