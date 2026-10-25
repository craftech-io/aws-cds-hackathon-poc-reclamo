// English gloss of every fixed text (ADR-0012): the "EN" button of the simulator and of the guided
// tour, and the gloss the console shows next to navigation, headings, key buttons, the tape banner
// and the recent-login modal, so a guest who does not read Spanish can follow the tape and the
// approvals. Same keys and same placeholders as the Spanish source; the types make a missing key a
// compile error and copy.test.ts checks the placeholders. The gloss is never sent to a customer.
import type { ComplaintOutcome, ComplaintStatus, ComplaintType, HandoffReason, MessageKind, Reroute, SlaState, TapeEntryKind, WaButtonAction } from "@reclamo/shared";
import type { GateFailureCode } from "./block-reasons";
import type { ConsentVersionId } from "./consent";
import type { ConsoleKey, EmailTextKey, StaffTextKey, WhatsAppTextKey } from "./es-AR";
import type { StatusPhraseId } from "./template-status";
import type { AccountBlockCategory, BlockSource, ButtonForm, CollectionCategory, DataChangeField, InstalmentStatusKey, LoanStatusKey, TemplateName } from "./types";

export const WHATSAPP_GLOSS: Readonly<Record<WhatsAppTextKey, string>> = {
  AUTOMATED_DISCLOSURE: "I am the automated assistant of Jarilla (fictitious). At any time you can ask to be served by a person.",
  LIVE_PROFILE: "Reclamo en regla (demo) · Jarilla is a fictitious lender",
  COMPLAINT_ACK: "I registered your complaint {{complaintNumber}} ({{complaintType}}). The written answer reaches you no later than {{deadlineText}}.",
  CONSULTA_ACK: "I registered your enquiry {{complaintNumber}} ({{complaintType}}). The written answer reaches you no later than {{deadlineText}}.",
  COMPLAINT_ACK_EXISTING: "Your complaint {{complaintNumber}} ({{complaintType}}) is still open and we are reviewing it. The written answer reaches you no later than {{deadlineText}}.",
  EMAIL_CONSENT_ACCEPTED: "Done. We are sending the acknowledgement with the number to {{emailMasked}}; the written answer will arrive there.",
  EMAIL_CONSENT_DECLINED: "Understood. A person from the service team will write to you here to agree how we send you the written answer.",
  EMAIL_UNAVAILABLE: "We have no active email to send you the written answer. A person from the service team will write to you here to agree how we send it.",
  CHALLENGE_LAST_DUE_DATE: "To see your account, tell me the due date of your last instalment, as day and month (dd/mm).",
  CHALLENGE_LAST_INSTALMENT_AMOUNT: "To see your account, tell me the amount of your last instalment.",
  CHALLENGE_LAST_MOVEMENT_AMOUNT: "To see your account, tell me the amount of the last movement of your wallet.",
  CHALLENGE_RETRY: "That does not match our records. I will ask you once more.",
  UNKNOWN_SENDER: "This number is not linked to a Jarilla (fictitious) account. If you are a customer, write to us from your registered phone; if not, you can talk to a person.",
  RECEIPT_REQUEST: "Send me a photo of the receipt so I can review it.",
  RECEIPT_RETAKE: "I could not read the photo well. Send me another one, with good light and the whole receipt.",
  MEDIA_TOO_LARGE: "The image is too heavy. Send me a lighter photo of the receipt (up to 3.75 MB).",
  MEDIA_UNSUPPORTED: "I can only read photos (JPG or PNG). Send me a photo of the receipt.",
  IMAGE_NOT_PROCESSED: "We could not process the image; send it again or talk to someone.",
  IMAGE_REJECTED: "We could not use that image. Send me another photo of the receipt or talk to someone.",
  CHOOSE_LOAN_PROMPT: "You have more than one loan. Which one is your complaint about?",
  HOLDING_NOTICE: "We are reviewing your complaint {{complaintNumber}}; we will write to you as soon as there is news.",
  HOLDING_NOTICE_NO_COMPLAINT: "We are reviewing your message; we will write to you as soon as there is news.",
  HANDOFF_NOTICE: "A person from Jarilla follows your complaint {{complaintNumber}}. The answer is due on {{deadlineText}}.",
  HANDOFF_NOTICE_NO_COMPLAINT: "A person from Jarilla will follow your enquiry here.",
  HANDOFF_GUARDRAIL: "I cannot go on with that message; I am handing you to a person.",
  APPROVAL_PENDING: "Your complaint {{complaintNumber}} needs the approval of a person from the team. We will let you know as soon as it is done.",
  RESOLUTION_NOTICE: "Your complaint {{complaintNumber}} was resolved. We sent the written answer by email to {{emailMasked}}.",
  EMAIL_UNDELIVERED: "We could not deliver the answer to your email; a person will contact you.",
  SAFETY_GUIDANCE: "For your safety: we will never ask for passwords, PINs, verification codes or card details, neither in this chat nor by email. If someone asks for them on behalf of Jarilla, do not share them.",
  SAFETY_GUIDANCE_FREEZE: "As a protection, we blocked the outgoing transfers and payments of your wallet. A person from the team lifts the block after reviewing your case.",
  SAFETY_GUIDANCE_CARD: "Your message had card details and we hid them. Do not send them here: we will never ask for them.",
  OUT_OF_SCOPE_REFUSAL: "I cannot handle that here: I only see complaints and enquiries about your Jarilla account and your operations. If you want, a person will serve you.",
  OUT_OF_SCOPE_ADVICE: "I cannot give legal or investment advice. If your complaint is not resolved as you expect, you have the right to file it with the Central Bank (BCRA).",
  OPT_OUT_CONFIRMATION: "Done, we will not send you more WhatsApp messages. Your account stays as it is: this is not a closure. The written answers to your complaints keep arriving by email.",
  BAJA_AMBIGUOUS: "Do you want to stop receiving WhatsApp messages or close your Jarilla account?",
  RATE_LIMITED: "We received many messages in a row. Wait a while and write again, or ask to talk to a person.",
};

export const EMAIL_GLOSS: Readonly<Record<EmailTextKey, string>> = {
  FROM_NAME: "Jarilla (fictitious) via Reclamo en regla",
  SUBJECT_ACK: "Complaint {{complaintNumber}} · Acknowledgement",
  SUBJECT_ANSWER: "Complaint {{complaintNumber}} · Written answer",
  SUBJECT_UPDATE: "Complaint {{complaintNumber}} · Update",
  SUBJECT_CLOSURE: "Complaint {{complaintNumber}} · Account closure registered",
  SUBJECT_DATA_CHANGE: "Data change request · Jarilla (fictitious)",
  SUBJECT_COLLECTION_NOTICE: "Formal debt notice · Jarilla (fictitious)",
  SUBJECT_SUPERVISOR_ALERT: "Complaint {{complaintNumber}} · Escalation to the supervisor",
  GREETING: "Hello {{firstName}}:",
  ACK_BODY_RECLAMO: "We registered your complaint {{complaintNumber}} ({{complaintType}}) on {{filedAtText}}. The written answer reaches this email no later than {{deadlineText}}. The acknowledgement is attached as a PDF.",
  ACK_BODY_CONSULTA: "We registered your enquiry {{complaintNumber}} ({{complaintType}}) on {{filedAtText}}. The written answer reaches this email no later than {{deadlineText}}. The acknowledgement is attached as a PDF.",
  ANSWER_INTRO: "This is the written answer to your complaint {{complaintNumber}} ({{complaintType}}), filed on {{filedAtText}}.",
  ANSWER_ATTACHMENTS: "The answer is attached as a PDF, with the documents that apply.",
  UPDATE_BODY: "There is an update on your complaint {{complaintNumber}}: {{statusPhrase}}.",
  CLOSURE_BODY: "We registered your account closure request on {{requestedAtText}}, with number {{complaintNumber}}. The record is attached as a PDF.",
  CLOSURE_ACTIVE_LOAN: "Since you have an active loan, the account stays in closure until the loan is cancelled. You do not need to request the closure again.",
  CLOSURE_WALLET_BALANCE: "Your wallet still has a balance: the closure is completed once the wallet has no balance left. You do not need to request the closure again.",
  CLOSURE_PENDING_TRANSFER: "You have a transfer in progress: the closure is completed once it is credited or reversed. You do not need to request the closure again.",
  DATA_CHANGE_BODY: "We received a request to change {{field}} on your account. We are writing to the address you have registered today. If you did not request it, tell us on WhatsApp or ask to talk to a person.",
  COLLECTION_NOTICE_BODY: "We send you this formal notice with the detail of the overdue instalments of your loan {{loanLabel}}, according to the records of Jarilla (fictitious). The detail and the total are in the attached PDF.",
  COLLECTION_NOTICE_RIGHTS: "If you do not recognise the detail or want to file a complaint, write to us on WhatsApp or ask to talk to a person: you have the right to a written answer within 10 business days.",
  SUPERVISOR_ALERT_BODY: "Complaint {{complaintNumber}} reached business day 8 without a written answer. It is due on {{deadlineText}}.",
  NO_REPLY: "This mailbox does not receive replies: to continue, write to us on WhatsApp or ask to talk to a person.",
  FOOTER_COMPLAINT: "Complaint {{complaintNumber}}",
  FOOTER_BCRA: "If this answer does not satisfy you, you can file your complaint with the Central Bank of Argentina (BCRA).",
  FOOTER_SYNTHETIC: "Jarilla is a fictitious lender · synthetic data · Reclamo en regla",
};

export const STAFF_GLOSS: Readonly<Record<StaffTextKey, string>> = {
  SLA_OPERATOR_REMINDER: "Reminder: complaint {{complaintNumber}} is on business day 5 of 10. It is due on {{deadlineText}}.",
  SLA_SUPERVISOR_ESCALATION: "Escalation: complaint {{complaintNumber}} reached business day 8 without a written answer. It is due on {{deadlineText}}.",
  SLA_DEADLINE_OVERDUE: "Overdue: complaint {{complaintNumber}} expired on {{deadlineText}} without a written answer.",
  WORLD_NOT_READY: "Your world is not ready yet; try again in a minute or use another account.",
  WORLD_RESETTING: "We are resetting your world; it takes a few minutes.",
  OTHER_SESSION: "Another session used this world in the last 2 hours: use another guest account.",
  SIMULATOR_LABEL: "WhatsApp (simulated)",
  SIMULATOR_UPLOAD_NOTICE: "Only synthetic or test receipts; do not upload real documents. Uploaded images are deleted after 2 days.",
  NOT_LEGAL_ADVICE: "Our reading of the rules, not legal advice",
  SYNTHETIC_TERMS: "synthetic terms of a fictitious lender",
  ASSUMPTION: "assumption",
};

export const COMPLAINT_TYPE_GLOSS: Readonly<Record<ComplaintType, string>> = {
  PAYMENT_NOT_REFLECTED: "payment not reflected",
  PAYOFF_CERTIFICATE: "payoff certificate",
  UNRECOGNIZED_CHARGE: "unrecognised charge",
  DUPLICATE_DEBIT: "duplicate debit",
  TRANSFER_NOT_CREDITED: "transfer not credited",
  DISBURSEMENT_NOT_RECEIVED: "disbursement not received",
  UNKNOWN_OPERATION: "unknown operation",
  ACCOUNT_BLOCKED: "account blocked",
  CLOSURE_OR_EARLY_PAYOFF: "closure or early payoff",
  DATA_CHANGE: "data change",
  INFORMATION_REQUEST: "information request",
};

export const COMPLAINT_OUTCOME_GLOSS: Readonly<Record<ComplaintOutcome, string>> = {
  IN_FAVOUR: "In the customer's favour",
  PARTIALLY_IN_FAVOUR: "Partially in the customer's favour",
  NOT_IN_FAVOUR: "Not in the customer's favour",
  INFORMATIONAL: "Informational",
  WITHDRAWN: "Withdrawn by the customer",
};

export const COMPLAINT_STATUS_GLOSS: Readonly<Record<ComplaintStatus, string>> = {
  REGISTERED: "Registered",
  INVESTIGATING: "Investigating",
  AWAITING_CUSTOMER: "Waiting for the customer",
  AWAITING_SETTLEMENT: "Waiting for the network settlement",
  AWAITING_NETWORK: "Waiting for the network",
  AWAITING_APPROVAL: "Waiting for an approval",
  HUMAN_REVIEW: "With a person",
  RESOLVED: "Resolved",
  ANSWERED: "Answered in writing",
  CLOSED: "Closed",
};

export const SLA_STATE_GLOSS: Readonly<Record<SlaState, string>> = { ON_TIME: "On time", AT_RISK: "At risk", OVERDUE: "Overdue" };

export const HANDOFF_REASON_GLOSS: Readonly<Record<HandoffReason, string>> = {
  CUSTOMER_ASKED: "The customer asked",
  LOW_CONFIDENCE: "Low agent confidence",
  TWO_FAILED_ATTEMPTS: "Two attempts without a resolution",
  FRAUD: "Possible fraud",
  ABOVE_CAP: "Above the policy cap",
  IDENTITY_VERIFICATION: "Identity verification",
  RECEIPT_NOT_FOUND: "Receipt without a settlement line",
  RECEIPT_DOUBT: "Doubtful receipt",
  ACCOUNT_BLOCKED: "Account blocked",
  RISKY_DATA_CHANGE: "Sensitive data change",
  EMAIL_UNDELIVERABLE: "Email not delivered",
  GUARDRAIL_BLOCK: "Guardrail block",
  OTHER: "Other reason",
};

export const MESSAGE_KIND_GLOSS: Readonly<Record<MessageKind, string>> = {
  COMPLAINT_ACK: "Acknowledgement",
  ACK_EMAIL: "Acknowledgement by email",
  IDENTITY_CHALLENGE: "Identity challenge",
  REPLY: "Reply",
  RECEIPT_REQUEST: "Receipt request",
  COMPLAINT_UPDATE: "Complaint update",
  RESOLUTION_NOTICE: "Resolution notice",
  FORMAL_ANSWER: "Written answer",
  HANDOFF_NOTICE: "Handoff notice",
  HOLDING_NOTICE: "Holding notice",
  OPERATOR_MESSAGE: "Operator message",
  SAFETY_GUIDANCE: "Safety guidance",
  OUT_OF_SCOPE_REFUSAL: "Out of scope",
  OPT_OUT_CONFIRMATION: "Opt-out confirmation",
  DATA_CHANGE_CONFIRMATION: "Data change confirmation",
  CLOSURE_CONFIRMATION: "Closure confirmation",
  SUPERVISOR_ALERT: "Supervisor alert",
  COLLECTION_REMINDER: "Overdue reminder",
  COLLECTION_NOTICE_EMAIL: "Formal debt notice (email)",
};

export const ACCOUNT_BLOCK_CATEGORY_GLOSS: Readonly<Record<AccountBlockCategory, string>> = {
  SECURITY_REVIEW: "Your account is under security review. While it lasts, a person from the team reviews the movements and writes to you here.",
  IDENTITY_VALIDATION: "Your account is blocked until your identity is validated. A person from the team does the validation; in this chat we will never ask you for documents.",
  EXTERNAL_ORDER: "Your account has a restriction ordered by an external body. A person from the team explains the steps.",
  INACTIVITY: "Your account was blocked for long inactivity. A person from the team can reactivate it after verifying your identity.",
};

export const DATA_CHANGE_FIELD_GLOSS: Readonly<Record<DataChangeField, string>> = { EMAIL: "your email", ADDRESS: "your address", PHONE: "your phone" };

export const LOAN_STATUS_GLOSS: Readonly<Record<LoanStatusKey, string>> = { ACTIVE: "current", IN_ARREARS: "current, with pending instalments", CANCELLED: "cancelled", EARLY_CANCELLED: "cancelled early" };

export const INSTALMENT_STATUS_GLOSS: Readonly<Record<InstalmentStatusKey, string>> = { DUE: "not yet due", PAID: "paid", PARTIALLY_PAID: "partly paid", OVERDUE: "pending" };

export const CONSOLE_EN: Readonly<Record<ConsoleKey, string>> = {
  NAV_INBOX: "Inbox",
  NAV_COMPLAINT: "Complaint",
  NAV_CUSTOMER: "Customer",
  NAV_APPROVALS: "Approvals",
  NAV_TAPE: "Compliance tape",
  NAV_REGISTER: "Complaint register",
  NAV_EMAILS: "Emails",
  NAV_SIMULATOR: "Phone simulator",
  NAV_CLOCK: "Demo clock",
  NAV_METRICS: "Metrics",
  NAV_POLICY: "Channel policy",
  NAV_TOUR: "Guided tour",
  HEADING_TIMELINE: "Timeline",
  HEADING_EVIDENCE: "Evidence",
  HEADING_ACTIONS: "Actions and refunds",
  HEADING_FORMAL_ANSWER: "Written answer",
  HEADING_COMPOSER: "Composer",
  HEADING_SIMULATED_TIME: "Simulated time",
  HEADING_THIS_WORLD: "This world (measured)",
  HEADING_SEEDED_HISTORY: "Seeded history (not measured)",
  HEADING_REAL_BATCH: "Batch · real agent",
  HEADING_SIMULATED_LOAD: "Simulated load (scripted agent)",
  BUTTON_TAKE_OVER: "Take over the conversation",
  BUTTON_HAND_BACK: "Hand back to the agent",
  BUTTON_ANSWER_IN_WRITING: "Answer in writing",
  BUTTON_APPROVE: "Approve",
  BUTTON_REJECT: "Reject",
  BUTTON_ESCALATE: "Hand to a person",
  BUTTON_SEND: "Send",
  BUTTON_ADVANCE_NEXT_EVENT: "Advance to the next event",
  BUTTON_ADVANCE_COMPLAINT_MILESTONE: "Advance to this complaint's next milestone",
  BUTTON_PLUS_ONE_HOUR: "+1 h",
  BUTTON_PLUS_ONE_BUSINESS_DAY: "+1 business day",
  BUTTON_LIVE_CLOCK: "Live clock",
  BUTTON_SLOW_LIVE_CLOCK: "Slow live clock",
  BUTTON_FIRE_TIMER_NOW: "Fire now",
  BUTTON_RESET_WORLD: "Reset this world",
  BUTTON_EXPORT: "Export",
  BUTTON_SEND_SCRIPT: "Send the script message",
  BUTTON_ATTACH_RECEIPT: "Attach a receipt",
  BUTTON_UNLOCK_CHALLENGE: "Lift the challenge lock",
  RECENT_LOGIN_TITLE: "Approving money requires a recent sign-in",
  RECENT_LOGIN_BODY: "More than 15 minutes passed since you signed in. Confirm with your password to approve, answer in writing or reset the world: it is a feature, not an error.",
  RECENT_LOGIN_PASSWORD: "Password",
  RECENT_LOGIN_CONFIRM: "Confirm",
  RECENT_LOGIN_CANCEL: "Cancel",
};

export const TEMPLATE_GLOSS: Readonly<Record<TemplateName, string>> = {
  reclamo_novedad: "Hello {{1}}, there is an update on your complaint {{2}}: {{3}}. You can reply here.",
  reclamo_resuelto: "Your complaint {{1}} was resolved. We sent the written answer by email to {{2}}.",
  reclamo_derivado: "Your complaint {{1}} is followed by a person from the service team. The answer is due on {{2}}.",
  reclamo_respuesta_no_entregada: "We could not deliver the written answer to your complaint {{1}} to your email. A person will contact you here.",
};

export const STATUS_PHRASE_GLOSS: Readonly<Record<StatusPhraseId, string>> = {
  SETTLEMENT_PUBLISHED: "we now have the network's settlement file",
  PAYMENT_REFLECTED: "your payment is now reflected in your account",
  TRANSFER_CREDITED: "the transfer now shows as credited",
  TRANSFER_REVERSED: "the rejected transfer is back in your wallet",
  DISBURSEMENT_CREDITED: "the disbursement now shows as credited in your wallet",
  REFUND_CREDITED: "the refund now shows as credited in your wallet",
  CHARGE_REVERSED: "we reversed the charge you complained about",
  NETWORK_PENDING: "we are still waiting for the network's confirmation",
  APPROVAL_PENDING: "the action is waiting for a person's approval",
  HUMAN_REVIEWED: "a person reviewed your case",
  ANSWER_SENT: "we sent you the written answer by email",
};

export const CONSENT_GLOSS: Readonly<Record<ConsentVersionId, string>> = {
  "email-answer-v1": "Do you accept that the written answer to this complaint and its documents reach you by email at {{emailMasked}}? If you prefer another way, a person will contact you.",
};

export const BUTTON_GLOSS: Readonly<Record<WaButtonAction, Partial<Record<ButtonForm, string>>>> = {
  TALK_TO_HUMAN: { INTERACTIVE: "Talk to someone", LIST_ROW: "Talk to a person", QUICK_REPLY: "Talk to a person" },
  ACCEPT_EMAIL: { INTERACTIVE: "Yes, to that email" },
  DECLINE_EMAIL: { INTERACTIVE: "I prefer another way" },
  CHOOSE_LOAN: { LIST_MENU: "Choose a loan" },
  OPT_OUT: { INTERACTIVE: "Stop messages" },
  CONFIRM_CLOSURE: { INTERACTIVE: "Close my account" },
  WITHDRAW: { INTERACTIVE: "Withdraw the complaint" },
  SEE_DETAIL: { QUICK_REPLY: "See detail" },
  HAVE_A_QUESTION: { QUICK_REPLY: "I have a question" },
};

/** Gloss of block-reasons.ts: `short` goes on the tape banner, `detail` in the rule panel. */
export const BLOCK_SOURCE_GLOSS: Readonly<Record<BlockSource, { readonly short: string; readonly detail: string }>> = {
  "CH-SENDER": { short: "Sender not allowed", detail: "The sender has no valid session, no current role in the world or no deterministic message kind." },
  "CH-CONTROL": { short: "Conversation taken over by a person", detail: "While a person holds the conversation the agent does not send; the operator writes only with the conversation taken over." },
  "CH-KIND-CHANNEL": { short: "Message kind not allowed on this channel", detail: "Each message kind has its channel: the written answer and the certificates go by email only." },
  "CH-WA-NO-COLLECTION": { short: "WhatsApp Commerce Policy (debt collection)", detail: "No debt collection message goes out on WhatsApp, whoever sends it. Allowed path: the human queue or the formal notice by email." },
  "CH-WA-NO-PAYMENT-REQUEST": { short: "Payment request on WhatsApp", detail: "No payment request, payment link or payment instrument goes out on WhatsApp." },
  "CH-NO-CREDIT-OFFER": { short: "Credit offer", detail: "No channel carries credit offers, refinancing or limit increases." },
  "CH-RECIPIENT-FENCE": { short: "Recipient outside the fence", detail: "Email only to the SES mailbox simulator or, from the demo world, to registered demo recipients; live WhatsApp only to demo phones." },
  "CH-OPTIN": { short: "No WhatsApp opt-in", detail: "A WhatsApp message started by the lender needs a current opt-in." },
  "CH-OPTOUT": { short: "The customer opted out", detail: "With a current opt-out only the opt-out confirmation goes out." },
  "CH-WA-CUSTOMER-INITIATED": { short: "No open complaint of the customer", detail: "A proactive WhatsApp message can only be an update on an open complaint the customer started." },
  "CH-WA-24H": { short: "Outside the 24-hour window", detail: "Outside the window only approved templates go out, with parameters from the closed list." },
  "CH-CONTACT-HOURS": { short: "Outside contact hours", detail: "Proactive messages Monday to Friday 8 to 20 and Saturday 9 to 13, no Sundays or holidays (assumption); the formal debt notice Monday to Friday 9 to 18." },
  "CH-MAX-PER-DAY": { short: "Daily contact cap", detail: "Up to 3 proactive contacts per customer per day (assumption); the formal debt notice, one every 7 days." },
  "CH-NO-SENSITIVE-ASK": { short: "Sensitive data request", detail: "No message asks for passwords, PINs, codes, cards, bank details or documents." },
  "CH-NO-FOREIGN-LINKS": { short: "Foreign link or contact", detail: "No message carries links, domains, emails or phones that are not the stage's." },
  "CH-FORMAL-CONTENT": { short: "Incomplete formal content", detail: "The written answer carries number, type, date, resolution and the right to go to the BCRA; the formal debt notice, the creditor's identification and the core's detail." },
  G2: { short: "Output guardrail", detail: "The output guardrail (G2) denied the text: a forbidden topic, or not grounded on the turn's tool results." },
  VERIFY: { short: "Deterministic check", detail: "An amount, date, number or code of the text is not in the turn's tool results." },
};

export const COLLECTION_CATEGORY_GLOSS: Readonly<Record<CollectionCategory, string>> = {
  PAYMENT_EXHORTATION: "Payment exhortation",
  CONSEQUENCE_THREAT: "Threat of consequences",
  DEBT_REMINDER: "Debt reminder",
  PAYMENT_INSTRUMENT: "Payment instrument",
  NEGOTIATION: "Debt negotiation",
};

export const GATE_FAILURE_GLOSS: Readonly<Record<GateFailureCode, string>> = {
  TEMPLATE_REQUIRED: "Outside the window an approved template is required",
  TEMPLATE_PARAM_NOT_ALLOWED: "Template parameter outside the closed list",
  GROUNDING_FAIL: "Text not grounded on the turn's tool results",
  POLICY_DENIED: "Topic denied by the output guardrail",
  RECIPIENT_NOT_ALLOWED: "Recipient not allowed by the fence",
  UNKNOWN_DELIVERY: "Uncertain delivery: a person reviews it, it is never resent blindly",
};

/** The English half of the tape banner is the decision itself. */
export const TAPE_DECISION_GLOSS: Readonly<Record<TapeEntryKind, string>> = {
  ALLOWED: "ALLOWED",
  BLOCKED: "BLOCKED",
  REROUTED: "REROUTED",
  DEFERRED: "DEFERRED",
  DISPATCH: "DISPATCH",
};

export const REROUTE_GLOSS: Readonly<Record<Reroute, string>> = {
  HUMAN_QUEUE: "Route to the human queue",
  FORMAL_EMAIL: "Send a formal notice by email",
};
