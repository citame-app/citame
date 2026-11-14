export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Calendar entry, attached as `invite.ics`. */
  ics?: string;
  headers?: Record<string, string>;
  /** Stable per reminder row: providers that support it use it to drop duplicate sends. */
  idempotencyKey: string;
}

export interface SmsMessage {
  to: string;
  body: string;
  idempotencyKey: string;
}

export interface SendResult {
  messageId: string;
}

/** Worth retrying: network trouble, 4xx throttling, 5xx, SMTP 4xx. */
export class TransientProviderError extends Error {
  override name = "TransientProviderError";
}

/** Retrying cannot help: invalid recipient, rejected content, bad credentials. */
export class PermanentProviderError extends Error {
  override name = "PermanentProviderError";
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<SendResult>;
  close?(): Promise<void>;
}

export interface SmsProvider {
  send(message: SmsMessage): Promise<SendResult>;
  close?(): Promise<void>;
}
