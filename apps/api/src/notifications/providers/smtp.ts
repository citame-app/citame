import nodemailer from "nodemailer";
import {
  type EmailMessage,
  type EmailProvider,
  PermanentProviderError,
  type SendResult,
  TransientProviderError,
} from "./types";

/** SMTP codes: 5xx is a verdict about the message or recipient, 4xx and I/O errors are retryable. */
function classify(error: unknown): Error {
  const e = error as { responseCode?: number; code?: string; message?: string };
  const message = e.message ?? "SMTP error";
  if (e.code === "EAUTH") return new PermanentProviderError(message);
  if (typeof e.responseCode === "number" && e.responseCode >= 500) {
    return new PermanentProviderError(message);
  }
  return new TransientProviderError(message);
}

/**
 * SMTP through nodemailer. SMTP has no idempotency key: the deterministic `Message-ID` lets a
 * receiving server or the operator spot a duplicate, but a crash between "server accepted" and
 * "row marked sent" can still deliver twice (at-least-once, see ADR 0010).
 */
export function createSmtpProvider(options: { url: string; from: string }): EmailProvider {
  const transport = nodemailer.createTransport({ url: options.url, pool: true, maxConnections: 2 });
  const domain = options.from.match(/@([^>\s]+)>?\s*$/)?.[1] ?? "localhost";
  return {
    async send(message: EmailMessage): Promise<SendResult> {
      try {
        const info = await transport.sendMail({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          messageId: `<${message.idempotencyKey}@${domain}>`,
          headers: message.headers,
          attachments: message.ics
            ? [
                {
                  filename: "invite.ics",
                  content: message.ics,
                  contentType: "text/calendar; charset=utf-8; method=PUBLISH",
                },
              ]
            : undefined,
        });
        return { messageId: info.messageId };
      } catch (error) {
        throw classify(error);
      }
    },
    async close() {
      transport.close();
    },
  };
}
