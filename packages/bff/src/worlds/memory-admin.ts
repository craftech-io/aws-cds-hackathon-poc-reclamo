// AgentCore Memory as the purge sees it (worlds/memory-purge.ts), over the data plane of
// `@aws-sdk/client-bedrock-agentcore` with the capability MEMORY_ADMIN (docs/architecture.md §9.3, §14).
// The Memory comes from the linked `Agent` (infra/agentcore.ts: `memoryId` and the namespaces), never
// from `process.env`. Listings page to the end, every call has a deadline and the SDK's retries, and
// deleting something already gone is not an error.
import {
  BedrockAgentCoreClient,
  DeleteEventCommand,
  DeleteMemoryRecordCommand,
  ListActorsCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  ListSessionsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { z } from "zod";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";

/** What the purge needs from Memory. */
export interface MemoryAdmin {
  listActorIds(): Promise<string[]>;
  listSessionIds(actorId: string): Promise<string[]>;
  listEventIds(actorId: string, sessionId: string): Promise<string[]>;
  deleteEvent(actorId: string, sessionId: string, eventId: string): Promise<void>;
  /** Records under a namespace prefix (`/customers/<actorId>/`: preferences, facts and summaries). */
  listRecordIds(namespacePrefix: string): Promise<string[]>;
  deleteRecord(recordId: string): Promise<void>;
}

/** `Resource.Agent` (infra/agentcore.ts): the roles that hold WORLDS reach the Memory through it. */
export const AgentLink = z.object({ memoryId: z.string().min(1) });

/** Every namespace of a customer's actor starts here (docs/architecture.md §9.3). */
export function actorNamespace(actorId: string): string {
  return `/customers/${actorId}/`;
}

// A purge makes a few hundred short calls; each answers in well under a second.
const MEMORY_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 4 };
const PAGE_SIZE = 100;

function named(error: unknown, ...names: string[]): boolean {
  return error instanceof Error && names.includes(error.name);
}

async function ignoreMissing(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch (error) {
    if (!named(error, "ResourceNotFoundException")) throw error;
  }
}

async function pages<T>(fetch: (nextToken: string | undefined) => Promise<{ items: T[]; nextToken?: string | undefined }>): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | undefined;
  do {
    const page = await fetch(nextToken);
    all.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return all;
}

export interface AgentCoreMemoryOptions {
  readonly log: Logger;
  readonly memoryId?: () => string;
  readonly client?: Pick<BedrockAgentCoreClient, "send">;
}

export function agentCoreMemoryAdmin(options: AgentCoreMemoryOptions): MemoryAdmin {
  const memoryId = options.memoryId ?? (() => readLinked("Agent", AgentLink).memoryId);
  let client = options.client;
  const agentCore = (): Pick<BedrockAgentCoreClient, "send"> => (client ??= new BedrockAgentCoreClient(awsClientConfig(MEMORY_TIMEOUTS)));

  return {
    listActorIds: () =>
      pages(async (nextToken) => {
        const page = await agentCore().send(new ListActorsCommand({ memoryId: memoryId(), maxResults: PAGE_SIZE, nextToken }));
        return { items: (page.actorSummaries ?? []).flatMap((actor) => (actor.actorId ? [actor.actorId] : [])), nextToken: page.nextToken };
      }),

    async listSessionIds(actorId) {
      try {
        return await pages(async (nextToken) => {
          const page = await agentCore().send(new ListSessionsCommand({ memoryId: memoryId(), actorId, maxResults: PAGE_SIZE, nextToken }));
          return { items: (page.sessionSummaries ?? []).flatMap((session) => (session.sessionId ? [session.sessionId] : [])), nextToken: page.nextToken };
        });
      } catch (error) {
        if (named(error, "ResourceNotFoundException")) return [];
        // Without `ListSessions` the events cannot be named; they expire with the Memory's event
        // expiry (30 days) and the actor is never read again (a new epoch is a new actor).
        if (named(error, "AccessDeniedException")) {
          options.log.warn("worlds.memory_sessions_unlisted", { metric: "MemoryPurgeSessionsUnlisted" });
          return [];
        }
        throw error;
      }
    },

    listEventIds: (actorId, sessionId) =>
      pages(async (nextToken) => {
        const page = await agentCore().send(new ListEventsCommand({ memoryId: memoryId(), actorId, sessionId, includePayloads: false, maxResults: PAGE_SIZE, nextToken }));
        return { items: (page.events ?? []).flatMap((event) => (event.eventId ? [event.eventId] : [])), nextToken: page.nextToken };
      }).catch((error: unknown) => (named(error, "ResourceNotFoundException") ? [] : Promise.reject(error))),

    async deleteEvent(actorId, sessionId, eventId) {
      await ignoreMissing(agentCore().send(new DeleteEventCommand({ memoryId: memoryId(), actorId, sessionId, eventId })));
    },

    listRecordIds: (namespacePrefix) =>
      pages(async (nextToken) => {
        const page = await agentCore().send(new ListMemoryRecordsCommand({ memoryId: memoryId(), namespace: namespacePrefix, maxResults: PAGE_SIZE, nextToken }));
        return { items: (page.memoryRecordSummaries ?? []).flatMap((record) => (record.memoryRecordId ? [record.memoryRecordId] : [])), nextToken: page.nextToken };
      }),

    async deleteRecord(recordId) {
      await ignoreMissing(agentCore().send(new DeleteMemoryRecordCommand({ memoryId: memoryId(), memoryRecordId: recordId })));
    },
  };
}
