import type { BankNotification, HostedPaymentForm } from "./redsys";

/** Application boundary: accounting never handles a gateway's secret or card details. */
export interface PaymentGateway {
  readonly provider: string;
  readonly environment: "test" | "live";
  checkout(input: {
    order: string;
    amountCents: number;
    currency: string;
    method: "card" | "bizum";
  }): HostedPaymentForm;
  verify(fields: Record<string, unknown>, expectedType?: string): BankNotification;
  refund(input: {
    order: string;
    amountCents: number;
    currency: string;
    refundId: string;
  }): Promise<BankNotification>;
}
