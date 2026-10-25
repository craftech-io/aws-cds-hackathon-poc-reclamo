// Operations of networks.openapi.yaml (docs/architecture-integrations.md §6), keyed by operationId.
// Same world authorization as the core: 403 `CALLER_WORLD_DENIED` on every world route. A world
// with the `ERROR_503` fault answers 503 on every world route.
import { CalendarDate, Health, NoParams, ResourceId, WorldHeaders, WorldParams } from "./common";
import {
  CollectionNetwork,
  CollectionRequest,
  CollectionResult,
  PublishResult,
  SettlementBatchList,
  SettlementsQuery,
  TransferReversalRequest,
  TransferReversalResult,
  TransferStatus,
  TransitionRequest,
} from "./networks";
import { defineRoute } from "./routes";

const world = WorldParams;
const transfer = world.extend({ transferId: ResourceId });

export const networksRoutes = {
  registerCollection: defineRoute({
    method: "post",
    path: "/v1/{worldId}/collections",
    params: world,
    headers: WorldHeaders,
    body: CollectionRequest,
    ok: CollectionResult,
    errors: [400, 403, 404, 409, 503],
  }),
  publishSettlement: defineRoute({
    method: "post",
    path: "/v1/{worldId}/settlements/{network}/{businessDate}/publish",
    params: world.extend({ network: CollectionNetwork, businessDate: CalendarDate }),
    headers: WorldHeaders,
    ok: PublishResult,
    errors: [400, 403, 404, 503],
  }),
  listSettlements: defineRoute({
    method: "get",
    path: "/v1/{worldId}/settlements/{network}",
    params: world.extend({ network: CollectionNetwork }),
    query: SettlementsQuery,
    headers: WorldHeaders,
    ok: SettlementBatchList,
    errors: [400, 403, 404, 503],
  }),
  getTransfer: defineRoute({
    method: "get",
    path: "/v1/{worldId}/transfers/{transferId}",
    params: transfer,
    headers: WorldHeaders,
    ok: TransferStatus,
    errors: [400, 403, 404, 503],
  }),
  requestTransferReversal: defineRoute({
    method: "post",
    path: "/v1/{worldId}/transfers/{transferId}/reversal-request",
    params: transfer,
    headers: WorldHeaders,
    body: TransferReversalRequest,
    ok: TransferReversalResult,
    errors: [400, 403, 404, 409, 422, 503],
  }),
  transitionTransfer: defineRoute({
    method: "post",
    path: "/v1/{worldId}/transfers/{transferId}/transition",
    params: transfer,
    headers: WorldHeaders,
    body: TransitionRequest,
    ok: TransferStatus,
    errors: [400, 403, 404, 409, 503],
  }),
  getNetworksHealth: defineRoute({ method: "get", path: "/v1/health", params: NoParams, ok: Health, errors: [503] }),
};
