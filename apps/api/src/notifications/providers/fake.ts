import {
  type EmailMessage,
  type EmailProvider,
  type SendResult,
  type SmsMessage,
  type SmsProvider,
  TransientProviderError,
} from "./types";

type Hook = (key: string) => Promise<void> | void;

/**
 * In-memory stand-in for an external provider, used by tests and local runs. Like a real HTTP
 * provider that honours idempotency keys, it records ONE message per key however many times
 * `send` is called, and counts the calls so tests can tell a duplicate attempt from a
 * duplicate delivery.
 */
export class FakeProvider<M extends { idempotencyKey: string }> {
  /** Messages as delivered, deduplicated by idempotency key. */
  readonly delivered = new Map<string, M>();
  /** Every call to `send`, duplicates included. */
  readonly calls: M[] = [];
  /** Called before the message is recorded; throw or hang here to simulate failures/crashes. */
  beforeDeliver: Hook | undefined;
  private failures = 0;
  private failure: Error = new TransientProviderError("simulated outage");

  failNext(times: number, error: Error = new TransientProviderError("simulated outage")) {
    this.failures = times;
    this.failure = error;
  }

  async send(message: M): Promise<SendResult> {
    this.calls.push(message);
    if (this.failures > 0) {
      this.failures -= 1;
      throw this.failure;
    }
    await this.beforeDeliver?.(message.idempotencyKey);
    if (!this.delivered.has(message.idempotencyKey)) {
      this.delivered.set(message.idempotencyKey, message);
    }
    return { messageId: `fake-${message.idempotencyKey}` };
  }
}

export class FakeEmailProvider extends FakeProvider<EmailMessage> implements EmailProvider {}
export class FakeSmsProvider extends FakeProvider<SmsMessage> implements SmsProvider {}
