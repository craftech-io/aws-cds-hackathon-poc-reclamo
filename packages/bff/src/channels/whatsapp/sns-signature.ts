// Verification of a live record (docs/architecture.md §13, FL-103, FL-104 (c)): `InboundWhatsApp`
// accepts a record from End User Messaging Social only when it came through SNS (`EventSource =
// aws:sns`), from the app's topic (`TopicArn`), and its signature verifies against the certificate SNS
// publishes. `SignatureVersion 2` is SHA256withRSA over the canonical string of the notification:
//
//   Message\n<Message>\nMessageId\n<MessageId>\n[Subject\n<Subject>\n]Timestamp\n<Timestamp>\n
//   TopicArn\n<TopicArn>\nType\n<Type>\n
//
// The certificate URL must be `https://sns.us-east-1.amazonaws.com/….pem` exactly (no port, no
// credentials, no other host): anything else is refused before a single byte is fetched. Certificates
// are cached per URL for the life of the container; a fetch has a deadline and a short retry.
import { createPublicKey, verify } from "node:crypto";
import { withDeadline } from "../../lib/deadline";
import { withRetry } from "../../lib/retry";
import { CERT_FETCH_TIMEOUT_MS, SNS_CERT_HOST, SNS_EVENT_SOURCE } from "./config";
import type { SnsNotification, SnsRecord } from "./payloads";

export const SNS_REJECTIONS = ["NOT_SNS", "TOPIC_MISMATCH", "UNSUPPORTED_SIGNATURE_VERSION", "CERT_URL_INVALID", "CERT_UNAVAILABLE", "SIGNATURE_INVALID"] as const;
export type SnsRejection = (typeof SNS_REJECTIONS)[number];

export type SnsVerification = { readonly ok: true } | { readonly ok: false; readonly reason: SnsRejection };

/** Gets the PEM at a URL already checked by `isAllowedCertUrl`. */
export type CertificateFetcher = (url: string) => Promise<string>;

export interface SnsVerifier {
  verify(record: SnsRecord, expectedTopicArn: string): Promise<SnsVerification>;
}

/** The only certificate URLs a live record may name. */
export function isAllowedCertUrl(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === SNS_CERT_HOST && url.port === "" && url.username === "" && url.password === "" && url.pathname.endsWith(".pem") && url.search === "" && url.hash === "";
}

/** The canonical string SNS signs for a `Notification`. */
export function canonicalNotification(sns: Pick<SnsNotification, "Message" | "MessageId" | "Subject" | "Timestamp" | "TopicArn" | "Type">): string {
  const pairs: Array<readonly [string, string]> = [
    ["Message", sns.Message],
    ["MessageId", sns.MessageId],
    ...(sns.Subject === undefined || sns.Subject === null ? [] : [["Subject", sns.Subject] as const]),
    ["Timestamp", sns.Timestamp],
    ["TopicArn", sns.TopicArn],
    ["Type", sns.Type],
  ];
  return pairs.map(([name, value]) => `${name}\n${value}\n`).join("");
}

/** True when `signature` (base64) is the SHA256withRSA of the canonical string under the PEM's key. */
export function signatureMatches(sns: SnsNotification, pem: string): boolean {
  if (sns.Signature === undefined) return false;
  try {
    return verify("RSA-SHA256", Buffer.from(canonicalNotification(sns)), createPublicKey(pem), Buffer.from(sns.Signature, "base64"));
  } catch {
    return false;
  }
}

class CertificateFetchError extends Error {
  override readonly name = "CertificateFetchError";
  readonly retryable = true;
}

/** The real fetcher: `fetch` with a deadline, two retries, and only a PEM body accepted. */
export const fetchCertificate: CertificateFetcher = async (url) =>
  withRetry(
    () =>
      withDeadline("sns.certificate", CERT_FETCH_TIMEOUT_MS, async (signal) => {
        const response = await fetch(url, { signal, redirect: "error" });
        if (!response.ok) throw new CertificateFetchError(`certificate fetch answered ${response.status}`);
        const body = await response.text();
        if (!body.includes("-----BEGIN CERTIFICATE-----")) throw new CertificateFetchError("the certificate URL did not return a PEM certificate");
        return body;
      }),
    { attempts: 3, baseDelayMs: 100, maxDelayMs: 500, shouldRetry: (error) => error instanceof CertificateFetchError || (error instanceof Error && error.name === "DeadlineError") },
  );

/** A verifier with a per-container certificate cache; tests inject their own fetcher. */
export function createSnsVerifier(fetcher: CertificateFetcher = fetchCertificate): SnsVerifier {
  const cache = new Map<string, Promise<string>>();

  const certificate = (url: string): Promise<string> => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    const pending = fetcher(url);
    cache.set(url, pending);
    // A failed fetch is not cached: the next record (or SNS's retry) tries again.
    pending.catch(() => cache.delete(url));
    return pending;
  };

  return {
    async verify(record, expectedTopicArn) {
      if (record.EventSource !== SNS_EVENT_SOURCE) return { ok: false, reason: "NOT_SNS" };
      const sns = record.Sns;
      if (sns.TopicArn !== expectedTopicArn) return { ok: false, reason: "TOPIC_MISMATCH" };
      if (sns.SignatureVersion !== "2") return { ok: false, reason: "UNSUPPORTED_SIGNATURE_VERSION" };
      const url = sns.SigningCertUrl ?? sns.SigningCertURL;
      if (!isAllowedCertUrl(url) || url === undefined) return { ok: false, reason: "CERT_URL_INVALID" };
      let pem: string;
      try {
        pem = await certificate(url);
      } catch {
        return { ok: false, reason: "CERT_UNAVAILABLE" };
      }
      return signatureMatches(sns, pem) ? { ok: true } : { ok: false, reason: "SIGNATURE_INVALID" };
    },
  };
}
