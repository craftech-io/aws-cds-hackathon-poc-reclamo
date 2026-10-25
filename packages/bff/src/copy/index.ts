// Entry of copy/: the single source of every fixed text (docs/build-plan.md WP-11). Explicit
// re-exports only. Pure data and string helpers, safe to import from the console and the seed.

export {
  ACCOUNT_BLOCK_CATEGORY_TEXT,
  AUTOMATED_DISCLOSURE,
  CHALLENGE_PROMPT,
  COMPLAINT_OUTCOME_LABEL,
  COMPLAINT_STATUS_LABEL,
  COMPLAINT_TYPE_LABEL,
  CONSOLE_ES,
  DATA_CHANGE_FIELD_LABEL,
  EMAIL_TEXT,
  HANDOFF_REASON_LABEL,
  HOLDING_NOTICE,
  INSTALMENT_STATUS_TEXT,
  LOAN_STATUS_TEXT,
  MESSAGE_KIND_LABEL,
  SLA_STATE_LABEL,
  STAFF_TEXT,
  WHATSAPP_TEXT,
} from "./es-AR";
export type { ConsoleKey, EmailTextKey, StaffTextKey, WhatsAppTextKey } from "./es-AR";

export {
  ACCOUNT_BLOCK_CATEGORY_GLOSS,
  BLOCK_SOURCE_GLOSS,
  BUTTON_GLOSS,
  COLLECTION_CATEGORY_GLOSS,
  COMPLAINT_OUTCOME_GLOSS,
  COMPLAINT_STATUS_GLOSS,
  COMPLAINT_TYPE_GLOSS,
  CONSENT_GLOSS,
  CONSOLE_EN,
  DATA_CHANGE_FIELD_GLOSS,
  EMAIL_GLOSS,
  GATE_FAILURE_GLOSS,
  HANDOFF_REASON_GLOSS,
  INSTALMENT_STATUS_GLOSS,
  LOAN_STATUS_GLOSS,
  MESSAGE_KIND_GLOSS,
  REROUTE_GLOSS,
  SLA_STATE_GLOSS,
  STAFF_GLOSS,
  STATUS_PHRASE_GLOSS,
  TAPE_DECISION_GLOSS,
  TEMPLATE_GLOSS,
  WHATSAPP_GLOSS,
} from "./en-gloss";

export { BUTTON_TITLES, ButtonFormError, buttonGloss, buttonTitle } from "./buttons";
export { CURRENT_EMAIL_CONSENT, EMAIL_CONSENT_VERSIONS } from "./consent";
export type { ConsentVersion, ConsentVersionId } from "./consent";
export { STATUS_PHRASE_IDS, StatusPhraseId, TEMPLATE_STATUS_PHRASES, statusPhrase } from "./template-status";
export { TemplateParamNotAllowedError, WHATSAPP_TEMPLATES, renderTemplateBody, templateButtonTitles, templateParameters } from "./templates";
export type { WhatsAppTemplate } from "./templates";
export {
  BLOCK_SOURCE_REASON,
  COLLECTION_CATEGORY_LABEL,
  GATE_FAILURE_CODES,
  GATE_FAILURE_REASON,
  REROUTE_LABEL,
  TAPE_DECISION_LABEL,
  gateFailureGloss,
  tapeBanner,
} from "./block-reasons";
export type { BlockReason, GateFailureCode } from "./block-reasons";
export { PDF_CHANNEL_LABEL, PDF_COMMON, PDF_DOC, PDF_INSTALMENT_STATUS } from "./pdf-texts";
export { PERSONA_SCRIPTS, UNLINKED_NUMBER_SCRIPT, personaScript } from "./persona-scripts";
export type { PersonaId, PersonaScript, ScriptAttachment, ScriptIntake, ScriptMessage } from "./persona-scripts";
export { CopyParamError, beyondLabel, capitalize, charCount, fill, placeholdersOf } from "./helpers";
export type { CopyParamErrorCode } from "./helpers";
export {
  AccountBlockCategory,
  BUTTON_TITLE_LIMIT,
  BlockSource,
  ButtonForm,
  ChallengeKind,
  ChannelRuleId,
  CollectionCategory,
  DataChangeField,
  DocKind,
  ReceiptVariant,
  TemplateName,
  TemplateParamKind,
} from "./types";
export type { Glossed } from "./types";
