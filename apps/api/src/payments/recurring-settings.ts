import type { AppConfig } from "../config";
import type { PaymentGateway, RecurringPaymentSettings } from "./types";
export function recurringSettings(
  config: AppConfig,
  gateway: PaymentGateway | null | undefined,
): RecurringPaymentSettings | null {
  const settings = config.payments;
  const bank = settings.redsys;
  if (
    !settings.recurringEnabled ||
    !settings.tokenEncryptionKey ||
    !bank ||
    !gateway?.supportsRecurring ||
    gateway.provider !== "redsys" ||
    gateway.environment !== bank.environment
  )
    return null;
  return {
    encryptionKey: settings.tokenEncryptionKey,
    merchantCode: bank.merchantCode,
    terminal: bank.terminal.padStart(3, "0"),
    environment: bank.environment,
  };
}
