import { describe, expect, it } from "vitest";
import { ENQUEUE_FILE, MEDIA_FILE, TRANSPORTS_DIR, findCommands, scan } from "./chokepoint";

describe("chokepoint [FL-110]", () => {
  it("fails on an email or WhatsApp send outside outbound/transports/", () => {
    const source = ["await ses.send(new SendEmailCommand(input));", "await eum.send(new SendWhatsAppMessageCommand(input));"].join("\n");
    expect(findCommands("packages/bff/src/agent-tools/messaging/handler.ts", source)).toEqual([
      { file: "packages/bff/src/agent-tools/messaging/handler.ts", line: 1, command: "SendEmailCommand" },
      { file: "packages/bff/src/agent-tools/messaging/handler.ts", line: 2, command: "SendWhatsAppMessageCommand" },
    ]);
    expect(findCommands(`${TRANSPORTS_DIR}ses.ts`, source)).toEqual([]);
  });

  it("fails on an SQS SendMessage outside worker/enqueue.ts, even inside the transports", () => {
    const source = "await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody }));";
    expect(findCommands("packages/bff/src/routers/conversation.ts", source)).toHaveLength(1);
    expect(findCommands(`${TRANSPORTS_DIR}ses.ts`, source)).toHaveLength(1);
    expect(findCommands(ENQUEUE_FILE, source)).toEqual([]);
  });

  it("fetches WhatsApp media only in channels/whatsapp/media.ts", () => {
    const source = "await eum.send(new GetWhatsAppMessageMediaCommand(input));";
    expect(findCommands("packages/bff/src/intake/receipt.ts", source)).toHaveLength(1);
    expect(findCommands(MEDIA_FILE, source)).toEqual([]);
  });

  it("ignores comments and passes on the repository", () => {
    expect(findCommands("x.ts", "// never call SendEmailCommand here")).toEqual([]);
    expect(scan(process.cwd())).toEqual([]);
  });
});
