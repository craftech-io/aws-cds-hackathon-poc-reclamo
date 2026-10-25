// Transport of the lead notice (FL-126): plain text, fixed subject, one @craftech.io recipient, the
// app's sender, no configuration set; anything else is refused before SES.
import { type SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import { LEAD_NOTICE_PROBE_RECIPIENT, LEAD_NOTICE_SUBJECT } from "../../leads/notice";
import { LeadNoticeRefused, sesLeadNoticeTransport } from "./lead-notice";

function recordingClient() {
  const sent: SendEmailCommand[] = [];
  return { sent, client: { send: async (command: SendEmailCommand) => void sent.push(command) } as unknown as SESv2Client };
}

describe("lead notice transport [FL-126]", () => {
  it("sends text/plain only, from no-reply, without a configuration set", async () => {
    const { sent, client } = recordingClient();
    await sesLeadNoticeTransport("Reclamo en regla <no-reply@reclamo.demo.craftech.io>", client).send({ to: "ventas@craftech.io", subject: LEAD_NOTICE_SUBJECT, text: "Email: ana@empresa-ficticia.ar" });
    expect(sent).toHaveLength(1);
    const input = sent[0]?.input;
    expect(input?.FromEmailAddress).toBe("Reclamo en regla <no-reply@reclamo.demo.craftech.io>");
    expect(input?.Destination).toEqual({ ToAddresses: ["ventas@craftech.io"] });
    expect(input?.ConfigurationSetName).toBeUndefined();
    expect(input?.Content?.Simple?.Body).toEqual({ Text: { Data: "Email: ana@empresa-ficticia.ar", Charset: "UTF-8" } });
  });

  it("refuses a recipient outside @craftech.io or another subject", async () => {
    const { sent, client } = recordingClient();
    const transport = sesLeadNoticeTransport("no-reply@reclamo.demo.craftech.io", client);
    await expect(transport.send({ to: "ana@empresa-ficticia.ar", subject: LEAD_NOTICE_SUBJECT, text: "x" })).rejects.toBeInstanceOf(LeadNoticeRefused);
    await expect(transport.send({ to: "ventas@craftech.io", subject: "Nuevo lead: Ana", text: "x" })).rejects.toBeInstanceOf(LeadNoticeRefused);
    expect(sent).toEqual([]);
  });
});

describe("the notice probe's transport [FL-126]", () => {
  it("sends only to the SES mailbox simulator, never to the team's mailbox nor anyone else", async () => {
    const { sent, client } = recordingClient();
    const probe = sesLeadNoticeTransport("no-reply@reclamo.demo.craftech.io", client, "PROBE");
    await probe.send({ to: LEAD_NOTICE_PROBE_RECIPIENT, subject: LEAD_NOTICE_SUBJECT, text: "Email: success+qa-1-1-su0@simulator.amazonses.com" });
    expect(sent.map((command) => command.input.Destination)).toEqual([{ ToAddresses: ["success@simulator.amazonses.com"] }]);
    for (const to of ["ventas@craftech.io", "bounce@simulator.amazonses.com", "ana@empresa-ficticia.ar"]) {
      await expect(probe.send({ to, subject: LEAD_NOTICE_SUBJECT, text: "x" }), to).rejects.toBeInstanceOf(LeadNoticeRefused);
    }
    // And the team's transport never takes the simulator.
    await expect(sesLeadNoticeTransport("no-reply@reclamo.demo.craftech.io", client).send({ to: LEAD_NOTICE_PROBE_RECIPIENT, subject: LEAD_NOTICE_SUBJECT, text: "x" })).rejects.toBeInstanceOf(LeadNoticeRefused);
    expect(sent).toHaveLength(1);
  });
});
