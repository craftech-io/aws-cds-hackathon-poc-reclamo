/// <reference types="vite/client" />

// Build-time variables injected by the StaticSite (infra/auth.ts `authWebEnvironment`,
// infra/web.ts). None of them is a secret. They are read only through
// src/lib/env.ts, which validates them with zod.
interface ImportMetaEnv {
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
