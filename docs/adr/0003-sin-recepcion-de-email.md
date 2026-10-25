---
status: accepted
---

# Sin recepción de email: la cuenta es compartida y el rule set activo es de otra app

SES admite un solo receipt rule set activo por región y cuenta, y en `craftech-demos` `us-east-1` ya lo usa otra app. Activar uno propio desactivaría el de esa app; agregar reglas al suyo nos acoplaría a un recurso ajeno. Además, el producto no necesita email entrante: el cliente entra por WhatsApp y el email es el canal de la respuesta escrita. Decidimos **SES solo salida**: identidad de dominio con DKIM, DMARC `p=reject`, configuration set con eventos a EventBridge, **sin** receipt rules, rule sets, MX ni MAIL FROM propio (que exige un MX).

## Considered options

- **Rule set propio activado**: rompe otra app.
- **Reglas dentro del rule set de otra app**: dependencia cruzada y permisos sobre un recurso ajeno.
- **Otra región para recibir**: suma una región y un MX que no necesitamos.
- **Solo salida** (elegida).

## Consequences

- `npm run lint:no-ses-receiving` falla si `infra/`, `sst.config.ts` o el template del bootstrap declaran receipt rules, rule sets, filtros, MAIL FROM o registros MX, o si el rol de deploy los permite.
- El rol de deploy tiene deny explícito de las acciones de recepción de SES (`ses:*ReceiptRule*`, `ses:*ReceiptFilter*`, `ses:SetActiveReceiptRuleSet`, `ses:SetReceiptRulePosition`, `ses:CloneReceiptRuleSet`, `ses:ReorderReceiptRuleSet`), de MAIL FROM (`ses:SetIdentityMailFromDomain`, `ses:PutEmailIdentityMailFromAttributes`), de ingreso de Mail Manager (`ses:CreateIngressPoint`, `ses:CreateRuleSet`, `ses:CreateTrafficPolicy`) y de registros `MX` en la zona. El prefijo IAM de SES v2 es `ses:` (`ci-role.test.ts` rechaza `sesv2:`); `security` lo verifica con `simulate-principal-policy`.
- DMARC pasa por DKIM alineado (SPF queda en el MAIL FROM de SES). El remitente no tiene `Reply-To`: el cuerpo dice que se responde por WhatsApp o con una persona.
- El visor de emails muestra lo que salió (MIME guardado) y la constancia de los eventos, no una casilla de entrada.
