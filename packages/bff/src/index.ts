// Package entry point. Feature modules live in their own directories (docs/build-plan.md §1);
// the console imports only the type of the tRPC router, never BFF code.
export type { AppRouter } from "./routers/index";
