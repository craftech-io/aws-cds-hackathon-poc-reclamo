// Spanish (Argentina) texts of the public landing: the final copy of docs/landing-spec.md §2 and §3
// with the replacements of ADR-0021 (one product call to action, "Hablemos" to Craftech's contact
// form, the video section). copy-en.ts carries the same keys (landing.test.ts). The texts the
// customer and the console read inside the tour's renders come from packages/bff/src/copy, never
// from here: the customer's words quoted in step 1 are her script's (tour/main-story.ts), the same
// message the step's capture shows.
import { CUSTOMER_MESSAGE } from "./tour/main-story";

export const es = {
  meta: {
    code: "es",
    title: "Reclamo en regla · Agente de reclamos regulados para prestamistas y billeteras",
  },
  lang: { label: "Idioma", switchTo: "English", short: "EN" },
  nav: {
    label: "Secciones",
    menu: "Menú",
    close: "Cerrar",
    skip: "Saltar al contenido",
    recorrido: "Cómo funciona",
    "que-hace": "Qué resuelve",
    reglas: "Reglas",
    impacto: "Impacto",
  },
  cta: {
    try: "Probar Reclamo en regla",
    signIn: "Ingresar",
    toConsole: "Ir a la consola",
    talk: "Hablemos",
    newTab: "(se abre en otra pestaña)",
    watch: "Ver el recorrido (3 min)",
  },
  hero: {
    eyebrow: "Agente de reclamos regulados para prestamistas y billeteras de América Latina",
    title: "Cada reclamo, con número en el acto, investigado y respondido por escrito a tiempo.",
    lead: "Tu cliente te escribe que su pago no se refleja. El número sale en el acto; la respuesta llega por escrito, con constancia de entrega.",
    proof: "Una compuerta de política bloquea la cobranza por WhatsApp — la intente el agente o un operador",
    note: "Entorno de prueba con datos 100 % sintéticos: un prestamista ficticio, clientes ficticios, sin operaciones reales.",
    visualLabel: "El reclamo de Valeria: su mensaje, el número de reclamo en el acto y un intento de cobranza por WhatsApp bloqueado en la cinta",
  },
  problem: {
    eyebrow: "El problema",
    title: "Un reclamo mal atendido cuesta plata y expone a la empresa",
    lead: "Los reguladores de servicios financieros exigen número, registro y respuesta escrita en plazo para todo reclamo, aunque se resuelva en el acto. WhatsApp, el canal donde vive tu cliente, prohíbe además la cobranza de deudas.",
    legalNote: "Nuestra lectura de la normativa, no asesoramiento legal.",
    pains: [
      {
        title: "El reloj regulatorio corre desde el primer mensaje.",
        text: "Un reclamo sin número, sin registro o sin respuesta escrita en plazo puede derivar en sanción, no es un detalle operativo.",
      },
      {
        title: "Cada reclamo repite el mismo trabajo manual.",
        text: "Buscar el pago, leer el comprobante, cruzarlo contra la rendición, redactar la respuesta: minutos que se multiplican por miles de reclamos al mes.",
      },
      {
        title: "WhatsApp es el canal que tu cliente usa, y el que más riesgo comercial tiene.",
        text: "Un solo mensaje de cobranza mal encaminado, de un bot o de una persona, pone en riesgo la cuenta de WhatsApp Business entera.",
      },
    ],
  },
  tour: {
    eyebrow: "Cómo funciona",
    title: "De \"pagué y no se refleja\" a resuelto, en un solo hilo",
    lead: "Seguí un reclamo real de punta a punta. Cada paso muestra la misma pantalla que ve tu equipo.",
    stepOf: (at: number, of: number) => `${at} de ${of}`,
    renderNote: "Vista con componentes reales · datos sintéticos",
    captureNote: "Captura de la consola real · datos sintéticos",
    steps: {
      whatsapp: {
        title: "El cliente escribe",
        text: `Valeria le escribe a Jarilla por WhatsApp: "${CUSTOMER_MESSAGE.es}."`,
      },
      ack: {
        title: "Número en el acto",
        text: "El sistema responde con el número, el tipo de reclamo y el plazo, antes de que el agente intervenga. Meta: menos de 5 s (hasta la aceptación del transporte; WhatsApp simulado).",
      },
      evidence: {
        title: "Lectura y conciliación",
        text: "Valeria manda la foto del comprobante. El modelo la lee, un lector determinista confirma cada campo y la lectura se cruza con el archivo que publica la red de cobro hasta dar con la línea exacta: mismo cliente, mismo préstamo.",
      },
      email: {
        title: "Respuesta escrita",
        text: "La respuesta llega por email, con el estado de cuenta en PDF (con el hash del registro impreso) y la constancia de entrega. El reclamo queda resuelto y el plazo, cancelado.",
      },
      gate: {
        title: "La compuerta frena hasta al operador",
        text: "Un operador intenta un \"Recordatorio de mora\" por WhatsApp para otro cliente. La misma compuerta que vigila al agente lo bloquea, en rojo, y ofrece el único camino permitido: un aviso formal por email.",
      },
      register: {
        title: "Registro y cinta",
        text: "Cada entrada del registro se encadena y se ancla fuera de las tablas; una sobrescritura de una entrada anclada se detecta. El registro se exporta con su verificación.",
      },
      metrics: {
        title: "Métricas",
        text: "Tiempo al número, porcentaje resuelto sin persona, porcentaje respondido en plazo con constancia y violaciones de política, cada uno con su fuente y su rótulo. Acá, las metas del diseño; en la consola, lo medido en tu entorno, con el costo por reclamo.",
      },
    },
  },
  visuals: {
    console: "Consola de Reclamo en regla",
    receipt: "Comprobante de pago (sintético)",
    receiptRead: "Leído del comprobante",
    settlementLine: "Línea de la rendición",
    network: "Red",
    paidAt: "Pagado",
    amount: "Importe",
    code: "Código",
    loan: "Préstamo",
    customer: "Cliente",
    match: "Coincide",
    instalment: "Cuota 4",
    delivered: "Entregado",
    deliveryProof: "Constancia de entrega",
    from: "De",
    to: "Para",
    subject: "Asunto",
    attachment: "Adjunto",
    registerHash: "Hash del registro",
    tapeHeads: ["Hora", "Decisión", "Emisor", "Canal", "Tipo", "Reglas"],
    sender: "Emisor",
    channel: "Canal",
    rules: "Reglas",
    register: {
      heads: ["#", "Reclamo", "Evento", "Hash", "Ancla"],
      anchored: "anclada",
      chain: "Cadena verificada",
      chainDetail: "Cada entrada encadena el hash de la anterior; las anclas viven fuera de las tablas.",
      export: "Exportado con su verificación",
    },
    metricsSource: "Fuente: meta del diseño",
  },
  actors: {
    eyebrow: "Qué resuelve",
    title: "Un flujo, tres roles",
    groups: [
      {
        title: "Para el cliente final",
        items: [
          "Número de reclamo antes de terminar de escribir",
          "Respuesta escrita por email, con el PDF y la constancia de entrega",
          "Nunca un mensaje de cobranza por WhatsApp",
          "Un botón \"Hablar con alguien\" en cada mensaje",
        ],
      },
      {
        title: "Para el operador",
        items: [
          "Bandeja con el plazo regulatorio corriendo, no una fecha que hay que calcular",
          "Toda la evidencia en un solo caso: comprobante, línea de rendición, cláusula citada",
          "Aprobación en la consola, con login reciente, para lo que supera el tope del agente",
          "La misma compuerta que frena al agente también frena al operador",
        ],
      },
      {
        title: "Para supervisión y cumplimiento",
        items: [
          "Cinta de cada decisión, con la regla que se aplicó",
          "Registro de reclamos que deja ver cualquier sobrescritura, exportable y verificable",
          "Métricas con su fuente y su rótulo: medido, simulado o supuesto",
          "Un interruptor para frenar al agente sin esperar un deploy",
        ],
      },
    ],
  },
  rules: {
    eyebrow: "Lo que no se negocia",
    title: "Las reglas viven en el código, no en el prompt",
    lead: "El modelo investiga y redacta. Los topes, los plazos y la política de canal los decide una función, siempre, para cualquier emisor. No es una promesa: es la arquitectura.",
    items: [
      { title: "El agente nunca aprueba su propia acción.", text: "Toda acción sobre el tope espera a una persona." },
      { title: "Cobranza, nunca por WhatsApp.", text: "Una función bloquea cualquier mensaje de cobranza, lo mande el agente o un operador, y ofrece el camino permitido." },
      { title: "El número de reclamo sale en el acto,", text: "en la misma transacción que el registro, correlativo, sin huecos." },
      { title: "El registro no se puede alterar sin que se note.", text: "Cadena de hash con ancla fuera de las tablas; una sobrescritura se detecta, no se promete imposible." },
      { title: "Ningún dato de un cliente llega a otro.", text: "La identidad se resuelve antes de que el modelo vea un dato." },
      { title: "El dinero se mueve una sola vez.", text: "Toda imputación, reversión o reintegro tiene una clave natural que no se repite." },
    ],
  },
  impact: {
    eyebrow: "Impacto",
    title: "Metas, no promesas",
    lead: "Cada número lleva su rótulo: meta (lo que el diseño persigue), medido (lo que salió de una corrida real) o supuesto (un parámetro editable). Nunca se mezclan.",
    target: "meta",
    measured: "medido",
    howWeMeasure: "Cómo medimos esto",
    goals: {
      timeToNumber: { label: "Tiempo al número", prefix: "< ", value: 5, suffix: " s", detail: "desde el mensaje del cliente" },
      resolvedAlone: { label: "Resuelto sin intervención humana", prefix: "≥ ", value: 60, suffix: " %", detail: "de los reclamos" },
      answeredOnTime: { label: "Respondido por escrito en plazo, con constancia", prefix: "", value: 100, suffix: " %", detail: "con la constancia de entrega" },
      violations: { label: "Violaciones de política detectadas", prefix: "", value: 0, suffix: "", detail: "mensajes fuera de política entregados" },
    },
    methodology: {
      title: "Cómo medimos esto",
      text: "Un lote de 30 reclamos, 3 por cada tipo, corrido de punta a punta con el agente real (AgentCore y Bedrock) sobre el entorno de prueba. Cada cifra medida muestra su N, la fecha de la corrida y el rótulo \"medido\"; mientras no exista esa corrida, la landing muestra solo metas.",
    },
    measuredTitle: "Medido · lote de 30",
    measuredNote: (n: number, ranOn: string) => `N = ${n} · corrida del ${ranOn}`,
  },
  integration: {
    eyebrow: "Cómo se integra",
    title: "Se conecta a lo que ya tenés, no lo reemplaza",
    lead: "Un contrato de conector por sistema (core, redes de cobro, redes de transferencia) que se implementa en tu proyecto; en esta demo corre contra sistemas simulados. WhatsApp y email como canales; toda la infraestructura puede correr en tu propia cuenta de AWS.",
    blocks: [
      { title: "Canales", text: "WhatsApp (AWS End User Messaging Social) y email (Amazon SES), con la política de canal antes de cada envío" },
      { title: "Agente", text: "Amazon Bedrock AgentCore: herramientas, memoria y una política que audita cada llamada" },
      { title: "Datos y cumplimiento", text: "Registro y cinta append-only, ancladas fuera de las tablas, exportables con su verificación" },
      { title: "Infraestructura", text: "100 % serverless; en esta demo corre en la cuenta de Craftech, pensado para correr en tu propia cuenta de AWS, sin servidores que administrar" },
    ],
    diagramCaption: "Arquitectura en AWS de Reclamo en regla",
  },
  video: {
    eyebrow: "Recorrido en video",
    title: "Reclamo en regla en tres minutos",
    lead: "Un reclamo de punta a punta: el mensaje, el número en el acto, la investigación, la respuesta escrita y la compuerta que frena la cobranza por WhatsApp.",
    fallback: "Descargar el video",
  },
  simulated: {
    title: "Qué es real y qué es simulado en este entorno de prueba",
    columns: {
      real: { title: "Real", text: "Todo servicio de AWS corre de verdad: Amazon SES (envío, con sus eventos de entrega), AgentCore, Bedrock, EventBridge Scheduler, SQS, DynamoDB, S3, Cognito y CloudFront." },
      simulated: { title: "Implementado, en modo simulado", text: "El canal de WhatsApp está implementado sobre AWS End User Messaging Social (plantillas, botones, media, eventos de entrega). En este entorno de prueba lo usás con un simulador de teléfono que entra por el mismo circuito de entrada." },
      mocks: { title: "Sistemas simulados", text: "El core de un prestamista ficticio (Jarilla), dos redes de cobro y una red de transferencias — para que puedas probar el producto sin tocar tus sistemas." },
      data: {
        title: "Datos",
        text: "100 % sintéticos, generados con semilla fija. Ningún cliente, persona ni operación real. Las capturas de la consola de esta página se tomaron en un entorno local, con las respuestas del agente guionadas; en tu entorno de prueba responde el agente real.",
      },
    },
    gallery: "Capturas de la consola",
  },
  closing: {
    title: "¿Listo para ver tu propio caso?",
    lead: "Creá tu cuenta y probá el producto en un entorno de prueba aislado, sembrado para vos — queda listo en unos minutos.",
    credibilityBefore: "Construido por ",
    credibilityAfter: ", consultora cloud & DevOps de LatAm, AWS Advanced Tier Partner, 100 % serverless.",
  },
  footer: {
    brand: "Reclamo en regla · Powered by Craftech",
    note: "Jarilla es un prestamista ficticio. Todos los datos de este entorno son sintéticos.",
    privacy: "Privacidad",
    terms: "Términos",
    talk: "Hablemos",
  },
  zoom: { open: "Ampliar imagen", chip: "Ampliar", close: "Cerrar", previous: "Imagen anterior", next: "Imagen siguiente", counter: (at: number, of: number) => `${at} de ${of}` },
};

export type LandingCopy = typeof es;
