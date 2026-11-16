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

Open **Sales & register**. The owner, a manager or reception opens the cash register with the physically counted opening cash. Operators create a sale or open checkout from an EUR appointment; appointment prices come from its saved service snapshots. Discounts and tips are integer cents, and prices include the configured tax component. Receipts are accounting receipts, not a separately certified fiscal-invoicing integration.

Cash payments require an open drawer. External-card records mean a payment already collected on an external terminal; recording one does not charge a card. Split payments cannot exceed the balance. One unresolved online attempt blocks another collection until the result is known. Closing the register records the expected cash, actual count and difference; that count cannot subsequently be rewritten. Cash withdrawals and refunds cannot spend cash absent from the drawer.

Printing uses an isolated receipt document. It excludes register balances, other sales, operator controls and bank forms. Product/service descriptions are inserted as text, never executable markup.

## Bank authority and recovery

- Browser return/query parameters cannot mark an order paid. A signed server notification must match the persisted order, amount, currency, merchant, terminal and operation.
- Replayed notifications and repeated payment requests do not add another capture. Concurrent partial payments serialize against the checkout. Idempotency keys reject changed request bodies.
- Late/contradictory successful bank results are retained as received funds needing reconciliation/refund, rather than disappearing from the ledger. Excess money is visible on the receipt.
- If a customer abandons an online attempt, the owner or a manager can reconcile it after the initial processing window and checking the bank portal. A reference is required and the change is audited. Do not assume an abandoned browser means the bank did not collect.
- The owner or a manager requests a refund against a captured payment. Cash refunds are recorded against the current drawer; online refunds are reserved first and then sent to Redsys once. Pending reservations count against the refundable balance.
- A lost/invalid bank refund response is ambiguous: it may follow a completed refund. Such a request is not retried automatically. Reconcile it against the bank portal with a reference. A crash after dispatch also requires this recovery; in-flight work cannot be reconciled immediately.
- Keep the same merchant/terminal/signing key while attempts are unresolved. Plan bank-credential changes after reconciling the outstanding queue.

All financial mutations are audited. No raw bank notification, card details, signing key or provider exception is stored in the accounting ledger or access logs. The standalone notification worker and bootstrap container do not need bank credentials.

## Verification

Reference signing and refund-adapter tests pass on the pinned Bun 1.4.4 image with networking disabled. Real-Postgres tests cover ownership/RBAC, CSRF, immutable appointment prices, idempotency, callback tampering, bank declines, late captures, overcollection races, refunds, uncertain dispatches and cash reconciliation. React tests cover the forms and print isolation. A real Chromium mobile exploration and four mobile/desktop light/dark Playwright cases verify partial cash/card payments, receipts, refunds, register differences, no horizontal overflow and no serious/critical axe findings.

No real bank charge, refund, enrollment or production callback has been performed. Inventory fulfillment and commission/financial reports are now implemented. Deposits/booking holds and entitlements are separate remaining items in [FEATURE-EXPANSION.md](FEATURE-EXPANSION.md).

## Automatic membership renewal

Recurring payment is disabled by default. To activate it later, configure the existing Redsys terminal/secret/environment, set `REDSYS_RECURRING_ENABLED=true` and supply a separate `PAYMENT_TOKEN_ENCRYPTION_KEY` containing exactly 32 random bytes encoded as base64 (`openssl rand -base64 32`). `_FILE` secret mounting is supported. Back up this key securely with the operational recovery procedure; do not reuse an authentication or bank signing secret. An unavailable key suspends billing before any bank request.

Customers explicitly accept the displayed frozen plan price and interval. Hosted card checkout requests the initial bank reference; subsequent renewals use signed MIT REST requests. Bizum, cash and gift value do not establish a recurring card mandate. Each opaque reference is encrypted with AES-GCM and bound to its contract, merchant, terminal, environment and currency. Card numbers and CVV are never accepted or stored by the application. Missing or malformed reference metadata does not discard a confirmed payment.

The API runs the billing scheduler independently of email configuration. Several API replicas may run it: a locked contract, unique period and durable pending payment claim prevent duplicate dispatch. An existing unpaid manual renewal invoice takes precedence. The scheduler uses the agreed price and skips elapsed unpaid cycles after downtime; it does not back-bill missed periods. Unknown outcomes remain pending and are never retried automatically. Check the bank portal and use the existing reconciliation workflow; a confirmed decline requires a manual renewal payment.

Cancellation prevents future claims and erases the local encrypted capability. An in-flight bank request may still settle; its period remains funded and can be returned through the usual refund workflow. An entire-period refund or cancellation of an unpaid renewal also stops future renewals. Already paid benefits keep their recorded dates. Account eligibility, changed terms, discontinued services, expired references and vault failures suspend automatic payment for review.

After restoring an older database backup, keep the bank provider and recurring feature disabled until captured orders, refunds and cancellation records have been reconciled against the bank. Do not replay dispatch claims. Production smoke forces both payment and recurring settings off, regardless of inherited deployment variables. Notification workers do not receive bank keys in Compose.

Local verification: `bun run --cwd apps/web build`, followed by `bun run --cwd apps/web e2e:recurring`. This opt-in suite starts an isolated test database/API on localhost:4300 and web server on localhost:4273, intercepts the hosted-bank destination, validates its signed form and issues fixture callbacks. It cannot send a charge to Redsys. The regular browser suite excludes this fixture-only test. Real terminal activation and bank acceptance testing await the actual merchant account.

Primary specifications: [Redsys MIT integration](https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-funcionalidades-avanzadas/tokenizacion/tokenizacion-mit/), [CIT integration](https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-funcionalidades-avanzadas/tokenizacion/tokenizacion-cit/) and [parameter definitions](https://pagosonline.redsys.es/desarrolladores-inicio/integrate-con-nosotros/parametros-de-entrada-y-salida/).
