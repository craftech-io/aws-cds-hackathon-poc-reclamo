// What the phone simulator reads and does (docs/tool-catalog.md, `simulator.*`; FL-101), parsed with zod
// at the edge. The console never sends a phone, a nonce or a provider id: the BFF builds the same
// signed envelope a real WhatsApp event carries. An uploaded image goes by a presigned POST of exactly
// one JPG or PNG (≤ 3.75 MB, 5 minutes) to the key the BFF announced to the scan registry before signing,
// and only then is it attached to a message.
import { IsoInstant } from "@reclamo/shared";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import { fetchWithRetry } from "../../lib/http";
import { imageType } from "./simulator-model";

export const SimPersona = z.looseObject({
  persona: z.string().regex(/^C\d{2}$/),
  customerId: z.string().min(1),
  name: z.string().min(1),
  phoneMasked: z.string().min(1),
  scenario: z.string(),
  scenarioEn: z.string(),
  script: z.array(z.looseObject({ text: z.string().min(1), en: z.string(), receipt: z.boolean() })),
  hasReceipt: z.boolean(),
});
export type SimPersona = z.infer<typeof SimPersona>;

export const PersonasAnswer = z.looseObject({
  personas: z.array(SimPersona),
  unlinked: z.looseObject({ persona: z.literal("UNLINKED"), phoneMasked: z.string(), text: z.string().min(1), en: z.string() }),
});
export type PersonasAnswer = z.infer<typeof PersonasAnswer>;

export const SimMessage = z.looseObject({
  messageId: z.string().min(1),
  direction: z.enum(["IN", "OUT"]),
  body: z.string().nullish(),
  templateName: z.string().nullable(),
  buttons: z.array(z.looseObject({ index: z.number().int().nonnegative(), action: z.string().min(1), title: z.string().min(1) })),
  image: z.looseObject({ contentType: z.string().nullable(), scan: z.string().nullable() }).nullable(),
  status: z.string().min(1),
  atSim: IsoInstant,
  /** Real instant it was stored, when the BFF sends it: orders messages of the same simulated minute. */
  createdAt: IsoInstant.optional(),
});
export type SimMessage = z.infer<typeof SimMessage>;

export const ThreadAnswer = z.looseObject({ persona: z.string(), messages: z.array(SimMessage), typing: z.boolean() });
export type ThreadAnswer = z.infer<typeof ThreadAnswer>;

/** What `InboundWhatsApp` said about a message the phone sent. */
export const SendAnswer = z.looseObject({ accepted: z.boolean(), reason: z.string().nullable() });
export type SendAnswer = z.infer<typeof SendAnswer>;

const Presigned = z.looseObject({ url: z.string().min(1), fields: z.record(z.string(), z.string()), key: z.string().min(1) });

export type PersonaRef = string;

export type SimulatorAction =
  | { readonly kind: "sendText"; readonly persona: PersonaRef; readonly text: string }
  | { readonly kind: "sendScript"; readonly persona: PersonaRef; readonly text: string; readonly receipt: boolean }
  | { readonly kind: "tapButton"; readonly persona: PersonaRef; readonly messageId: string; readonly buttonIndex: number }
  | { readonly kind: "attachScriptReceipt"; readonly persona: PersonaRef }
  | { readonly kind: "uploadReceipt"; readonly persona: PersonaRef; readonly file: File }
  | { readonly kind: "markRead"; readonly persona: PersonaRef };

export async function fetchPersonas(trpc: ConsoleClient, signal: AbortSignal): Promise<PersonasAnswer> {
  return PersonasAnswer.parse(await trpc.simulator.personas.query(undefined, { signal }));
}

export async function fetchThread(trpc: ConsoleClient, persona: PersonaRef, signal: AbortSignal): Promise<ThreadAnswer> {
  return ThreadAnswer.parse(await trpc.simulator.threads.query({ persona }, { signal }));
}

/** The upload of one image by the presigned POST; resolves with the key to attach. */
async function upload(trpc: ConsoleClient, persona: PersonaRef, file: File): Promise<string> {
  const contentType = imageType(file);
  if (contentType === undefined) throw new Error("only JPG or PNG images");
  const post = Presigned.parse(await trpc.simulator.presignReceipt.mutate({ persona, contentType, sizeBytes: file.size }));
  const form = new FormData();
  for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
  form.append("file", file);
  const answer = await fetchWithRetry(post.url, { method: "POST", body: form }, { timeoutMs: 30_000 });
  if (!answer.ok) throw new Error(`the upload was refused (${answer.status})`);
  return post.key;
}

/** Runs one action of the phone; the sends answer what the channel said of the last message. */
export async function runSimulatorAction(trpc: ConsoleClient, action: SimulatorAction): Promise<SendAnswer | undefined> {
  switch (action.kind) {
    case "sendText":
      return SendAnswer.parse(await trpc.simulator.sendText.mutate({ persona: action.persona, text: action.text }));
    case "sendScript": {
      const sent = SendAnswer.parse(await trpc.simulator.sendText.mutate({ persona: action.persona, text: action.text }));
      if (!sent.accepted || !action.receipt) return sent;
      return SendAnswer.parse(await trpc.simulator.attachReceipt.mutate({ persona: action.persona, source: { kind: "SCRIPT" } }));
    }
    case "tapButton":
      return SendAnswer.parse(await trpc.simulator.tapButton.mutate({ persona: action.persona, messageId: action.messageId, buttonIndex: action.buttonIndex }));
    case "attachScriptReceipt":
      return SendAnswer.parse(await trpc.simulator.attachReceipt.mutate({ persona: action.persona, source: { kind: "SCRIPT" } }));
    case "uploadReceipt": {
      const key = await upload(trpc, action.persona, action.file);
      return SendAnswer.parse(await trpc.simulator.attachReceipt.mutate({ persona: action.persona, source: { kind: "UPLOAD", key } }));
    }
    case "markRead":
      await trpc.simulator.markRead.mutate({ persona: action.persona });
      return undefined;
  }
}
