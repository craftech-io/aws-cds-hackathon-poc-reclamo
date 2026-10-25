// Path the Router forwards to the BFF; the web client calls `/api/<procedure>`. A module of its own
// so the edge specs (infra/web-spec.test.ts) can read it without loading the routers.
export const API_PREFIX = "/api";
