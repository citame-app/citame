import type { NotificationConfig } from "../../config";
import { createSmtpProvider } from "./smtp";
import { createTwilioProvider } from "./twilio";
import type { EmailProvider, SmsProvider } from "./types";

export interface Providers {
  /** Null means the channel is disabled: its messages are marked `skipped`. */
  email: EmailProvider | null;
  sms: SmsProvider | null;
}

export function createProviders(config: NotificationConfig): Providers {
  return {
    email:
      config.email.provider === "smtp" && config.email.smtpUrl
        ? createSmtpProvider({ url: config.email.smtpUrl, from: config.email.from })
        : null,
    sms:
      config.sms.provider === "twilio" &&
      config.sms.accountSid &&
      config.sms.authToken &&
      config.sms.from
        ? createTwilioProvider({
            accountSid: config.sms.accountSid,
            authToken: config.sms.authToken,
            from: config.sms.from,
          })
        : null,
  };
}
