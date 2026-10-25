// The allowed paths a block offers (docs/architecture-integrations.md §4, CONTEXT.md
// "Reencaminamiento"). Only four rules have one:
//
//   CH-WA-NO-COLLECTION  the human queue; and, when a person tried it, the formal debt notice by email
//                        (it is started only by a person and rendered by code; the agent never gets it)
//   CH-OPTIN, CH-OPTOUT  the human queue; a complaint update goes by email instead
//   CH-KIND-CHANNEL      the human queue; a collection kind tried by a person, the formal debt notice
//
// Picking a path (`conversation.reroute` in the console, automatic for `SYSTEM`) creates a new request
// with `rerouteOf` that goes through the gate again; the tape adds `REROUTED`.
import type { ChannelRuleId } from "../copy/types";
import type { PolicyContext } from "./context";
import { COLLECTION_KINDS } from "./kinds";
import type { RerouteOption } from "./types";

const HUMAN_QUEUE: RerouteOption = { route: "HUMAN_QUEUE" };
const FORMAL_NOTICE: RerouteOption = { route: "FORMAL_EMAIL", previewKind: "COLLECTION_NOTICE_EMAIL" };
const UPDATE_BY_EMAIL: RerouteOption = { route: "FORMAL_EMAIL", previewKind: "COMPLAINT_UPDATE_EMAIL" };

/** The reroutes of a block by `ruleId`; `undefined` when the rule offers none. */
export function reroutesFor(ruleId: ChannelRuleId, ctx: PolicyContext): readonly RerouteOption[] | undefined {
  // A reroute's child is never rerouted again: a second block is the end of the road.
  if (ctx.request.rerouteOf !== undefined) return undefined;
  const byPerson = ctx.senderClass === "OPERATOR";
  const { kind, complaintId } = ctx.request;
  switch (ruleId) {
    case "CH-WA-NO-COLLECTION":
      return byPerson ? [HUMAN_QUEUE, FORMAL_NOTICE] : [HUMAN_QUEUE];
    case "CH-OPTIN":
    case "CH-OPTOUT":
      return kind === "COMPLAINT_UPDATE" && complaintId !== undefined ? [HUMAN_QUEUE, UPDATE_BY_EMAIL] : [HUMAN_QUEUE];
    case "CH-KIND-CHANNEL":
      return byPerson && COLLECTION_KINDS.has(kind) ? [HUMAN_QUEUE, FORMAL_NOTICE] : [HUMAN_QUEUE];
    default:
      return undefined;
  }
}
