// English texts of the public landing, same keys as copy-es.ts (docs/landing-spec.md §2 and §3,
// ADR-0021). The product's own texts inside the tour stay in Spanish with their English gloss
// (packages/bff/src/copy/en-gloss.ts), as the console shows them.
import type { LandingCopy } from "./copy-es";
import { CUSTOMER_MESSAGE } from "./tour/main-story";

export const en: LandingCopy = {
  meta: {
    code: "en",
    title: "Reclamo en regla · A regulated-complaints agent for consumer lenders and wallets",
  },
  lang: { label: "Language", switchTo: "Español", short: "ES" },
  nav: {
    label: "Sections",
    menu: "Menu",
    close: "Close",
    skip: "Skip to content",
    recorrido: "How it works",
    "que-hace": "What it solves",
    reglas: "Rules",
    impacto: "Impact",
  },
  cta: {
    try: "Try Reclamo en regla",
    signIn: "Sign in",
    toConsole: "Go to the console",
    talk: "Let's talk",
    newTab: "(opens in a new tab)",
    watch: "Watch the walkthrough (2½ min)",
  },
  hero: {
    eyebrow: "A regulated-complaints agent for consumer lenders and wallets in Latin America",
    title: "Every complaint, numbered on the spot, investigated and answered in writing on time.",
    lead: "Your customer messages that their payment isn't showing. The number comes out on the spot; the answer arrives in writing, with delivery proof.",
    proof: "A policy gate blocks debt collection on WhatsApp — even when a human operator tries it",
    note: "A test environment with 100% synthetic data: a fictitious lender, fictitious customers, no real operations.",
    visualLabel: "Valeria's complaint: her message, the complaint number on the spot and a WhatsApp collection attempt blocked on the tape",
  },
  problem: {
    eyebrow: "The problem",
    title: "A mishandled complaint costs money and exposes the company",
    lead: "Financial regulators require a number, a record and a written answer within a deadline for every complaint, even when it is solved on the spot. WhatsApp, the channel where your customer already is, also bans debt collection outright.",
    legalNote: "Our reading of the regulation, not legal advice.",
    pains: [
      {
        title: "The regulatory clock starts on the first message.",
        text: "A complaint without a number, a record, or a written answer on time can lead to a sanction — it's not an operational detail.",
      },
      {
        title: "Every complaint repeats the same manual work.",
        text: "Finding the payment, reading the receipt, matching it against the settlement file, drafting the answer — minutes that multiply across thousands of complaints a month.",
      },
      {
        title: "WhatsApp is the channel your customer already uses, and the riskiest one commercially.",
        text: "One misrouted collection message, from a bot or from a person, puts the whole WhatsApp Business account at risk.",
      },
    ],
  },
  tour: {
    eyebrow: "How it works",
    title: "From \"I paid and it doesn't show\" to resolved, in one thread",
    lead: "Follow one real complaint from end to end. Every step shows the same screen your team sees.",
    stepOf: (at: number, of: number) => `${at} of ${of}`,
    renderNote: "Real-component view · synthetic data",
    captureNote: "Real console capture · synthetic data",
    steps: {
      whatsapp: {
        title: "The customer writes",
        text: `Valeria writes to Jarilla on WhatsApp: "${CUSTOMER_MESSAGE.en}."`,
      },
      ack: {
        title: "A number on the spot",
        text: "The system replies with the number, the complaint type and the deadline — before the agent even steps in. Target: under 5 s (until the transport accepts it; WhatsApp simulated).",
      },
      evidence: {
        title: "Reading and matching",
        text: "Valeria sends a photo of the receipt. The model reads it, a deterministic reader confirms every field, and the reading is matched against the file the collection network publishes down to the exact line: same customer, same loan.",
      },
      email: {
        title: "Written answer",
        text: "The answer arrives by email, with the account statement as a PDF (with the register's hash printed on it) and delivery proof. The complaint is resolved and the deadline is cancelled.",
      },
      gate: {
        title: "The gate stops even the operator",
        text: "An operator tries a \"payment reminder\" on WhatsApp for another customer. The same gate that watches the agent blocks it, in red, and offers the one allowed path: a formal notice by email.",
      },
      register: {
        title: "Register and tape",
        text: "Every entry in the register is chained and anchored outside the tables; an overwrite to an anchored entry is detected. The register exports with its own verification.",
      },
      metrics: {
        title: "Metrics",
        text: "Time to number, percentage solved without a human, percentage answered on time with proof and policy violations, each with its source and its label. Here, the design's targets; in the console, what your environment measured, with the cost per complaint.",
      },
    },
  },
  visuals: {
    console: "Reclamo en regla console",
    receipt: "Payment receipt (synthetic)",
    receiptRead: "Read from the receipt",
    settlementLine: "Settlement file line",
    network: "Network",
    paidAt: "Paid",
    amount: "Amount",
    code: "Code",
    loan: "Loan",
    customer: "Customer",
    match: "Match",
    instalment: "Instalment 4",
    delivered: "Delivered",
    deliveryProof: "Delivery proof",
    from: "From",
    to: "To",
    subject: "Subject",
    attachment: "Attachment",
    registerHash: "Register hash",
    tapeHeads: ["Time", "Decision", "Sender", "Channel", "Kind", "Rules"],
    sender: "Sender",
    channel: "Channel",
    rules: "Rules",
    register: {
      heads: ["#", "Complaint", "Event", "Hash", "Anchor"],
      anchored: "anchored",
      chain: "Chain verified",
      chainDetail: "Each entry chains the previous one's hash; the anchors live outside the tables.",
      export: "Exported with its verification",
    },
    metricsSource: "Source: design target",
  },
  actors: {
    eyebrow: "What it solves",
    title: "One flow, three roles",
    groups: [
      {
        title: "For the end customer",
        items: [
          "A complaint number before they finish typing",
          "A written answer by email, with the PDF and delivery proof",
          "Never a collection message on WhatsApp",
          "A \"Talk to someone\" button on every message",
        ],
      },
      {
        title: "For the operator",
        items: [
          "An inbox with the regulatory deadline already running, not a date to compute",
          "Every piece of evidence in one case: receipt, settlement line, cited clause",
          "Approval in the console, with a recent login, for what is above the agent's cap",
          "The same gate that stops the agent also stops the operator",
        ],
      },
      {
        title: "For oversight and compliance",
        items: [
          "A tape of every decision, with the rule that applied",
          "A tamper-evident complaint register, exportable and verifiable",
          "Metrics with their source and label: measured, simulated or assumed",
          "A kill switch to stop the agent without waiting for a deploy",
        ],
      },
    ],
  },
  rules: {
    eyebrow: "What doesn't bend",
    title: "The rules live in the code, not in the prompt",
    lead: "The model investigates and drafts. Caps, deadlines and channel policy are decided by a function, always, for every sender. It's not a promise — it's the architecture.",
    items: [
      { title: "The agent never approves its own action.", text: "Anything above its cap waits for a human." },
      { title: "Collection, never on WhatsApp.", text: "A function blocks any collection message, whether it comes from the agent or an operator, and offers the allowed path." },
      { title: "The complaint number is issued on the spot,", text: "in the same transaction as the record, sequential, with no gaps." },
      { title: "The record can't be altered without it showing.", text: "A hash chain anchored outside the tables; an overwrite is detected, never claimed impossible." },
      { title: "No customer's data reaches another.", text: "Identity is resolved before the model ever sees a data point." },
      { title: "Money moves exactly once.", text: "Every allocation, reversal or refund carries a natural key that never repeats." },
    ],
  },
  impact: {
    eyebrow: "Impact",
    title: "Targets, not promises",
    lead: "Every number carries its label: target (what the design aims for), measured (what came out of a real run) or assumed (an editable parameter). They are never mixed.",
    target: "target",
    measured: "measured",
    howWeMeasure: "How we measure this",
    goals: {
      timeToNumber: { label: "Time to number", prefix: "< ", value: 5, suffix: " s", detail: "from the customer's message" },
      resolvedAlone: { label: "Solved without human intervention", prefix: "≥ ", value: 60, suffix: "%", detail: "of complaints" },
      answeredOnTime: { label: "Answered in writing on time, with proof", prefix: "", value: 100, suffix: "%", detail: "with delivery proof" },
      violations: { label: "Policy violations detected", prefix: "", value: 0, suffix: "", detail: "out-of-policy messages delivered" },
    },
    methodology: {
      title: "How we measure this",
      text: "A batch of 30 complaints, 3 of each type, run end to end with the real agent (AgentCore and Bedrock) on the test environment. Every measured figure shows its N, the date of the run and the \"measured\" label; until that run exists, the landing shows targets only.",
    },
    measuredTitle: "Measured · batch of 30",
    measuredNote: (n: number, ranOn: string) => `N = ${n} · run of ${ranOn}`,
  },
  integration: {
    eyebrow: "How it plugs in",
    title: "It connects to what you already have, it doesn't replace it",
    lead: "A per-system connector contract (core, collection networks, transfer networks) that gets implemented in your project; in this demo it runs against simulated systems. WhatsApp and email as channels; the whole infrastructure can run in your own AWS account.",
    blocks: [
      { title: "Channels", text: "WhatsApp (AWS End User Messaging Social) and email (Amazon SES), with channel policy before every send" },
      { title: "Agent", text: "Amazon Bedrock AgentCore: tools, memory and a policy that audits every call" },
      { title: "Data and compliance", text: "Append-only register and tape, anchored outside the tables, exportable with their own verification" },
      { title: "Infrastructure", text: "100% serverless; in this demo it runs in Craftech's account, designed to run in your own AWS account, no servers to manage" },
    ],
    diagramCaption: "Reclamo en regla's architecture on AWS",
  },
  video: {
    eyebrow: "Video walkthrough",
    title: "Reclamo en regla in two and a half minutes",
    lead: "One complaint end to end: the message, the number on the spot, the investigation, the written answer and the gate that stops collection on WhatsApp. Narrated in English, with subtitles.",
    fallback: "Download the video",
  },
  simulated: {
    title: "What's real and what's simulated in this test environment",
    columns: {
      real: { title: "Real", text: "Every AWS service runs for real: Amazon SES (sending, with its delivery events), AgentCore, Bedrock, EventBridge Scheduler, SQS, DynamoDB, S3, Cognito and CloudFront." },
      simulated: { title: "Implemented, in simulated mode", text: "The WhatsApp channel is implemented on AWS End User Messaging Social (templates, buttons, media, delivery events). In this test environment you use it through a phone simulator that feeds the same inbound pipeline." },
      mocks: { title: "Simulated systems", text: "The core of a fictitious lender (Jarilla), two collection networks and a transfer network — so you can try the product without touching your systems." },
      data: {
        title: "Data",
        text: "100% synthetic, generated with a fixed seed. No real customer, person or operation. The console captures on this page were taken in a local environment, with the agent's replies scripted; in your test environment the real agent answers.",
      },
    },
    gallery: "Console captures",
  },
  closing: {
    title: "Ready to see your own case?",
    lead: "Create your account and try the product in an isolated test environment, seeded just for you — it's ready in a few minutes.",
    credibilityBefore: "Built by ",
    credibilityAfter: ", a LatAm cloud & DevOps consultancy, AWS Advanced Tier Partner, 100% serverless.",
  },
  footer: {
    brand: "Reclamo en regla · Powered by Craftech",
    note: "Jarilla is a fictitious lender. All data in this environment is synthetic.",
    privacy: "Privacy",
    terms: "Terms",
    talk: "Let's talk",
  },
  zoom: { open: "Enlarge image", chip: "Zoom", close: "Close", previous: "Previous image", next: "Next image", counter: (at: number, of: number) => `${at} of ${of}` },
};
