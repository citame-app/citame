import { expect, test } from "bun:test";
import { reviewBooksyPaymentEvidence } from "./payment-evidence";

const noDeposit = {
  deposit_id: null,
  deposit_info: null,
  transaction_id: null,
  transaction_info: null,
};
const authorization = {
  id: 1,
  already_paid: "0,00 €",
  total: "7,50 €",
  remaining: "7,50 €",
  status_type: "authorized",
  short_status: "authorized",
  pnref: null,
  payment_rows: [{ status: "authorized", payment_intent: null }],
};

function review(...payments: unknown[]) {
  return reviewBooksyPaymentEvidence({
    groups: payments.map((payment_info, i) => ({
      sourceId: String(i),
      ids: [],
      raw: { appointment: { payment_info } },
    })),
  });
}

test("Booksy authorization with an amount still due is distinct from money already paid", () => {
  expect(
    review(
      null,
      noDeposit,
      { ...noDeposit, deposit_id: 1, deposit_info: authorization },
      {
        ...noDeposit,
        deposit_id: 1,
        deposit_info: { ...authorization, already_paid: "2,00 €", remaining: "5,50 €" },
      },
    ),
  ).toEqual({
    withoutPaymentDetail: 1,
    withoutDeposit: 1,
    authorizedWithoutCharge: 1,
    observedPositivePayment: 1,
    needsReconciliation: 0,
  });
});

test("unreadable, contradictory or transaction-backed details require reconciliation", () => {
  const captured = { ...noDeposit, deposit_id: 1, deposit_info: authorization };
  expect(
    review(
      { ...noDeposit, transaction_id: 11 },
      { ...captured, deposit_id: 2 },
      { ...captured, deposit_info: { ...authorization, remaining: "0,00 €" } },
      {
        ...captured,
        deposit_info: {
          ...authorization,
          payment_rows: [{ status: "captured", payment_intent: null }],
        },
      },
      { ...captured, deposit_info: { ...authorization, already_paid: "No mostrar" } },
    ),
  ).toMatchObject({ authorizedWithoutCharge: 0, needsReconciliation: 5 });
});
