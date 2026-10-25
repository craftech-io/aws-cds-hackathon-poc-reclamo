# Catálogo de tools y handlers

Tools expuestas al Harness por AgentCore Gateway (7 targets Lambda, **28 tools**), handlers deterministas de invocación directa (no están en el Gateway), procedimientos de la consola (tRPC) y acciones del `QaDriver`. Nombres en inglés, `snake_case`. Los schemas se escriben en JSON para leer; la fuente única es zod en `packages/bff/src/agent-tools/<target>/schema.ts`, de donde `npm run tools:build-schemas` genera el `inlinePayload` de cada target.

## Convenciones

| Convención | Regla |
|---|---|
| Target | Un `GatewayTarget` por dominio y una Lambda por target (`packages/bff/src/agent-tools/<target>/`); nombre en el Gateway `<target>___<tool>`; todo handler pasa por `createToolHandler` (`agent-tools/common/handler.ts`) |
| Principales | `harness` (rol de ejecución del Harness; **único principal del Gateway**) · `worker` (`EventWorker`/`SignupEventWorker`/`QaEventWorker`, por import) · `channel` (`InboundWhatsApp`, `EmailEvents`, `MediaIntake`) · `console` (BFF con JWT: `staffId`, `worldId`, `role`, `isGuest`, `authTime`) · `qa` (`QaDriver`, rol `qa-runner`; llega a los handlers de consola por el `appRouter` real) · `scheduler` (`ScheduleDispatch`) · `public` (visitante sin JWT: solo los procedimientos `signup.*` y `password.*`, con la cabecera de borde del Router, `docs/architecture-guests.md` §4) · `cognito` (triggers del user pool) |
| Sesión | Toda tool del Gateway exige `sessionToken = <worldId>.<sessionId>.<turnId>.<exp>.<HMAC-SHA256 base64url>` (`SessionKey`, `exp` ≤ 15 min). La Lambda verifica firma, vencimiento y turno abierto, carga `Runtime/W#<worldId>#SESSION#<sessionId>` y **deriva** `customerId`, `conversationId`, `complaintIds`, `identified`, `triggerEventId` y `eventAtSim`. Un id del input (préstamo, cargo, transferencia, evidencia, aprobación) que no pertenece al cliente o al reclamo de la sesión → `FORBIDDEN` + `AuditLog DENY` (`LAM-SCOPE`) |
| Cercas | `LAM-IDENTIFIED` (tools marcadas **Id**: exigen identificación vigente, 30 minutos reales), `LAM-COMPLAINT-REQUIRED` (marcadas **Rc**: exigen un reclamo abierto de la sesión; `complaintId` opcional en el input si hay uno solo; `check_charge`, `check_duplicate_debit`, `get_transfer_status`, `get_disbursement` y `reconcile_payment` sin reclamo nombrado actúan solo sobre el más nuevo abierto de su tipo, o `COMPLAINT_REQUIRED` con razón `COMPLAINT_TYPE`), `LAM-EVIDENCE`, `LAM-CAP`, `LAM-CONTROL`, `LAM-STRICT`, `LAM-ONCE-PER-EVENT`, `LAM-CALLER` (`docs/design-brief.md` §8.6) |
| Invocación directa | **La entrada Lambda desplegada de un target acepta solo `{sessionToken, …}`**: un input con `caller` → `INVALID` + `AuditLog DENY DIRECT_INVOKE` (`agent-tools/common/handler.test.ts` lo asierta sobre las 7 entradas). En la misma cuenta, una política de recurso no frena a un principal con `lambda:InvokeFunction` en su política de identidad, así que ninguna entrada confía en quién la invoca. La variante `caller` (`{"kind": "WORKER" \| "CHANNEL" \| "CONSOLE" \| "QA" \| "SCHEDULER", "worldId", "staffId?", "role?", "eventId"}`) existe solo como **firma de función en proceso**: el worker, el `Bff` y el `QaDriver` importan el handler y lo llaman con el principal que ya autenticaron (JWT, cola, rol de QA); nunca viaja por una invocación de Lambda |
| Lecturas precargadas | El worker invoca en proceso (`caller` worker, con el `sessionToken` del turno y las mismas cercas) `identify_customer` en todo turno y, con la sesión identificada, `get_account` y `list_operations` (últimos 30 días del reloj del mundo) antes del Harness; sus resultados van al sobre como `<tool-result tool="…">` escapados (ADR-0021 §7) |
| Resultados del turno | Toda tool escribe su salida (redactada) en `Runtime/W#<w>#TURN#<turnId>/RESULT#<tool>#<seq>` (TTL 1 h): fuente de G2 y de la verificación determinista. Los campos de texto libre que vienen de un mock se devuelven escapados, como dato |
| Errores | Nunca lanzan: `{"ok": false, "error": {"code", "message"}}` con `code` ∈ `NOT_FOUND`, `FORBIDDEN`, `INVALID`, `CONFLICT`, `UNAVAILABLE`, `NOT_IDENTIFIED`, `COMPLAINT_REQUIRED`, `EVIDENCE_REQUIRED`, `ABOVE_CAP`, `NOT_ELIGIBLE`, `POLICY_DENIED`, `DEFERRED`, `CONTROL_OPERATOR`, `TEMPLATE_REQUIRED`, `TEMPLATE_PARAM_NOT_ALLOWED`, `RECIPIENT_NOT_ALLOWED`, `GROUNDING_FAIL`, `UNKNOWN_DELIVERY`, `TURN_CAP`, `AGENT_KILLED`. `CONFLICT` en una acción de dinero trae el `actionId` existente |
| Montos y fechas | Montos en pesos como `{"amount": 118640.00, "text": "$ 118.640,00"}`; fechas ISO con zona del mundo y `…Text` en es-AR ("jueves 22/10"). El modelo copia, no calcula |
| Schemas del Gateway | Solo `type`, `properties`, `required`, `items`, `description`; los `enum` bajan a `description`; zod `.strict()` dentro de la Lambda. Los campos que Cedar prohíbe (`decision`, `capOverride`) se declaran opcionales y documentados ("never set; denied by policy") para que el statement sea válido y se dispare |
| PII | Salidas con teléfono, email, CVU y documento enmascarados (`+54 9 11 •••• 1001`, `v•••@…`, `•••• 4821`, `DNI ••••4417`); ninguna tool devuelve un valor del desafío |
| Bitácora | Toda tool con efecto escribe `AuditLog` con `action`, `actor = AGENT`, `refs {complaintId, turnId, …}`; todo saliente, además, su entrada en la cinta |

Tipos compartidos (`packages/shared/src/enums.ts`):

```json
{
  "PresentationKind": ["CONSULTA", "RECLAMO"],
  "ComplaintType": ["PAYMENT_NOT_REFLECTED", "PAYOFF_CERTIFICATE", "UNRECOGNIZED_CHARGE", "DUPLICATE_DEBIT", "TRANSFER_NOT_CREDITED", "DISBURSEMENT_NOT_RECEIVED", "UNKNOWN_OPERATION", "ACCOUNT_BLOCKED", "CLOSURE_OR_EARLY_PAYOFF", "DATA_CHANGE", "INFORMATION_REQUEST"],
  "ComplaintStatus": ["REGISTERED", "INVESTIGATING", "AWAITING_CUSTOMER", "AWAITING_SETTLEMENT", "AWAITING_NETWORK", "AWAITING_APPROVAL", "HUMAN_REVIEW", "RESOLVED", "ANSWERED", "CLOSED"],
  "ComplaintOrigin": ["SEED", "LIVE"],
  "ComplaintOutcome": ["IN_FAVOUR", "PARTIALLY_IN_FAVOUR", "NOT_IN_FAVOUR", "INFORMATIONAL", "WITHDRAWN"],
  "SlaState": ["ON_TIME", "AT_RISK", "OVERDUE"],
  "SlaMilestone": ["OPERATOR_REMINDER", "SUPERVISOR_ESCALATION", "DEADLINE"],
  "HandoffReason": ["CUSTOMER_ASKED", "LOW_CONFIDENCE", "TWO_FAILED_ATTEMPTS", "FRAUD", "ABOVE_CAP", "IDENTITY_VERIFICATION", "RECEIPT_NOT_FOUND", "RECEIPT_DOUBT", "ACCOUNT_BLOCKED", "RISKY_DATA_CHANGE", "EMAIL_UNDELIVERABLE", "GUARDRAIL_BLOCK", "OTHER"],
  "CapAction": ["APPLY_PAYMENT", "REVERSE_CHARGE", "REFUND_DUPLICATE", "TRANSFER_REVERSAL"],
  "CapTier": ["AGENT", "OPERATOR", "SUPERVISOR"],
  "Network": ["NORTE", "SUR", "TRANSFER", "WALLET"],
  "ReconciliationResult": ["MATCHED", "PAYER_MISMATCH", "ALREADY_APPLIED", "PENDING_BATCH", "NOT_FOUND", "AMOUNT_MISMATCH"],
  "ReceiptResult": ["READ", "UNREADABLE", "INVALID_RECEIPT", "DISAGREE", "NOT_A_RECEIPT", "DUPLICATE_OF"],
  "Channel": ["WHATSAPP", "EMAIL"],
  "ChannelMode": ["live", "simulated"],
  "Sender": ["AGENT", "OPERATOR:<staffId>", "SYSTEM"],
  "MessageKind": ["COMPLAINT_ACK", "ACK_EMAIL", "IDENTITY_CHALLENGE", "REPLY", "RECEIPT_REQUEST", "COMPLAINT_UPDATE", "RESOLUTION_NOTICE", "FORMAL_ANSWER", "HANDOFF_NOTICE", "HOLDING_NOTICE", "OPERATOR_MESSAGE", "SAFETY_GUIDANCE", "OUT_OF_SCOPE_REFUSAL", "OPT_OUT_CONFIRMATION", "DATA_CHANGE_CONFIRMATION", "CLOSURE_CONFIRMATION", "SUPERVISOR_ALERT", "COLLECTION_REMINDER", "COLLECTION_NOTICE_EMAIL"],
  "GateDecision": ["ALLOWED", "BLOCKED", "REROUTED", "DEFERRED"],
  "TapeEntryKind": ["ALLOWED", "BLOCKED", "REROUTED", "DEFERRED", "DISPATCH"],
  "DispatchResult": ["SENT", "FAILED", "UNKNOWN_DELIVERY"],
  "TurnTrigger": ["CUSTOMER_MESSAGE", "RECEIPT_RECEIVED", "SETTLEMENT_PUBLISHED", "TRANSFER_STATUS_CHANGED", "APPROVAL_DECIDED", "OPERATOR_RELEASED", "ANSWER_DUE", "RECONCILE_DUE", "EMAIL_EVENT"],
  "Reroute": ["HUMAN_QUEUE", "FORMAL_EMAIL"],
  "TimerKind": ["SLA", "DEFERRED_SEND", "SETTLEMENT_PUBLISH", "SETTLEMENT_RECHECK", "NETWORK_TRANSITION", "FOLLOW_UP", "AUTO_CLOSE"],
  "TimerFiredBy": ["SCHEDULER", "CLOCK", "PUBLICATION", "MANUAL"],
  "ClockMode": ["PAUSED", "RUNNING"],
  "StaffRole": ["OPERATOR", "SUPERVISOR", "COMPLIANCE", "GUEST"],
  "WaButtonAction": ["TALK_TO_HUMAN", "ACCEPT_EMAIL", "DECLINE_EMAIL", "CHOOSE_LOAN", "OPT_OUT", "CONFIRM_CLOSURE", "WITHDRAW", "SEE_DETAIL", "HAVE_A_QUESTION"],
  "PreferenceFields": {"preferredChannel": ["WHATSAPP", "EMAIL"], "contactWindow": ["MORNING", "AFTERNOON", "ANY"], "formOfAddress": ["VOS", "USTED"]}
}
```

---

## Target `identity` (`ToolIdentity`)

### `identify_customer`
Determinista · lee `Conversations`, core · invocan: `harness`, `worker`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "status": "IDENTIFIED | NEEDS_CHALLENGE | LOCKED", "firstName": "string", "challenge": {"kind": "LAST_DUE_DATE | LAST_INSTALMENT_AMOUNT | LAST_MOVEMENT_AMOUNT", "promptText": "string"}, "attemptsLeft": "integer", "error": "Error"}}
```

Nunca devuelve el valor esperado. El `promptText` sale de `copy/`. `attemptsLeft` sale de `Runtime/W#<w>#CHALLENGE#<customerId>` (fallos del cliente en las últimas 24 h reales, sea cual sea la sesión, el reclamo o la conversación); `LOCKED` tras dos fallos, hasta que una persona del staff lo levante (`customers.unlockChallenge`, auditado). Con un comprobante adjunto en un reclamo abierto, `challenge.kind` nunca es `LAST_INSTALMENT_AMOUNT`.

### `verify_challenge`
Determinista · lee `Conversations` (mensajes de la sesión) · core `challenge-check` · escribe `Conversations/META` y `Runtime` (`IDEMP#CHALLENGE_ANSWER#`) · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "answer": {"type": "string", "description": "customer's answer as written, max 40 chars; only one the customer wrote after the challenge"}}, "required": ["sessionToken", "answer"]},
 "output": {"ok": "boolean", "result": "OK | FAILED | LOCKED", "attemptsLeft": "integer", "identifiedUntilText": "string", "error": "Error"}}
```

**La respuesta es del cliente, nunca del modelo** (`agent-tools/identity/customer-answer.ts` y `answer.ts`, ADR-0005). Antes de llamar al core, el código lee la conversación de la sesión del `sessionToken` y exige: 1) un `IDENTITY_CHALLENGE` que salió (`PENDING`, `SENT`, `DELIVERED`, `READ` o `UNKNOWN_DELIVERY`); 2) un mensaje entrante de WhatsApp **del cliente** escrito después del último de esos desafíos y antes de que se abriera el turno, ordenado por el reloj **real** (`createdAt` del mensaje contra `Session.createdAtReal`): un desafío que se vuelve a mandar empieza de cero y el turno que pregunta no puede verificar; 3) que ese mensaje diga `answer`, normalizado: fechas `5/10`, `05/10`, `5-10-26`, `05.10.2026`, `2026-10-05`, `5 de octubre` (día y mes iguales; un año en `answer` tiene que estar también en el mensaje), montos es-AR al peso o al centavo si `answer` los trae, y un texto sin fecha ni monto solo si es el mensaje entero; 4) que ese mensaje no se haya usado (`Runtime/W#<w>#IDEMP#CHALLENGE_ANSWER#<messageId>`, una sola vez, bien o mal). El core compara el **fragmento que escribió el cliente**, no el string del modelo. Si algo falta, `INVALID` con `reason` `CHALLENGE_NOT_ASKED`, `ANSWER_NOT_WRITTEN` o `ANSWER_ALREADY_USED`, auditoría `CHALLENGE_ANSWER_REFUSED` y **ningún fallo contado**: el error es del modelo, no del cliente. El `promptText` nunca trae un ejemplo que pueda ser una respuesta (`dd/mm`, sin dígitos).

`OK` → `identifiedUntilReal = ahora real + 30 min` (el reloj del mundo no la extiende ni la acorta), borra el conteo de fallos, el reclamo `REGISTERED` pasa a `INVESTIGATING`; `FAILED` suma un fallo al conteo del cliente; `LOCKED` → escalamiento determinista `IDENTITY_VERIFICATION` (lo hace el handler, no el modelo). Un `sessionEpoch` nuevo, un reclamo nuevo o un avance del reloj no reinician el conteo. Auditoría `IDENTIFIED` / `CHALLENGE_FAILED` (con el `messageId` de la respuesta) / `CHALLENGE_LOCKED` / `CHALLENGE_ANSWER_REFUSED`.

## Target `account` (`ToolAccount`)

Todas **Id**, deterministas, sin efectos en el core salvo `quote_early_payoff`. Con un reclamo abierto en la sesión (el último que lista), `get_loan`, `quote_early_payoff`, `get_terms` y `get_fee_rules` dejan en él una `Evidence` (`LOAN_STATUS`, `PAYOFF_QUOTE`, `TERMS_CLAUSE`) con lo que leyeron: es lo que funda el `RESOLVED` de un libre deuda, una cancelación anticipada o una consulta informativa. Una escritura fallida de la evidencia nunca hace fallar la lectura.

### `get_account`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "account": {"status": "ACTIVE | BLOCKED | CLOSING | CLOSED", "blockReason": {"category": "SECURITY_REVIEW | IDENTITY_VALIDATION | EXTERNAL_ORDER | INACTIVITY", "text": "string"}, "emailMasked": "string", "emailSuppressed": "boolean"}, "wallet": {"balance": "Money", "cvuMasked": "string", "outgoingFrozen": "boolean"}, "loans": [{"loanId": "string", "label": "string", "status": "string", "outstanding": "Money"}], "error": "Error"}}
```

### `list_operations`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "fromDate": {"type": "string"}, "toDate": {"type": "string"}, "kind": {"type": "string", "description": "one of: PAYMENT, CHARGE, TRANSFER_IN, TRANSFER_OUT, DISBURSEMENT, DEBIT, ALL"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "operations": [{"operationId": "string", "kind": "string", "atText": "string", "amount": "Money", "description": "string", "status": "string", "ref": {"loanId": "string", "instalment": "integer", "chargeId": "string", "transferId": "string"}}], "truncated": "boolean", "error": "Error"}}
```

Máximo 90 días y 50 filas.

### `get_loan`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "loanId": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "loan": {"loanId": "string", "principal": "Money", "instalmentsCount": "integer", "paidCount": "integer", "status": "ACTIVE | IN_ARREARS | CANCELLED | EARLY_CANCELLED", "outstanding": "Money", "cancelledAtText": "string", "nextDue": {"number": "integer", "dueText": "string", "amount": "Money"}}, "error": "Error"}}
```

### `get_instalments`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "loanId": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "instalments": [{"number": "integer", "dueText": "string", "amount": "Money", "outstanding": "Money", "status": "DUE | PAID | PARTIALLY_PAID | OVERDUE", "payments": [{"paymentId": "string", "network": "string", "operationCode": "string", "amount": "Money", "appliedAtText": "string"}]}], "error": "Error"}}
```

### `get_fee_rules`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "feeCode": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "scheduleVersion": "string", "fees": [{"feeCode": "string", "label": "string", "basis": "string", "whenApplies": "string", "clauseIds": ["string"]}], "error": "Error"}}
```

### `get_terms`
No exige identificación (texto público del producto).

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "topic": {"type": "string", "description": "one of: LOANS, LATE_INTEREST, WALLET, TRANSFERS, EARLY_PAYOFF, CLOSURE, FEES, COMPLAINT_RIGHTS, DATA_PROTECTION"}, "clauseIds": {"type": "array", "items": {"type": "string"}}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "termsVersion": "string", "clauses": [{"clauseId": "string", "title": "string", "text": "string", "label": "string"}], "error": "Error"}}
```

`label` = "condiciones sintéticas de un prestamista ficticio" o, en `COMPLAINT_RIGHTS`, "nuestra lectura de las normas, no asesoramiento legal". Máximo 8 cláusulas.

### `quote_early_payoff`
**Id** · core `payoff-quote` · escribe `PayoffQuote` · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "loanId": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "quoteId": "string", "total": "Money", "breakdown": {"principal": "Money", "accruedInterest": "Money", "fee": "Money", "feeClauseId": "string"}, "validUntilText": "string", "error": "Error"}}
```

## Target `investigation` (`ToolInvestigation`)

Todas **Id** y **Rc**; escriben una `Evidence` en el reclamo y devuelven su `evidenceId`.

### `read_receipt`
Bedrock `Converse` multimodal + respaldo determinista (`docs/architecture-integrations.md` §7).

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "evidenceId": {"type": "string", "description": "RECEIPT_IMAGE evidence of this complaint"}}, "required": ["sessionToken", "evidenceId"]},
 "output": {"ok": "boolean", "result": "ReceiptResult", "readingId": "string", "source": "BEDROCK | FALLBACK | BOTH_AGREE | DISAGREE", "fields": {"network": "Network", "operationCode": "string", "amount": "Money", "paidAtText": "string"}, "duplicateOf": "string", "attemptsLeft": "integer", "error": "Error"}}
```

Efectos: `Evidence RECEIPT_READING`; `SUSPICIOUS_RECEIPT_TEXT` auditado si corresponde; métrica de respaldo. La imagen nunca vuelve en la salida. El respaldo determinista solo se usa si Bedrock **no está disponible**; nunca convierte un `ILLEGIBLE` o `PARTIAL` incompleto en `READ` (`docs/architecture-integrations.md` §7). Antes de llamar a Bedrock: corte del agente, tope diario de lecturas de imagen del mundo y tope global (`TURN_CAP` / `AGENT_KILLED` sin leer).

### `reconcile_payment`
Determinista · lee lotes y CSV publicados, core.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "readingId": {"type": "string", "description": "READ receipt reading of this complaint; required when source is SETTLEMENT"}, "source": {"type": "string", "description": "one of: SETTLEMENT, WALLET, TRANSFER"}, "movementId": {"type": "string", "description": "for WALLET or TRANSFER"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "result": "ReconciliationResult", "reconciliationId": "string", "match": {"network": "Network", "businessDateText": "string", "operationCode": "string", "amount": "Money", "batchSha256": "string"}, "pendingBatch": {"network": "Network", "publishAtText": "string"}, "appliedAtText": "string", "error": "Error"}}
```

zod exige `readingId` cuando `source = SETTLEMENT` (sin lectura no hay conciliación contra una red; `INVALID`). La línea tiene que ser del cliente de la sesión y de uno de sus préstamos (`customerRef`, `loanRef`): si no, `PAYER_MISMATCH`, que el handler resuelve por código (auditoría `PAYER_MISMATCH`, `HUMAN_REVIEW` `RECEIPT_DOUBT`, `HANDOFF_NOTICE`), sin `match` ni ningún dato del otro pagador en la salida. `appliedAtText` solo sale con `ALREADY_APPLIED` de una imputación **al mismo cliente**; una imputación de otro cliente es `PAYER_MISMATCH`. `PENDING_BATCH` crea el timer `SETTLEMENT_RECHECK` con dueño `BATCH#<network>#<businessDate>` (idempotente por reclamo y lote): la publicación del lote lo despacha en el acto.

### `check_charge`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "chargeId": {"type": "string"}}, "required": ["sessionToken", "chargeId"]},
 "output": {"ok": "boolean", "chargeCheckId": "string", "verdict": "CORRECT | WRONG | UNDETERMINED", "charged": "Money", "expected": "Money", "feeCode": "string", "clauseIds": ["string"], "reasonText": "string", "error": "Error"}}
```

### `check_duplicate_debit`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "loanId": {"type": "string"}, "instalment": {"type": "integer"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "duplicateCheckId": "string", "verdict": "DUPLICATE | NOT_DUPLICATE", "debits": [{"debitId": "string", "atText": "string", "amount": "Money", "instalment": "integer"}], "refundable": "Money", "error": "Error"}}
```

### `get_transfer_status`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "transferId": {"type": "string"}}, "required": ["sessionToken", "transferId"]},
 "output": {"ok": "boolean", "status": "COMPLETED | PENDING | REJECTED_REVERSED | REJECTED_NOT_REVERSED | UNKNOWN", "traceId": "string", "completedAtText": "string", "expectedByText": "string", "rejectReasonText": "string", "reversedAtText": "string", "direction": "IN | OUT", "amount": "Money", "error": "Error"}}
```

### `get_disbursement`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "loanId": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "status": "PENDING | CREDITED | FAILED_RETURNED | HELD_REVIEW", "gross": "Money", "originationFee": "Money", "net": "Money", "creditedAtText": "string", "expectedByText": "string", "error": "Error"}}
```

## Target `actions` (`ToolActions`)

Todas **Id** y **Rc**, con efectos en el core y `LAM-CONTROL`. Las cuatro de monto aplican `LAM-EVIDENCE` y `LAM-CAP`: el monto lo toma el código de la evidencia y del core; el agente nunca lo escribe. Sobre el tope devuelven `ABOVE_CAP` con `{capAction, capTier, amount}` y **no** actúan. **Una sola ejecución por clave natural**, no por reclamo: el core toma en la misma transacción el claim `OPC#<network>#<operationCode>` (`apply_payment`), `REV#<chargeId>` (`reverse_charge`), `RFD#<debitId>` (`refund_duplicate_debit`) o `TRV#<transferId>` (`request_transfer_reversal`); un segundo intento (otro reclamo sobre el mismo débito cuando el primero ya está `ANSWERED`, una aprobación repetida, un reintento) devuelve `CONFLICT` con el `actionId` existente y no mueve dinero. Toda llamada al core lleva el `customerId` de la sesión.

### `apply_payment`
Manda al core `{customerId, complaintId, reconciliationId, …}`; el core rechaza un préstamo que no es del cliente.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "reconciliationId": {"type": "string", "description": "MATCHED reconciliation of this complaint"}, "capOverride": {"type": "string", "description": "never set; denied by policy"}}, "required": ["sessionToken", "reconciliationId"]},
 "output": {"ok": "boolean", "actionId": "string", "applied": "Money", "allocations": [{"instalment": "integer", "amount": "Money", "statusAfter": "string"}], "loanStatusAfter": "string", "error": "Error"}}
```

### `reverse_charge`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "chargeCheckId": {"type": "string", "description": "WRONG charge check of this complaint"}, "capOverride": {"type": "string", "description": "never set; denied by policy"}}, "required": ["sessionToken", "chargeCheckId"]},
 "output": {"ok": "boolean", "actionId": "string", "reversed": "Money", "compensatoryInterest": "Money", "creditNoteId": "string", "rateLabel": "string", "error": "Error"}}
```

Escribe `RefundEntry` en el registro de reintegros.

### `refund_duplicate_debit`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "duplicateCheckId": {"type": "string"}, "capOverride": {"type": "string", "description": "never set; denied by policy"}}, "required": ["sessionToken", "duplicateCheckId"]},
 "output": {"ok": "boolean", "actionId": "string", "refunded": "Money", "creditNoteId": "string", "error": "Error"}}
```

### `request_transfer_reversal`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "transferEvidenceId": {"type": "string", "description": "TRANSFER_STATUS evidence with REJECTED_NOT_REVERSED"}, "capOverride": {"type": "string", "description": "never set; denied by policy"}}, "required": ["sessionToken", "transferEvidenceId"]},
 "output": {"ok": "boolean", "actionId": "string", "reversed": "Money", "creditedAtText": "string", "error": "Error"}}
```

### `freeze_outgoing`
Sin tope (protección). Solo en reclamos `UNKNOWN_OPERATION`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "reason": {"type": "string", "description": "one of: UNKNOWN_OPERATION, CUSTOMER_REQUEST"}}, "required": ["sessionToken", "reason"]},
 "output": {"ok": "boolean", "actionId": "string", "frozenAtText": "string", "error": "Error"}}
```

No existe una tool para levantar el bloqueo.

### `request_account_closure`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "confirmNonce": {"type": "string", "description": "nonce of the CONFIRM_CLOSURE button the customer tapped"}}, "required": ["sessionToken", "confirmNonce"]},
 "output": {"ok": "boolean", "actionId": "string", "accountStatusAfter": "CLOSING", "conditionsText": ["string"], "error": "Error"}}
```

El `confirmNonce` tiene que ser el del botón que tocó el cliente en esta conversación (`LAM-EVIDENCE`).

### `request_data_change`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "field": {"type": "string", "description": "one of: EMAIL, ADDRESS, PHONE"}, "sourceMessageId": {"type": "string", "description": "customer message that contains the new value"}}, "required": ["sessionToken", "field", "sourceMessageId"]},
 "output": {"ok": "boolean", "actionId": "string", "status": "PENDING_CONFIRMATION | REFERRED", "confirmationSentTo": "string", "error": "Error"}}
```

El valor nuevo lo extrae el código del mensaje del cliente (nunca el modelo); `PHONE` o cuenta en revisión → `REFERRED` (caso humano `RISKY_DATA_CHANGE`).

## Target `complaints` (`ToolComplaints`)

### `register_complaint`
Invocan: `harness` (sin **Id**: el número se da antes del desafío). Idempotente por mensaje de origen.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "kind": {"type": "string", "description": "CONSULTA | RECLAMO"}, "type": {"type": "string", "description": "ComplaintType"}, "summary": {"type": "string", "description": "one sentence, max 200 chars, no personal data"}, "sourceMessageId": {"type": "string"}}, "required": ["sessionToken", "kind", "type", "summary", "sourceMessageId"]},
 "output": {"ok": "boolean", "complaintId": "string", "complaintNumber": "string", "deadlineText": "string", "existing": "boolean", "error": "Error"}}
```

Efectos (código): número, `FILED` en el registro, reclamo, tres hitos e idempotencia en **una** transacción (`docs/architecture.md` §8.2); después, `COMPLAINT_ACK` por la compuerta (texto fijo, con el aviso de automatización si es el primer saliente) y el ancla de `FILED`. `existing = true` si ya había uno abierto del mismo tipo y objeto. `kind CONSULTA` usa `type INFORMATION_REQUEST`. El `summary` pasa por el enmascarador.

### `update_complaint`
**Id** y **Rc** · `LAM-CONTROL`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "complaintId": {"type": "string"}, "status": {"type": "string", "description": "one of: AWAITING_CUSTOMER, AWAITING_SETTLEMENT, AWAITING_NETWORK, INVESTIGATING, RESOLVED"}, "outcome": {"type": "string", "description": "ComplaintOutcome, only with RESOLVED or WITHDRAWN"}, "withdrawn": {"type": "boolean"}, "followUpAtSim": {"type": "string"}, "note": {"type": "string", "description": "internal, max 300 chars"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "status": "ComplaintStatus", "version": "integer", "error": "Error"}}
```

Solo transiciones permitidas por la máquina de estados para el agente (`HUMAN_REVIEW`, `AWAITING_APPROVAL`, `ANSWERED` y `CLOSED` no se piden acá: los producen `escalate_to_human`, `request_operator_approval` y `answer_complaint_in_writing`). `RESOLVED` exige una acción o evidencia que lo funde. Exige la sesión identificada aunque solo agregue una nota: un retiro resuelve el reclamo y cancela su reloj regulatorio, y nada de eso puede pasar sin el desafío verificado por código ni con la conversación en manos de un operador.

### `answer_complaint_in_writing`
**Id** y **Rc** · PDF + SES por la compuerta.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "complaintId": {"type": "string"}, "outcome": {"type": "string", "description": "ComplaintOutcome"}, "draftBody": {"type": "string", "description": "Spanish, max 2500 chars; facts must come from this turn's tool results"}, "requestedAttachments": {"type": "array", "items": {"type": "string"}, "description": "subset of: PAYOFF_CERTIFICATE, CREDIT_NOTE, STATEMENT; the code adds or removes by eligibility"}}, "required": ["sessionToken", "outcome", "draftBody"]},
 "output": {"ok": "boolean", "messageId": "string", "mailId": "string", "attachments": ["string"], "status": "SENT | DEFERRED", "deliveryProof": "SENT", "error": "Error"}}
```

Reglas: exige `emailAnswerConsent` aceptado (si no → `NOT_ELIGIBLE` y el agente deriva); el reclamo en `RESOLVED` (o `WITHDRAWN`); `requestedAttachments` solo de la lista permitida (`CED-ATTACHMENTS-ALLOWLIST` y zod enum); adjuntos por elegibilidad (`complaints/answer.ts`); G2 (con grounding) + verificación sobre `draftBody`; `CH-FORMAL-CONTENT`. Orden (código): `answer.inFlight` condicional (un doble envío choca acá) → `FINAL_ANSWER` en el registro con `bodySha256` → PDF `ANSWER` en `Documents` con los hashes de `FILED` y `FINAL_ANSWER` → `.eml` en `Emails` → compuerta → transición `ANSWERED`, `cancel_milestones`, timer `AUTO_CLOSE`.

## Target `messaging` (`ToolMessaging`)

### `send_whatsapp`
Compuerta · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {
   "sessionToken": {"type": "string"},
   "kind": {"type": "string", "description": "one of: REPLY, IDENTITY_CHALLENGE, RECEIPT_REQUEST, COMPLAINT_UPDATE, RESOLUTION_NOTICE, OUT_OF_SCOPE_REFUSAL (Cedar CED-WA-KIND-ALLOWLIST)"},
   "text": {"type": "string", "description": "Spanish, only inside the 24 h window, max 900 chars"},
   "template": {"type": "object", "properties": {"name": {"type": "string"}, "params": {"type": "array", "items": {"type": "string"}, "description": "values from this turn's tool results; for reclamo_novedad {{3}}, a status phrase id from the closed list"}}}},
   "buttons": {"type": "array", "items": {"type": "object", "properties": {"action": {"type": "string", "description": "WaButtonAction"}, "ref": {"type": "string"}}}},
   "complaintId": {"type": "string"}},
  "required": ["sessionToken", "kind"]},
 "output": {"ok": "boolean", "messageId": "string", "decision": "GateDecision", "ruleIds": ["string"], "deferredUntilText": "string", "reroutedTo": "string", "error": "Error"}}
```

Reglas: el destinatario no es un campo del input: es siempre el teléfono de la sesión (invariante del schema, `LAM-SCOPE`); el botón `TALK_TO_HUMAN` ("Hablar con alguien") se agrega siempre por código; solo los `kind` de la lista permitida (Cedar `CED-WA-KIND-ALLOWLIST`, zod y la compuerta); a lo sumo **un** `COMPLAINT_UPDATE` por evento que disparó el turno (`LAM-ONCE-PER-EVENT`; el segundo → `CONFLICT`); parámetros de plantilla que no están en `TURN#` (o en el reclamo del mensaje) según su tipo → `GROUNDING_FAIL` (número de reclamo, plazo, email enmascarado y nombre exactos, los mismos hechos que vuelve a mirar la compuerta, `outbound/template-grounding.ts`), y `{{3}}` de `reclamo_novedad` fuera de la lista cerrada → `TEMPLATE_PARAM_NOT_ALLOWED`. Efectos: mensaje, cinta, `DEFERRED_SEND` si corresponde.

## Target `handoff` (`ToolHandoff`)

### `escalate_to_human`
```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "complaintId": {"type": "string"}, "reason": {"type": "string", "description": "HandoffReason"}, "summary": {"type": "string", "description": "for the operator, max 500 chars"}}, "required": ["sessionToken", "reason", "summary"]},
 "output": {"ok": "boolean", "status": "HUMAN_REVIEW", "handoffNoticeMessageId": "string", "error": "Error"}}
```

Efectos: transición `HUMAN_REVIEW` (o `HumanTask` de la conversación si no hay reclamo), `HANDOFF_NOTICE` por la compuerta, prioridad `HIGH` si `FRAUD` y `SUPERVISOR_ALERT`.

### `request_operator_approval`
**Rc**.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "complaintId": {"type": "string"}, "evidenceId": {"type": "string", "description": "the reconciliation, charge check, duplicate check or transfer evidence that justifies the action"}, "justification": {"type": "string", "description": "max 500 chars"}, "decision": {"type": "string", "description": "never set; denied by policy"}}, "required": ["sessionToken", "evidenceId", "justification"]},
 "output": {"ok": "boolean", "approvalId": "string", "capTier": "OPERATOR | SUPERVISOR", "amount": "Money", "status": "PENDING", "error": "Error"}}
```

Solo después de un `ABOVE_CAP` de la misma evidencia; acción y monto los fija el código; el `Approval` guarda la época y vence a los 2 días hábiles simulados; `AWAITING_APPROVAL`; `COMPLAINT_UPDATE` al cliente ("lo tiene que aprobar una persona"). **No existe una tool que apruebe** (`CED-NO-SELF-APPROVAL`, `LAM-STRICT`); la ejecución la hace `execute_approved_action` releyendo la aprobación.

---

## Handlers de invocación directa (no están en el Gateway)

Funciones en proceso: las llama el código que ya autenticó a su principal (cola, JWT, rol de QA, input condicional del Scheduler). Ninguna Lambda desplegada acepta un `caller` del exterior.

| Handler | Principales | Qué hace | Efectos | Bitácora |
|---|---|---|---|---|
| `verify_sender` | `channel` | Verifica origen (firma SNS o sobre simulado firmado, `docs/architecture.md` §13) y `phoneHash` → cliente del mundo (único por `PHONE#`; en vivo, solo por `LIVEPHONE#`) | — | `DENY UNKNOWN_SENDER` / `INBOUND_REJECTED` |
| `classify_intake` | `channel` | Reglas + `Converse` forzado con Haiku (`docs/architecture-integrations.md` §10) | — | `ACTION INTAKE_CLASSIFIED` |
| `acknowledge_complaint` | `channel`, `harness` (vía `register_complaint`) | Número, `FILED`, reclamo, hitos e idempotencia por `eventId` en una transacción; después `COMPLAINT_ACK` | `Complaints`, `Register`, `Timers`, cinta, ancla | `ACTION COMPLAINT_REGISTERED` |
| `record_email_consent` | `channel` (nonce `ACCEPT_EMAIL`/`DECLINE_EMAIL`), `qa` | Guarda la aceptación con fecha y versión del texto; manda `ACK_EMAIL` | `Complaints` | `ACTION EMAIL_CONSENT` |
| `schedule_sla_milestones` / `cancel_milestones` | `harness` (dentro de register/answer), `worker`, `console` | Crea (en `RUNNING`) o borra los schedules de los tres timers; los cancela | `Timers`, Scheduler | `ACTION` |
| `fire_timer` | `scheduler`, `worker` (reloj) | Despacha por `kind` con `eventAtSim = dueAtSim`; en `SETTLEMENT_PUBLISH`, despacha los rechequeos del lote y encola `SETTLEMENT_PUBLISHED`; descarta disparos tardíos y nombres de schedule que no coinciden (`docs/architecture.md` §10) | `Timers` y lo que dispare | `TIMER_FIRED` / `LATE_FIRE_DISCARDED` |
| `run_obligations` | `worker` | Obligaciones después del turno (`docs/architecture.md` §7): `ANSWER_DUE`, `RECONCILE_DUE`, `HOLDING_NOTICE`, caso humano | Cola, compuerta, `Complaints` | `ANSWER_DUE` / `RECONCILE_DUE` / `AGENT_SILENT` / `ANSWER_OBLIGATION_FAILED` |
| `enqueue_customer_event` | `channel`, `console`, `scheduler`, `worker`, `qa` | Único productor de las colas: elige la cola por `worldId`, arma el `MessageGroupId` y rechaza un mundo que el principal no puede tocar | SQS, `WORLDSTATE` | `DENY CROSS_WORLD` si rechaza |
| `handle_guardrail_block` | `worker`, `channel` | Respuesta fija por la compuerta, escalamiento `GUARDRAIL_BLOCK`, `sessionEpoch + 1` si vino del Harness | `Conversations`, `Complaints` | `GUARDRAIL_BLOCK` / `GUARDRAIL_MASK` |
| `record_email_event` | `channel` (`EmailEvents`) → `worker` | `EmailEvents` valida origen, cuenta, configuration set y `EmailRecord` y encola; el worker aplica constancia, `DELIVERY_PROOF`, rebote/queja → `HUMAN_REVIEW` y manda la novedad | `Conversations`, `Complaints`, `Register` | `ACTION EMAIL_EVENT` / `EMAIL_EVENT_REJECTED` |
| `record_media` | `channel` (`MediaIntake` e `InboundWhatsApp`, por `media-intake/resolve.ts`) | Resuelve el `SCANOBJ#` de un objeto (buscado por `announceKeyOf(objectKey)`: prefijo `wa/<w>/<wamid>/` en vivo, clave exacta en `up/` y `sim/`; lee el objeto siempre por `s3Key`) cuando tiene resultado **y** mensaje vinculado, en cualquier orden (`docs/architecture.md` §6): evidencia `RECEIPT_IMAGE` tras `NO_THREATS_FOUND` (o de inmediato para una copia del seed con hash conocido); con `THREATS_FOUND`, `ACCESS_DENIED`, `FAILED`, `UNSUPPORTED` o sin resultado ni etiqueta a los 120 s de la vinculación, cierra el `SCAN#` y encola `MEDIA_REJECTED` (respuesta fija `IMAGE_NOT_PROCESSED`); nunca espera en silencio y nunca pierde un resultado que llegó antes que el mensaje | `Complaints`, `Runtime` (`SCANOBJ#`), S3, cola | `ACTION MEDIA_ACCEPTED` / `SCAN_RESOLVED` (`order`) / `MALWARE` / `SCAN_NOT_COMPLETED` / `SCAN_RESULT_LATE` / `SCAN_RESULT_ORPHAN` / `SCAN_WAIT_SKIPPED_SEED` / `MEDIA_KEY_UNRESOLVED` |
| `decide_approval` | `console` (tier según rol, login ≤ 15 min), `qa` | `APPROVED` → encola `APPROVAL_DECIDED` con **solo** el `approvalId`; `REJECTED` con motivo → `HUMAN_REVIEW`. Una aprobación vencida (2 días hábiles simulados) o de otra época no se puede decidir | `Complaints`; `AuditLog` append-only | `ACTION APPROVED` / `REJECTED` con `staffId` |
| `execute_approved_action` | `worker` | Relee el `Approval` con lectura fuertemente consistente (`APPROVED`, `decidedBy`, misma época, vigente, sin `executedAt`); `Put` condicional de `EXEC#<approvalId>`; recalcula monto y tier desde el core; ejecuta con el claim de clave natural o, si el monto creció o el tier cambió, `HUMAN_REVIEW` (`docs/architecture.md` §8.5). Nunca confía en el payload del evento | Core, `Complaints`, `Register` (reintegros) | `ACTION EXECUTED` / `APPROVAL_NOT_EXECUTABLE` |
| `take_over` / `hand_back` | `console`, `qa` | `control = OPERATOR` / `AGENT`; el hand-back encola `OPERATOR_RELEASED` con los ids de los mensajes del operador desde la toma | `Conversations` | `TAKEOVER` / `RELEASE` |
| `operator_send` | `console`, `qa` | Encola `OPERATOR_SEND`; la compuerta decide | Cinta | `ALLOWED` / `BLOCKED` |
| `operator_reroute` | `console`, `qa` | Elige un reencaminamiento de un `BLOCKED` (`HUMAN_QUEUE` o `FORMAL_EMAIL`) | Cinta, `HumanTask` | `REROUTED` |
| `operator_answer` | `console` (login ≤ 15 min), `qa` | Respuesta escrita del operador (PDF + SES por la compuerta), con `answer.inFlight` condicional | Igual que `answer_complaint_in_writing` | `ACTION ANSWERED` |
| `advance_clock` | `console`, `qa` | `advance`, `advanceTo`, `advanceToNext({complaintId?})`, `advanceBusinessDay`, `setRunning({rate})` (1-2.880 desde la consola; más solo `qa` en mundos `qa-*`), `pause`; `WORLD_BUSY` desde la consola | `Runtime/W#<w>#CLOCK`, timers, Scheduler (≤ 50 schedules por mundo) | `CLOCK_ADVANCED` / `CLOCK_FORCED` |
| `create_world` / `reset_world` | `create_world`: `console:invite` (operador, capacidad `WORLDS` de las herramientas del seed; mundos de invitado, antes de entregar la credencial), `qa` (`world.create`, `guest.invite`), `seed:load` (`demo`, `qamin`, `gprobe`), el trabajador de reinicio. `reset_world` **se pide** desde `console` (`clock.reset`: `OPERATOR` en `demo`, `GUEST` en su `gNN`, login reciente), `qa` (`console.clock.reset`) o la pasada nocturna de `WorldJanitor`, y **se ejecuta** solo en `WorldJanitor`. **Nunca** el trigger de Cognito: un login solo lee el mundo y exige `READY` | Fábrica de mundos (`docs/architecture.md` §10): `REGISTERED → CREATING → READY` condicional, por bloques con cursor. Reinicio **asíncrono y reanudable**: el pedido es una transacción (`READY → RESETTING` condicional, época + 1, tumba, ticket `RESETREQ#`) + invocación asíncrona de `WorldJanitor` con solo `{worldId, requestId}`, y responde enseguida (`{status: RESETTING, requestId}`, HTTP 202); el trabajo (`WIPE` por `WorldIndex` **excluyendo** `W#<w>#WORLD` `META`/`SETTINGS`/`STAFF#`, `OBJECTS`, `RELOAD`, `PURGE`) guarda fase y latido, se reinvoca antes de su timeout y lo retoma la pasada horaria si muere; `READY` se escribe **último**. Sin tocar `Register`, `ComplianceTape` ni `AuditLog` | Todo el mundo | `WORLD_CREATED` / `WORLD_RESET_REQUESTED` / `WORLD_RESET` (con duración) / `WORLD_RESETTING` (409 o evento descartado) / `RESET_REQUEST_MISSING` / `WORLD_NOT_READY` (trigger) |
| `policy_audit` | `scheduler`, `qa` | Cuatro chequeos (`docs/architecture.md` §12) | `AuditLog VIOLATION` | — |
| `verify_register_chain` | `console`, `qa`, `PolicyAudit` | Recorre la partición, recalcula la cadena y la compara con las anclas leídas con `FilterLogEvents` y ordenadas por `ingestionTime`: vale la primera ingerida de cada `seq`; dos que no coinciden → `ANCHOR_CONFLICT` (rotura, `ChainBroken`); un stream con otro nombre se ignora y se informa; un `seq` sin ancla → `partial`. Devuelve `{result: ok \| partial \| broken, brokenAt?, anchorConflicts[], unanchored[], foreignAnchors[]}` (`docs/architecture.md` §8.3) | — | `ACTION REGISTER_VERIFIED` con el resultado |
| `export_register` | `console` | CSV/JSON + encabezado con el resultado de la verificación (`ok`, `partial` con los `seq` sin ancla, o `broken`) + hash de cabeza + clave publicada + anclas con `ingestionTime` y stream en `Exports`; toda celda que empieza con `=`, `+`, `-`, `@`, tabulador o CR lleva una comilla simple adelante; URL prefirmada 5 min | S3 | `ACTION REGISTER_EXPORTED` |
| `register_guest` | `cognito` (trigger post-confirmation), `public` (`signup.confirm`, reparación idempotente), `qa` (`guest.confirm`) | Solo desde el pedido `SIGNUP#<clientMetadata.signupId>` cuyo `subKey` es el `sub` (si no, nada y `SIGNUP_REJECTED SIGNUP_MISMATCH`). En una transacción: lead `LEAD#<sub>` con los consentimientos de ese pedido, pedido `CONFIRMED`, `CANON#` + 1, mundo `gs-*` (o `qa-<runId>-su*`) `REGISTERED` con `STAFF#` `GUEST` y ticket `PROVISIONREQ#`; después invoca en asíncrono `WorldJanitor` (`WORLD_CREATE`) y `LeadNotifier`. Idempotente por `sub` | `Leads`, `Worlds`, `Runtime` | `GUEST_REGISTERED` (sin email) |
| `render_auth_message` | `cognito` (trigger custom message) | Asunto y cuerpo es/en de `copy/auth-mail.ts` según `triggerSource` y `clientMetadata.locale`; invitación del personal sin cambios | — | — |
| `provision_guest_world` / `expire_guest_world` | `WorldJanitor` (ticket `PROVISIONREQ#`, pasada cada 5 minutos) | Consume la cola `GuestIndex` dentro del cupo (`GUESTCAP#ACTIVE`: 40 activos, 3 creando) con `create_world('guest', …)`; vence los `gs-*` sin ningún ingreso a las 6 h de `READY`, sin actividad en 72 h reales o con 7 días desde `READY` (fases del reinicio sin `RELOAD`, `EXPIRED`); borra cuentas sin confirmar de más de 48 h (`docs/architecture-guests.md` §5-§6) | `Worlds`, `Runtime`, tablas del mundo, Memory, Cognito | `GUEST_WORLD_READY` / `GUEST_WORLD_EXPIRED` / `PROVISION_REQUEST_MISSING` |
| `notify_lead` | `LeadNotifier` (invocación asíncrona) | Relee el lead; con `LeadNotifyEmail` válido (una dirección `@craftech.io`), un email por `outbound/transports/lead-notice.ts`; nunca para un lead de QA; tope 100 por día | `Leads` (`notifiedAtReal`), SES | `LEAD_NOTICE_SENT` / `LEAD_NOTICE_SKIPPED` |
| `export_leads` / `delete_lead` | Operador (`npm run leads:export`, `npm run leads:delete`, profile `craftech-demos`) | CSV escapado de leads (por defecto, con consentimiento de contacto); borrado: `AdminUserGlobalSignOut`, fila `STAFF#` inactiva, usuario de Cognito, mundo, lead, pedidos, `PENDING#` y `CANON#`, con constancia `LEADDEL#` | `Leads`, Cognito, `Worlds` | `LEAD_DELETED` (hash) |

## Procedimientos de la consola (tRPC)

Todo procedimiento pasa por `worldProcedure`, salvo los públicos `signup.*` y `password.*`, que pasan por `publicEdgeProcedure` (sin JWT) y se sirven solo en `/api/public/<procedimiento>`, sin batching (`docs/architecture-guests.md` §4). Toda ruta del `Bff` exige la cabecera de borde. **W** = mutación (rechazada para `COMPLIANCE`); **R** = login ≤ 15 min; **T** = tier de tope según rol.

| Router | Procedimientos |
|---|---|
| `inbox` | `list` (filtros, orden por plazo, `slaState`, quién bloquea, tareas humanas) |
| `complaints` | `get`, `timeline` (mensajes, emails con constancia, cinta, tools redactadas, hitos, pendientes con motivo), `evidenceUrl` (GET prefirmado que la consola descarga con `fetch()` a `blob:`), `answer` (**W R**), `escalate` (**W**), `note` (**W**) |
| `conversation` | `take` (**W**), `release` (**W**), `send` (**W**), `reroute` (**W**) |
| `customers` | `get` (core en lectura), `compose` (**W**: tipo de mensaje y canal; acá vive "Recordatorio de mora"), `unlockChallenge` (**W**, `OPERATOR`/`SUPERVISOR`, auditado) |
| `approvals` | `list`, `decide` (**W R T**) |
| `tape` | `list` (filtros por decisión, regla, emisor, canal, reclamo), `export` (CSV escapado) |
| `register` | `list`, `verify` (cadena y anclas), `export` (CSV escapado) |
| `emails` | `list`, `get` (partes del `.eml`, eventos, SHA-256), `attachmentUrl` |
| `simulator` | `personas`, `threads`, `sendText`, `tapButton`, `attachReceipt`, `presignReceipt` (≤ 3,75 MB, `up/<worldId>/`; escribe el `SCANOBJ#` de la clave antes de firmar), `markRead` (solo con el mundo en `simulated`; **W** salvo lectura) |
| `clock` | `get` (modo, hora, `rate`, próximos timers, `busy` y pendientes), `advance`, `advanceTo`, `advanceToNext` (con `complaintId` opcional: "Avanzar al próximo hito de este reclamo"), `advanceBusinessDay`, `setRunning` (`rate` 1-2.880), `pause`, `fireNow` (**W**; `WORLD_BUSY`), `reset` (**W R**, solo el mundo del usuario; escribe el pedido, invoca `WorldJanitor` en asíncrono y responde `{status: RESETTING, requestId}` con HTTP 202 en < 1 s; nunca hace el trabajo en la request), `resetStatus` (el único procedimiento que responde con el mundo `RESETTING`: `{status, phase, startedAtReal}` para el sondeo de la consola) |
| `metrics` | `summary` (por pestaña; cada KPI con N, fuente, rótulo y `origin`), `export` (CSV escapado) |
| `policy` | `rules` (reglas `CH-*` con versión y parámetros del mundo), `modes` (del mundo), `setAgentKill` (**W R**, solo `SUPERVISOR` del mundo `demo`: activa o levanta `KILL#AGENT`, auditado) |
| `tour` | `steps` (fechas completadas desde `clock.get`, presupuesto de tiempo por bloque, chequeo de mundo prístino), `run(step)` |
| `signup` (público) | `availability` (`open` \| `closed`), `start` (devuelve el `signupId`), `confirm` y `resend` (exigen el `signupId` del pedido vigente) (`docs/architecture-guests.md` §4: entradas zod `.strict()`, topes, pedido de alta, `GuestSignupClient`; respuestas `CODE_SENT`, `EMAIL_TAKEN`, `CONFIRMED`, `CODE_MISMATCH`, `CODE_EXPIRED`, `SIGNUP_RESTART`, `INVALID_EMAIL`, `EMAIL_NOT_ACCEPTED`, `WEAK_PASSWORD`, `CONSENT_REQUIRED`, `RATE_LIMITED`, `SIGNUP_UNAVAILABLE`) |
| `password` (público) | `forgot` (respuesta neutral `CODE_SENT_IF_EXISTS`), `reset`; los dos actúan solo sobre cuentas de alta propia (el personal y los `guest-NN` no recuperan por email) |
| `guest` | `status` (abierto con el mundo en cualquier estado: `worldStatus`, posición en la cola, vencimiento, uso del día; registra el último ingreso), `requestWorld` (**W**, solo `gs-*` con el mundo `EXPIRED`) |
| `health` | `ping` (superficial: 200 sin llamar a nada; el chequeo profundo de los mocks es solo `QaDriver probe.mocks`) |
| `account` | `changePassword` (**W R**; verifica la contraseña actual con `AdminInitiateAuth` y usa `AdminSetUserPassword`; rechazado para `GUEST`), `session` (aviso de otra sesión). El alta de TOTP ocurre dentro del login (desafío `MFA_SETUP`), no por un procedimiento: el access token no tiene el scope de administración de usuario |

## Acciones del `QaDriver`

Invocación directa (`lambda:InvokeFunction`) del rol `qa-runner`, solo desde CI. Toda acción que muta exige un mundo permitido:

| Mundo | Acciones permitidas |
|---|---|
| `qa-*` | Todas |
| `qamin` | Solo `wa.inbound`, `snapshot`, `conv.settleProbe`, `memory.inspect`, `console.clock.reset` (sin límite) y `console.clock.resetStatus`, `metrics.get` |
| `sim-*` | Solo `batch.run` (crea sus propios mundos) |
| `gprobe` | Solo `fence.probe({kind: WORLD_PATHS})`, que lo lee (IAM de solo lectura) y espera un rechazo en cada camino |
| Cualquier otro (`demo`, `gNN`, `gtest`, `gs-*`) | Ninguna: `FORBIDDEN` en `qa-driver/guard.ts`. Además, lo que el `QaDriver` hace con su rol lo deniega IAM (`LeadingKeys`, cola de QA, `qa/*`, `tm-qa-*`, streams `qa-*`), y lo que haría a través de otra Lambda lo rechaza esa Lambda: `InboundWhatsApp` por la clave del sobre, `ScheduleDispatch` por el timer y el reloj guardados, `CoreMock`/`NetworkMock` por el rol invocante, `WorldJanitor` por el ticket (`docs/architecture.md` §14, "Cerca del `QaDriver`") |

Las acciones `console.*` ejecutan `appRouter.createCaller(ctx)` con un principal armado en el servidor (`{sub: "qa", worldId, staffId: "stf-qa-<rol>", role: OPERATOR | SUPERVISOR | COMPLIANCE | GUEST, authTime: input.authTime ?? now}`; `GUEST` solo en mundos `qa-*`), así que `worldProcedure`, `roleProcedure` y `recentLoginProcedure` corren de verdad. Toda acción lleva `idempotencyKey = runId/escenario/paso`; los ids de proveedor que genera (`wamid`, `mailId`) se derivan de esa clave. **Toda espera es una sonda no bloqueante**: la acción responde en ≤ 30-60 s con `{state, pending[]}` y el ejecutor repite con `eventually()`; el timeout del `QaDriver` es 90 s y solo se reintentan sondas idempotentes (una espera de minutos dentro de una invocación síncrona corta la conexión del runner y el reintento del SDK repetiría la acción).

| Acción | Qué hace |
|---|---|
| `world.create` | Crea un mundo `qa-<runId>-<escenario>` desde la plantilla `models` (o `guest` para `SC-21` y `SC-22`) con reloj `PAUSED` en `startAtSim`; `personas: [{key, model: "C01", overrides?}]` clona las personas pedidas con ids `cus-qa-<runId>-<escenario>-<key>`, teléfono de la reserva QA (arriendo con TTL 2 h), email `success+qa-…@simulator.amazonses.com` (o `bounce+`/`complaint+` por `emailOverride`), préstamos, pagos con sus claims, cobros presenciales, lotes, **reclamos históricos de la persona con sus evidencias y sus entradas `FILED`** (cadena y anclas calculadas para el mundo QA, p. ej. el reclamo abierto de `C17` para FL-021); `settings` del mundo (`caps`, `contactHours`, `rateLimitPerHour`, `settlementDelays`, `turnCaps`, `channelModes`, `intakeOnly` para `EV-3`); `history: [{persona, action: REVERSE_CHARGE \| REFUND_DUPLICATE \| TRANSFER_REVERSAL, amountCents, daysAgo}]` (acciones previas para `FL-040`: cada una es un reclamo cerrado de la persona clonada, con la acción `EXECUTED` del agente sin aprobación `daysAgo` días simulados antes del inicio y sus entradas del registro; los números quedan por encima de los de las personas modelo; `qa-driver/world-history.ts`); `live: true` solo para `qa-live-<runId>` (`SC-23`). Corre la fábrica por bloques (`docs/architecture.md` §10): cada invocación avanza hasta 50 s y devuelve `{state: CREATING \| READY, cursor, elapsedMs}`, y el ejecutor la repite como sonda hasta `READY`; así la plantilla `guest` no depende del timeout del `QaDriver` y su duración total se publica como `WorldCreateDuration` |
| `world.destroy` | Espera el mundo quieto (sonda), borra por bloques como sonda no bloqueante (`{state: DESTROYING \| DESTROYED}`, hasta 50 s por invocación) todo lo del mundo (incluidos schedules `tm-qa-*`, objetos `qa/<runId>/<worldId>/`, eventos y registros de Memory de sus actores) y agenda una barrida de Memory a los 15 min reales (`WorldJanitor`); `Register`, `ComplianceTape` y `AuditLog` vencen por TTL (append-only); deja `TOMB#`. Si el job se cancela, `WorldJanitor` destruye los mundos `qa-*` de más de 6 h |
| `auth.session` | `{sessionKey, role, worldId: qa-*, flow?: ADMIN \| SRP, probeCognito?}`: la primera llamada con una `sessionKey` crea el usuario efímero `qa-<runId>-<escenario>-<rol>` (nombre armado con `runId`, escenario y rol, nunca `runId` y rol solos) con `custom:worldId` = el mundo QA, su grupo y una fila `STAFF#` con su `sub`; las siguientes lo reutilizan (o lo recrean si `WorldJanitor` ya lo borró). **Cada llamada** fija una contraseña aleatoria nueva, generada y usada solo dentro de la Lambda, y hace un login real: `AdminInitiateAuth` con `ServerClient` (`ADMIN`, por defecto) o `InitiateAuth` `USER_SRP_AUTH` con `ConsoleClient` (`SRP`, `SC-22/8`), los dos a través del trigger pre-token desplegado. Devuelve **solo** `{idToken, accessToken, exp, authTime, loginMs}`: tokens de 15 minutos con un `auth_time` nuevo, sin refresh token y nunca la contraseña. El usuario vive hasta `world.destroy` (que borra los usuarios del mundo) o hasta que `WorldJanitor` borra los `qa-*` de más de 6 h. Con `probeCognito: true`, llama con ese access token a `UpdateUserAttributes` (`custom:worldId = demo`), `ChangePassword` y `DeleteUser` y devuelve los códigos de error (se espera `NotAuthorizedException`) |
| `guest.invite` | `{worldId: qa-*}`: corre **el mismo código** que `console:invite -- --guest` (`packages/bff/src/worlds/guest-world.ts`): `AdminCreateUser` del usuario `qa-<runId>-<escenario>-guest` con `custom:worldId` = el mundo, grupo `GUEST`, pre-registro `REGISTERED` + `STAFF#`, `REGISTERED → CREATING`, `create_world('guest')` y `READY`; devuelve `{sessionKey, status}` para `auth.session({flow: SRP})` (`SC-22/8`). Con `registerOnly: true` hace solo el usuario y el pre-registro y deja el mundo `REGISTERED`: un login antes de construirlo lo rechaza el trigger pre-token, y `auth.session` responde `FORBIDDEN WORLD_NOT_READY` |
| `guest.signup` | `{runId, key, locale, acceptContact?, utm?, referrer?}` (`utm` y `referrer` con el mismo zod que el formulario público, `guests/schemas.ts`): corre en proceso el servicio de alta real (`guests/signup.ts`) con el `GuestSignupClient` real y el email `success+qa-<runId>-<key>@simulator.amazonses.com` (el servicio acepta el simulador **solo** con el principal `qa`); el pedido va a `QASIGNUP#` (con `QAPENDING#`), devuelve el `signupId`, y el mundo que se pedirá es `qa-<runId>-<key>` con `key` `^su\d+$` (el único mundo `W#qa-*` que produce una alta). Topes en baldes de QA (`SIGNUPCAP#QA#…`) |
| `guest.confirm`, `guest.resend` | `{signupId, code?}`: `AdminConfirmSignUp` con `clientMetadata.signupId` (dispara el trigger post-confirmation real) o el camino de `signup.confirm` con un código dado; una cuenta que Cognito ya confirmó (`ALREADY_CONFIRMED`) sigue por el camino de reparación de `signup.confirm`, como en el producto; `ResendConfirmationCode`. Solo nombres `success+qa-*@simulator.amazonses.com` |
| `guest.session` | Como `auth.session` pero para un usuario de alta propia de QA: primero `AdminGetUser`, y una cuenta que no está `CONFIRMED` se rechaza (`FORBIDDEN NOT_CONFIRMED`, o `NOT_FOUND USER_NOT_FOUND`) sin tocarla, porque una contraseña permanente sobre una cuenta `UNCONFIRMED` la confirmaría en Cognito sin el trigger post-confirmation (sin `PROVISIONREQ#` ni lead); después contraseña aleatoria nueva dentro de la Lambda (`AdminSetUserPassword`), login SRP por el trigger pre-token desplegado, devuelve solo tokens (con `worldStatus`). Todo error de Cognito vuelve con un `reason` explícito (`qa-driver/cognito-refusal.ts`) |
| `guest.expireNow` | `{worldId: qa-<runId>-su*}`: corre el vencimiento de `WorldJanitor` sobre ese mundo QA (mismas fases) como sonda no bloqueante |
| `probe.edge` | Llama a la Function URL del `Bff` sin la cabecera de borde y espera 403 `EDGE_REQUIRED` |
| `guest.lead` | `{runId, key}` → el `QALEAD#` de `qa-<runId>-<key>` (por el `sub` de su fila `GUEST`): idioma, `utm`, `referrer`, versión de los términos, consentimiento de contacto, `signupAtReal`, `confirmedAtReal`, `lastLoginAtReal` y si se avisó; nunca el email ni el `sub`. Solo lectura |
| `notice.probe` | `{}` (la corrida sale de la clave de idempotencia) → `leadNotice()` de un lead sintético de QA por el transporte real de SES con el cerco `PROBE`: un solo destinatario, `success@simulator.amazonses.com` (también en IAM: `ses:Recipients` del rol del `QaDriver`); audita `LEAD_NOTICE_PROBE` en `SIGNUP#AUD#QA#<yyyy-mm>`. Nunca escribe a la casilla del equipo |
| `wa.inbound` | Texto, botón (por acción: resuelve el nonce del último mensaje), imagen (`receipt: {variant, personaModel}` de `Seed/`, o variantes armadas del lado del servidor: `oversize-4.5mb`, `oversize-7mb`, `bad-magic`; ningún payload de invocación lleva más de 1 MB de bytes); mismo camino que el simulador, con sobre firmado con `QaSimEnvelopeKey` (`kid = qa`), que `InboundWhatsApp` acepta solo para `qa-*`, `qamin` y `sim-*`; `wamid = wamid.SIM.<sha256(idempotencyKey)>`. Además: `{type: seedFile, file: receipts/<variante>/<nombre>.png}` manda una imagen de evaluación del seed por su clave (p. ej. `ev-tampered-chunk-01`, `SC-03/8`); `{type: document}` manda un PDF que el adaptador contesta con la respuesta fija sin descargarlo (`FL-029`); `redeliveryOf: <wamid>` repite el `wamid` que devolvió una llamada anterior, como una reentrega de SNS (`SC-19/3`) |
| `clock.advance`, `clock.advanceTo`, `clock.advanceToNext({complaintId?})`, `clock.advanceBusinessDay`, `clock.fireNow` | Igual que la consola (sin la compuerta `WORLD_BUSY`; siempre después de `conv.settleProbe` en `settled`) |
| `clock.unfreeze({timerKey, leadSec, rate?})`, `clock.freeze` | Prueba del Scheduler real, **atómica**: con el reloj `PAUSED`, lo lleva a `timerKey.dueAtSim − leadSec × rate` (por defecto `leadSec 120`, `rate 1`), lo pasa a `RUNNING` y crea los schedules en la misma invocación; devuelve `{timerKey, dueAtSim, dueAtReal}`. `timerKey` es obligatorio: el próximo timer del mundo puede ser una publicación de plantilla y no el hito que el paso quiere probar. `freeze` vuelve a `PAUSED` y borra los schedules |
| `conv.settleProbe` | `{customerId?}` → `{settled, pending[]}` en ≤ 30 s: el mundo (o la conversación) quieto y sin pendientes (`docs/architecture.md` §7). El ejecutor considera quieto un mundo con dos sondas `settled` seguidas a 10 s |
| `network.publish`, `network.setDelay`, `network.setFault`, `network.transition` | Controles de `NetworkMock` para el mundo QA |
| `receipt.forceFallback` | Para el mundo QA, `read_receipt` salta Bedrock (simula `ThrottlingException` agotado) |
| `receipt.readProbe` | Llama al lector (Bedrock + respaldo) con un comprobante del seed fuera de un reclamo: el de una persona (`{variant, personaModel, seq}`) o una imagen de evaluación por su clave (`{variant, file}`); lo usa el eval de lectura (`EV-2`) |
| `schedule.fireStale` | `{worldId: qa-*, timerKey, version, epoch}`: invoca `ScheduleDispatch` (permiso propio del `QaDriver`, `docs/architecture.md` §14) con una versión o época vieja (FL-081); rechaza un `worldId` que no sea `qa-*` (`qa-driver/guard.test.ts`). `ScheduleDispatch` decide desde el timer y el reloj guardados: un input viejo termina en `LATE_FIRE_DISCARDED` y no tiene efecto (el caso de un input con la versión vigente lo prueba `fence.probe`) |
| `console.*` | Cualquier procedimiento del `appRouter` como `OPERATOR`, `SUPERVISOR`, `COMPLIANCE` o `GUEST` |
| `mail.outcome` | `{mailId}` → sonda de la constancia (`SENT`, `DELIVERED`, `BOUNCED`, `COMPLAINED`) |
| `register.tamperProbe` | Con el rol del `QaDriver`, sobre entradas del registro del mundo QA: (1) `UpdateItem` y `DeleteItem` → se espera `AccessDenied`; (2) un **`PutItem` sin condición** que sobrescribe la entrada `n` (IAM lo permite) → `verify_register_chain` da `broken` con `brokenAt = n`; (3) sobre otra entrada `m`, una sobrescritura con **los hashes recalculados** con la clave publicada (entrada y todas las siguientes, cadena válida) **más un ancla falsa** `{seq: m, hash'}` escrita con `PutLogEvents` en el stream `qa-…-e<epoch>-REG` con un `timestamp` atrasado 1 hora (el `QaDriver` solo puede escribir streams `qa-*`) → se espera `ANCHOR_CONFLICT` en `m`, `result = broken` y `ChainBroken`; (4) el mismo `PutLogEvents` sobre un stream que no empieza con `qa-` → `AccessDenied`. Además, un `PutItem` con `ConditionExpression attribute_exists(pk)` sobre una clave inexistente de `W#demo#…` (si IAM lo permitiera, la condición evita escribir): se espera `AccessDenied`. La respuesta lleva además los ARN de `Register`, `ComplianceTape` y `AuditLog` (`tables`), para que el ejecutor pregunte `iam:SimulatePrincipalPolicy` por cada rol del app (`SC-18/8`) |
| `fence.probe` | `{kind: RECIPIENT, …}`: evalúa cerco y política para una dirección o teléfono en modo prueba (nunca llama a SES ni a EUM Social). `{kind: WORLD_PATHS}`: prueba contra `gprobe` los cuatro caminos por los que el `QaDriver` podría llegar a un mundo de invitado a través de otra Lambda, y lee un hash de `gprobe` (reclamos, timers, reloj, cinta, registro, `Core` de `C01`) antes y después: (a) `InboundWhatsApp` con un sobre válido firmado con `QaSimEnvelopeKey` para `gprobe` → `INBOUND_REJECTED SIM_KEY_WORLD_MISMATCH`, sin reclamo, acuse ni evento; (b) `ScheduleDispatch` con el `timerKey`, la `version` y la `epoch` **vigentes** de un hito de `gprobe` (en pausa) → `EARLY_FIRE_DISCARDED CLOCK_PAUSED`; (c) `POST /v1/gprobe/loans/{id}/payments` al `CoreMock` y `POST /v1/gprobe/…/collections` al `NetworkMock` por Function URL → 403 `CALLER_WORLD_DENIED`, y `lambda:InvokeFunction` directo de cada mock con un `requestContext` fabricado → `AccessDenied`; (d) `WorldJanitor` `MEMORY_PURGE` y `WORLD_RESET` para `gprobe` con un `requestId` inventado (y una época alta en un campo extra) → `PURGE_REQUEST_MISSING` y `RESET_REQUEST_MISSING`, `gprobe` sigue `READY`. Se espera cada rechazo y el mismo hash antes y después |
| `gate.probe` | `{worldId: qa-*, sender: AGENT, kind, text, turnResults, bypassLexicon?}`: corre el `sendThroughGate` real (política, render, **G2 real**, verificación, cerco) con un transporte que registra en lugar de enviar; `bypassLexicon` solo en este modo, para probar que G2 sola bloquea cobranza |
| `guardrail.probe` | `ApplyGuardrail` de G1 con una cadena de ataque conocida → `GUARDRAIL_INTERVENED` |
| `caps.prime` | `{worldId: qa-*, bucket: TURNCAP \| RATE \| GLOBALCAP_QA \| SIGNUP_QA \| GUESTCAP_QA, value}`: deja un tope cerca de su límite para probarlo (`GUESTCAP_QA`: límite de activos solo para los mundos `qa-<runId>-su*` de la corrida de la clave, durante 60 minutos) |
| `kill.setWorld` | `{worldId: qa-*, on}`: activa o levanta `W#<qa>#KILL` (el corte global no lo toca el `QaDriver`) |
| `turn.forceFailure` | Hace fallar el próximo turno de una conversación QA |
| `turn.forceSilence` | `{mode: NO_OUTBOUND \| SKIP_ANSWER}` para el próximo turno de una conversación QA: `NO_OUTBOUND` no invoca el Harness y cierra el turno sin salida; `SKIP_ANSWER` hace que `answer_complaint_in_writing` devuelva `UNAVAILABLE` en ese turno. Prueba las obligaciones de `docs/architecture.md` §7 sin depender de que el modelo se distraiga |
| `event.inject` | `{worldId: qa-*, type: APPROVAL_DECIDED, approvalId}`: encola por `enqueue_customer_event` en la cola de QA un evento fabricado o repetido (prueba de que `execute_approved_action` no confía en el payload) |
| `event.poison`, `dlq.find`, `dlq.delete`, `alarm.history` | DLQ de QA (FL-108), como en el scaffolding |
| `probe.mocks` | `/v1/health` de `CoreMock` y `NetworkMock` por Function URL con el rol del `QaDriver` y un `HEALTH_PROBE` por la cola de QA (rol del worker) |
| `probe.malwarePlan` | `GetMalwareProtectionPlan` del plan de `Media` → `{status, statusReasons}` (sonda no bloqueante); `SC-00/8` la repite cada 30 s hasta `ACTIVE`, con tope de 600 s, e imprime `statusReasons` si no llega |
| `memory.inspect` | Sonda: `ListEvents` de la sesión y `ListMemoryRecords` de los tres namespaces del actor, comparando `{memoryRecordId, createdAt, contentSha256}`; con `sentinel`, informa si ya apareció el registro centinela (prueba de que la extracción corrió) |
| `snapshot` | Conversación, reclamos (con `statusHistory`, evidencias, acciones, aprobaciones), timers pendientes, emails con constancia, cinta y registro del mundo, uso de turnos, obligaciones disparadas, `processError`; por mensaje, su `turnId`, la marca `flags.disclosure` y las acciones de sus botones (nunca los nonces), y por imagen entrante su registro de escaneo mientras vive (resultado y `resolution` `RESULT_FIRST` / `BIND_FIRST`, `SC-03/10`) |
| `turn.inspect` | `{worldId: qa-*, customerId}` → por turno de la conversación: los `clauseId` / `clauseIds` de los resultados de sus tools (`TURN#…/RESULT#`) y, por cada `REPLY` o `FORMAL_ANSWER`, si salió y el veredicto de G2 (los scores que guardó el mensaje enviado, o el `OUTBOUND_G2_REFUSED` de `AuditLog` si lo frenó). Nunca devuelve un texto ni los valores de un resultado (`EV-1`, calibración de ADR-0008) |
| `intake.inspect` | `{worldId: qa-*, customerId}` → las decisiones `INTAKE_CLASSIFIED` del cliente, de la más vieja a la más nueva: tipo, fuente (regla, modelo, respaldo), confianza, motivo del respaldo y milisegundos de la llamada al modelo (`EV-3`). Un mundo creado con `settings.intakeOnly` clasifica y nunca abre un turno |
| `probe.cognitoClients` | `{worldId: qa-*}` → `SignUp`, `ForgotPassword` y `ConfirmForgotPassword` del `SUPERVISOR` del mundo enviados directo a Cognito con el `ServerClient` y con el `ConsoleClient` (llamadas públicas); cada respuesta debe ser `ForbiddenException` del ACL `REGIONAL` (`FL-119`, `FL-122`, `SMK/10`, `SC-24/11`) |
| `policyAudit.run`, `metrics.get` | Auditoría del mundo y KPIs |
| `batch.run` | Lote de métricas en `sim-<lote>`: crea mundos desde `Seed/load/batch-inputs.jsonl` (30 reclamos), los corre con Harness y Bedrock reales y reloj en pausa, con tope de turnos y costo; escribe `Metrics` `source BATCH`, `agentMode REAL` |
