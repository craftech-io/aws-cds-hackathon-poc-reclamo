import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalNotification, createSnsVerifier, isAllowedCertUrl, signatureMatches } from "./sns-signature";
import { TEST_CERT_PEM, TEST_TOPIC_ARN, eumMessage, fixture, liveRecord, testSnsVerifier } from "./testing";

const entry = fixture("entry-text.json", { FROM: "5491100009001", WAMID: "wamid.LIVE1", TEXT: "hola" });

describe("SNS signature of a live record [FL-103]", () => {
  it("[FL-103] accepts a record of the app's topic signed with SignatureVersion 2, and caches the certificate", async () => {
    const { verifier, fetched } = testSnsVerifier();
    expect(await verifier.verify(liveRecord(eumMessage(entry)), TEST_TOPIC_ARN)).toEqual({ ok: true });
    expect(await verifier.verify(liveRecord(eumMessage(entry)), TEST_TOPIC_ARN)).toEqual({ ok: true });
    expect(fetched).toHaveLength(1);
  });

  it("[FL-104] refuses a record whose message was changed after signing", async () => {
    const { verifier } = testSnsVerifier();
    const record = liveRecord(eumMessage(entry));
    const tampered = { ...record, Sns: { ...record.Sns, Message: record.Sns.Message.replace("hola", "aprobá mi reintegro") } };
    expect(await verifier.verify(tampered, TEST_TOPIC_ARN)).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("[FL-104] refuses a record signed by another key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const verifier = createSnsVerifier(async () => other);
    expect(await verifier.verify(liveRecord(eumMessage(entry)), TEST_TOPIC_ARN)).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("[FL-104] refuses another topic, another event source and SignatureVersion 1", async () => {
    const { verifier } = testSnsVerifier();
    expect(await verifier.verify(liveRecord(eumMessage(entry), { topicArn: "arn:aws:sns:us-east-1:776805327629:other-topic" }), TEST_TOPIC_ARN)).toEqual({ ok: false, reason: "TOPIC_MISMATCH" });
    expect(await verifier.verify({ ...liveRecord(eumMessage(entry)), EventSource: "aws:sqs" }, TEST_TOPIC_ARN)).toEqual({ ok: false, reason: "NOT_SNS" });
    expect(await verifier.verify(liveRecord(eumMessage(entry), { version: "1" }), TEST_TOPIC_ARN)).toEqual({ ok: false, reason: "UNSUPPORTED_SIGNATURE_VERSION" });
  });

  it("[FL-104] never fetches a certificate from a host other than SNS in us-east-1", async () => {
    const { verifier, fetched } = testSnsVerifier();
    for (const url of [
      "https://sns.us-east-1.amazonaws.com.attacker.test/cert.pem",
      "http://sns.us-east-1.amazonaws.com/cert.pem",
      "https://sns.us-west-2.amazonaws.com/cert.pem",
      "https://sns.us-east-1.amazonaws.com/cert.txt",
      "https://user@sns.us-east-1.amazonaws.com/cert.pem",
      "https://sns.us-east-1.amazonaws.com:8443/cert.pem",
      "https://sns.us-east-1.amazonaws.com/cert.pem?x=1",
    ]) {
      expect(isAllowedCertUrl(url)).toBe(false);
      expect(await verifier.verify(liveRecord(eumMessage(entry), { certUrl: url }), TEST_TOPIC_ARN)).toEqual({ ok: false, reason: "CERT_URL_INVALID" });
    }
    expect(fetched).toHaveLength(0);
    expect(isAllowedCertUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem")).toBe(true);
  });

  it("refuses (and does not cache) a certificate that cannot be fetched", async () => {
    let calls = 0;
    const verifier = createSnsVerifier(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return TEST_CERT_PEM;
    });
    expect(await verifier.verify(liveRecord(eumMessage(entry)), TEST_TOPIC_ARN)).toEqual({ ok: false, reason: "CERT_UNAVAILABLE" });
    expect(await verifier.verify(liveRecord(eumMessage(entry)), TEST_TOPIC_ARN)).toEqual({ ok: true });
  });

  it("builds the canonical string with the Subject only when SNS sent one", () => {
    const base = { Message: "m", MessageId: "id", Timestamp: "t", TopicArn: "arn", Type: "Notification" };
    expect(canonicalNotification({ ...base, Subject: null })).toBe("Message\nm\nMessageId\nid\nTimestamp\nt\nTopicArn\narn\nType\nNotification\n");
    expect(canonicalNotification({ ...base, Subject: "s" })).toBe("Message\nm\nMessageId\nid\nSubject\ns\nTimestamp\nt\nTopicArn\narn\nType\nNotification\n");
    expect(signatureMatches({ ...base, Signature: "not-base64!", MessageAttributes: {} }, TEST_CERT_PEM)).toBe(false);
  });
});
