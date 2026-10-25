// Shared secrets of the app (docs/architecture.md §3). Declared ONCE here; every other infra
// module imports the constant and puts it in the `link: [...]` of the Functions that need it.
// Declaring the same `sst.Secret` name in two modules is a duplicate-component error, so nobody
// writes `new sst.Secret(...)` anywhere else.
//
// One secret per purpose, linked only where it is needed: a Lambda that needs one key never gets
// the others (a master key with HKDF would separate purposes but not functions).
//
// | Secret                | What it is                                                           |
// |-----------------------|----------------------------------------------------------------------|
// | SessionKey            | sessionToken and runtimeSessionId (HKDF subkeys `session`,           |
// |                       | `runtime-session`). EventWorker, QaEventWorker, the 7 tool targets.  |
// | SimEnvelopeKey        | HMAC (kid `console`) of the simulated envelope the console's phone   |
// |                       | simulator builds. Bff and InboundWhatsApp only.                      |
// | QaSimEnvelopeKey      | HMAC (kid `qa`) of the simulated envelope the QaDriver builds.       |
// |                       | QaDriver and InboundWhatsApp only; never linked to the Bff.          |
// | PhoneHashKey          | phoneHash and emailHash (subkeys `phone-hash`, `email-hash`).        |
// |                       | Rotating it requires `seed:load --force`.                            |
// | RegisterChainKey      | HMAC of the complaints register, refund register and compliance tape |
// |                       | hash chains (docs/architecture.md §8.3).                             |
// | WabaId                | WhatsApp Business Account id of End User Messaging Social.           |
// |                       | `not-connected` for a deployment that uses only the phone simulator. |
// | WhatsAppPhoneNumberId | `originationPhoneNumberId` of SendWhatsAppMessage. `not-connected`   |
// |                       | for a deployment that uses only the phone simulator.                 |
// | SeedOverrides         | JSON: demoRecipients (≤ 5 emails, only @craftech.io, only the `demo` |
// |                       | world; phones for live WhatsApp), budgetEmail, personaPhones. `{}`.  |
// | LeadNotifyEmail       | The one @craftech.io mailbox of the lead notices (LeadNotifier only, |
// |                       | docs/architecture-guests.md §9). `not-configured` until the operator |
// |                       | sets the mailbox the CTO chose (ADR-0021 §4); never written in code. |
// | EdgeOriginKey         | Value of the `x-reclamo-edge` header: infra/web.ts writes it into    |
// |                       | the Router's key-value store, the Bff checks it (architecture-guests |
// |                       | §4). 32 random bytes in base64.                                      |
//
// How they are read: packages/bff/src/lib/secrets.ts (`secretValue(name)`), through the SST link,
// never `process.env` and never the `environment` of a Function. infra/secrets.test.ts fails when
// the names declared here and `SECRET_NAMES` over there drift apart.
//
// How they are loaded. Values are set by the operator for `poc` before the first CI deploy
// (docs/architecture.md §15 step 3); no value is ever pasted in a chat, a commit, an `.env` file or
// a CI variable. An `sst.Secret` without a value aborts the deploy, so none has a default here: a
// well-known key must fail the deploy, not ship.
//
//   npx sst secret set SessionKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret set SimEnvelopeKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret set QaSimEnvelopeKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret set PhoneHashKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret set RegisterChainKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret set WabaId not-connected --stage poc
//   npx sst secret set WhatsAppPhoneNumberId not-connected --stage poc
//   npx sst secret set SeedOverrides '{}' --stage poc
//   npx sst secret set LeadNotifyEmail not-configured --stage poc
//   npx sst secret set EdgeOriginKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret list --stage poc      # prints values: never share the output
//
// - `SeedOverrides` holds real addresses of the team: it is PII and is never logged.
// - After `sst secret set` the value reaches the Lambdas on the next deploy.

export const SessionKey = new sst.Secret("SessionKey");
export const SimEnvelopeKey = new sst.Secret("SimEnvelopeKey");
export const QaSimEnvelopeKey = new sst.Secret("QaSimEnvelopeKey");
export const PhoneHashKey = new sst.Secret("PhoneHashKey");
export const RegisterChainKey = new sst.Secret("RegisterChainKey");
export const WabaId = new sst.Secret("WabaId");
export const WhatsAppPhoneNumberId = new sst.Secret("WhatsAppPhoneNumberId");
export const SeedOverrides = new sst.Secret("SeedOverrides");
export const LeadNotifyEmail = new sst.Secret("LeadNotifyEmail");
export const EdgeOriginKey = new sst.Secret("EdgeOriginKey");
