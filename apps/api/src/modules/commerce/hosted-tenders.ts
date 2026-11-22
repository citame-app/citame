import type { AppDeps } from "../../app";
import { RedsysGateway } from "../../payments/redsys";
import type { PaymentGateway } from "../../payments/types";

export function gatewayFor(deps: AppDeps) {
  if (deps.paymentGateway !== undefined) return deps.paymentGateway;
  return deps.config.payments.redsys ? new RedsysGateway(deps.config.payments.redsys) : null;
}

export function checkoutBankTenders(deps: AppDeps, gateway: PaymentGateway | null) {
  return gateway
    ? {
        bankTenders: {
          card: true,
          bizum: deps.config.payments.bizumEnabled,
          generation: deps.config.syncReplicaGeneration,
        },
      }
    : {};
}
