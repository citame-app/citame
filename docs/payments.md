# Payments and cash register

Current implementation serves one Sisters of Beauty location. It never takes card numbers or CVV. Redsys hosts card/Bizum entry; the application stores accounting records and verified outcomes. Online payments are disabled until a merchant account is configured.

## Prepare Redsys

1. Obtain the merchant/FUC, terminal and signing key from the bank. Use the bank-provided key; do not invent a key or use the public fixtures in the unit tests.
2. Set `PAYMENT_PROVIDER=redsys`, `REDSYS_MERCHANT_CODE`, `REDSYS_TERMINAL`, `REDSYS_SECRET_KEY` and `REDSYS_ENVIRONMENT=test`. The API also accepts `REDSYS_SECRET_KEY_FILE` for a mounted secret in a custom deployment. Keep secrets out of the web build and version control.
3. Set the existing public web origin (`PUBLIC_URL` in production Compose). The callback is `<origin>/api/payments/redsys/notify`. The browser returns to `<origin>/payments/<order>`. Bank callbacks need a publicly reachable HTTPS deployment; localhost fixtures do not establish real bank connectivity.
4. Configure and review EUR catalog prices deliberately. The sample catalog uses ARS; changing currency is not an exchange-rate conversion. An EUR terminal must never charge an ARS price as EUR implicitly.
5. Enable `REDSYS_BIZUM_ENABLED=true` only after Bizum is activated on that terminal. Card/Bizum remain unavailable while the provider is disabled.
6. Complete the bank's test/approval procedure with its own test credentials before switching `REDSYS_ENVIRONMENT=live`. Live configuration requires HTTPS.

Default endpoints, signing version and the public reference vector follow the current official Redsys documentation:

- [Signing](https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/firmar-una-operacion/)
- [Hosted payments](https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/autorizacion/)
- [Refunds](https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/devolver-o-anular-un-pago/)

## Operator workflow

Open **Sales & register**. An owner opens the cash register with the physically counted opening cash. Operators create a sale or open checkout from an EUR appointment; appointment prices come from its saved service snapshots. Discounts and tips are integer cents, and prices include the configured tax component. Receipts are accounting receipts, not a separately certified fiscal-invoicing integration.

Cash payments require an open drawer. External-card records mean a payment already collected on an external terminal; recording one does not charge a card. Split payments cannot exceed the balance. One unresolved online attempt blocks another collection until the result is known. Closing the register records the expected cash, actual count and difference; that count cannot subsequently be rewritten. Cash withdrawals and refunds cannot spend cash absent from the drawer.

Printing uses an isolated receipt document. It excludes register balances, other sales, operator controls and bank forms. Product/service descriptions are inserted as text, never executable markup.

## Bank authority and recovery

- Browser return/query parameters cannot mark an order paid. A signed server notification must match the persisted order, amount, currency, merchant, terminal and operation.
- Replayed notifications and repeated payment requests do not add another capture. Concurrent partial payments serialize against the checkout. Idempotency keys reject changed request bodies.
- Late/contradictory successful bank results are retained as received funds needing reconciliation/refund, rather than disappearing from the ledger. Excess money is visible on the receipt.
- If a customer abandons an online attempt, an owner can reconcile it after the initial processing window and checking the bank portal. A reference is required and the change is audited. Do not assume an abandoned browser means the bank did not collect.
- An owner requests a refund against a captured payment. Cash refunds are recorded against the current drawer; online refunds are reserved first and then sent to Redsys once. Pending reservations count against the refundable balance.
- A lost/invalid bank refund response is ambiguous: it may follow a completed refund. Such a request is not retried automatically. Reconcile it against the bank portal with a reference. A crash after dispatch also requires this recovery; in-flight work cannot be reconciled immediately.
- Keep the same merchant/terminal/signing key while attempts are unresolved. Plan bank-credential changes after reconciling the outstanding queue.

All financial mutations are audited. No raw bank notification, card details, signing key or provider exception is stored in the accounting ledger or access logs. The standalone notification worker and bootstrap container do not need bank credentials.

## Verification

Reference signing and refund-adapter tests pass on the pinned Bun 1.4.4 image with networking disabled. Real-Postgres tests cover ownership/RBAC, CSRF, immutable appointment prices, idempotency, callback tampering, bank declines, late captures, overcollection races, refunds, uncertain dispatches and cash reconciliation. React tests cover the forms and print isolation. A real Chromium mobile exploration and four mobile/desktop light/dark Playwright cases verify partial cash/card payments, receipts, refunds, register differences, no horizontal overflow and no serious/critical axe findings.

No real bank charge, refund, enrollment or production callback has been performed. Deposits/booking holds, inventory fulfillment, entitlements and advanced financial reports are separate remaining items in [FEATURE-EXPANSION.md](FEATURE-EXPANSION.md).
