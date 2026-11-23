import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import {
  type EmailMessage,
  type EmailProvider,
  PermanentProviderError,
  type SendResult,
  TransientProviderError,
} from "./types";

/** SMTP codes: 5xx is a verdict about the message or recipient, 4xx and I/O errors are retryable. */
function classify(error: unknown): Error {
  const { responseCode, code } = (error as { responseCode?: number; code?: string } | null) ?? {};
  if (code === "EAUTH") return new PermanentProviderError("smtp_authentication_failed");
  if (responseCode && responseCode >= 500 && responseCode <= 599) {
    return new PermanentProviderError(`smtp_rejected_${responseCode}`);
  }
  if (responseCode && responseCode >= 400 && responseCode <= 499) {
    return new TransientProviderError(`smtp_temporary_${responseCode}`);
  }
  return new TransientProviderError("smtp_delivery_failed");
}

/**
 * Network timeouts. Without them a server that accepts the connection and then goes quiet would
 * hold a worker (and its job lease) indefinitely. Their sum stays well under the 120 s job lease.
 */
export const SMTP_TIMEOUTS = { connectionMs: 10_000, greetingMs: 10_000, socketMs: 30_000 };

type SmtpConnection = { url: string } | { connection: SMTPTransport.Options };

function smtpConnectionUrl(input?: string) {
  if (!input) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid SMTP connection URL");
  }
  // Nodemailer applies URL query options after the transport options.
  url.searchParams.delete("maxRequeues");
  url.searchParams.delete("url");
  return url.href;
}

/**
 * SMTP through nodemailer. SMTP has no idempotency key: the deterministic `Message-ID` lets a
 * receiving server or the operator spot a duplicate, but a crash between "server accepted" and
 * "row marked sent" can still deliver twice (at-least-once, see ADR 0010).
 */
export function createSmtpProvider(
  options: { from: string; timeouts?: typeof SMTP_TIMEOUTS } & SmtpConnection,
): EmailProvider {
  const timeouts = options.timeouts ?? SMTP_TIMEOUTS;
  const connection = "url" in options ? { url: options.url } : options.connection;
  const transport = nodemailer.createTransport({
    ...connection,
    url: smtpConnectionUrl(connection.url),
    pool: true,
    maxConnections: 2,
    // Let Citame record the failed attempt before performing a retry.
    maxRequeues: 0,
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
  });
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
