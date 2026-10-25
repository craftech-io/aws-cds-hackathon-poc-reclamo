// `GET /api/health`: the public, shallow probe of the Router, the interim smoke and `SC-00`
// (docs/architecture.md §11). A static answer: no principal, no token verification, no read of any
// table, link or mock, and nothing about a world. The deep check of the mocks runs only in the
// QaDriver (`probe.mocks`).
import { publicProcedure } from "./trpc";

export const healthProcedure = publicProcedure.query(() => ({ ok: true as const, service: "bff" as const }));
