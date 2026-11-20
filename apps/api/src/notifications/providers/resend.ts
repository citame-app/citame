import { z } from "zod";
import { type EmailProvider, PermanentProviderError, TransientProviderError } from "./types";

const success = z.object({ id: z.string().uuid() });
const failure = z.object({ name: z.string() });

export function createResendProvider(from: string, apiKey: string, request = fetch): EmailProvider {
  return {
    async send(message) {
      let response: Response;
      try {
        response = await request("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            headers: message.headers,
            attachments: message.ics
              ? [
                  {
                    filename: "invite.ics",
                    content: Buffer.from(message.ics).toString("base64"),
                    content_type: "text/calendar; charset=utf-8; method=PUBLISH",
                  },
                ]
              : undefined,
          }),
        });
      } catch {
        throw new TransientProviderError("resend_connection_failed");
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const result = success.safeParse(body);
        if (!result.success) throw new TransientProviderError("resend_confirmation_unreadable");
        return { messageId: result.data.id };
      }
      const parsed = failure.safeParse(body);
      if (
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 409 && parsed.data?.name === "concurrent_idempotent_requests")
      )
        throw new TransientProviderError(`resend_temporary_${response.status}`);
      throw new PermanentProviderError(`resend_rejected_${response.status}`);
    },
  };
}
