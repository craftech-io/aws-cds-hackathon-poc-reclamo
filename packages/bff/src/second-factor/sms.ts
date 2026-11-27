// The port of the SMS code (docs/architecture-guests.md §17): one message, one number, one attempt.
// The stage sends it with Amazon SNS (outbound/transports/sms.ts, the only place a send command may
// appear); tests, the local flows and the UI server use the memory double of second-factor/doubles.ts,
// so nothing in a test ever reaches a phone.
export interface SmsMessage {
  /** E.164. */
  readonly phone: string;
  readonly text: string;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

/** The network refused the number (unsupported country, no registered sender, opted out). */
export class SmsUndeliverable extends Error {
  override readonly name = "SmsUndeliverable";
}
