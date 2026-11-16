import type { MandateReference } from "./mandate-types";
import type { BankNotification, HostedPaymentForm } from "./redsys";

/** Application boundary: accounting never handles a gateway's secret or card details. */
export interface PaymentGateway {
  readonly provider: string;
  readonly environment: "test" | "live";
  readonly supportsRecurring?: boolean;
  chargeRecurring?(input: {
    order: string;
    amountCents: number;
    currency: string;
    mandate: MandateReference;
  }): Promise<BankNotification>;
  checkout(input: {
    order: string;
    amountCents: number;
    currency: string;
    method: "card" | "bizum";
    createMandate?: boolean;
  }): HostedPaymentForm;
  verify(fields: Record<string, unknown>, expectedType?: string): BankNotification;
  refund(input: {
    order: string;
    amountCents: number;
    currency: string;
    refundId: string;
  }): Promise<BankNotification>;
}

export interface RecurringPaymentSettings {
  encryptionKey: string;
  merchantCode: string;
  terminal: string;
  environment: "test" | "live";
}
