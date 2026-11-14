import {
  PermanentProviderError,
  type SendResult,
  type SmsMessage,
  type SmsProvider,
  TransientProviderError,
} from "./types";

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** Sender number (E.164) or a messaging service sid (`MG...`). */
  from: string;
  /** Override for tests; defaults to Twilio's API. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Twilio Programmable Messaging over plain HTTP (no SDK). Disabled unless
 * NOTIFY_SMS_PROVIDER=twilio. The documented Messages API has no idempotency key, so SMS
 * delivery is at-least-once in the crash window between "accepted" and "marked sent"
 * (ADR 0010). Verified only against a local stub, never against the real service.
 */
export function createTwilioProvider(options: TwilioOptions): SmsProvider {
  const base = (options.baseUrl ?? "https://api.twilio.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;
  return {
    async send(message: SmsMessage): Promise<SendResult> {
      const form = new URLSearchParams({ To: message.to, Body: message.body });
      form.set(options.from.startsWith("MG") ? "MessagingServiceSid" : "From", options.from);
      let response: Response;
      try {
        response = await doFetch(
          `${base}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: auth,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form,
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch (error) {
        throw new TransientProviderError(error instanceof Error ? error.message : "network error");
      }
      if (response.ok) {
        const body = (await response.json()) as { sid?: string };
        if (!body.sid) throw new TransientProviderError("Twilio response without a sid");
        return { messageId: body.sid };
      }
      const text = (await response.text()).slice(0, 300);
      const error = `Twilio ${response.status}: ${text}`;
      // 429 and 5xx are worth retrying; the other 4xx (bad number, unsubscribed, auth) are not.
      if (response.status === 429 || response.status >= 500)
        throw new TransientProviderError(error);
      throw new PermanentProviderError(error);
    },
  };
}
