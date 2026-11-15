# Sisters of Beauty — operational feature expansion

Requested 2026-11-15. This supersedes the original v1 non-goals for the features below. Scope confirmed by the owner: one Sisters of Beauty business and one location today; multisite and a multi-business marketplace are future phases. Existing booking, offline desktop, security and accessibility behavior must remain working.

The release is not complete merely because a table or endpoint exists. Each operational feature needs authorization, transactional invariants, accessible English/Spanish UI, empty/loading/error states and runnable regression coverage. External services remain disabled until configured. No real bank charges, campaigns or app-store publication are part of local verification.

## Delivery checklist

- [x] Payments and checkout: provider interface, hosted Redsys card/Bizum, signed notifications, order/amount/currency matching, idempotence, pending/declined states, cash/card records, partial payments, receipts, refund/reconciliation workflow, cash sessions and tips.
- [ ] Booking protection: configurable deposits, payment holds and expiry, cancellation policy and fees; no card data stored locally.
- [ ] Retail and staff accounting: products, stock movements, low-stock alerts, checkout inventory deduction, service/product commission rules, sales and cash reports.
- [ ] Retention: gift cards and balances, multi-visit packages, memberships and entitlements, loyalty accrual/redemption, discounts and promotion validity.
- [ ] Scheduling: automated waitlist and expiring offers, resources/capacity, recurring appointments, service variants/add-ons/combinations and processing gaps.
- [ ] CRM: client tags, blocked/trusted clients, photos, import/export and deduplication; custom intake forms/waivers with versioned answers.
- [ ] Reputation and acquisition: verified post-visit reviews, moderated public portfolio, booking links/QR/widget/social entry points.
- [ ] Marketing: explicit channel consent, client segments, templates, scheduled campaigns, unsubscribe/suppression, durable delivery and outcomes.
- [ ] Mobile experience: responsive flows and installable application behavior, offline/reconnect states, deep links and device/browser verification; native distribution only where the required platform/signing environment exists.
- [ ] Final integration: UI/UX review, cross-feature races, money/stock/entitlement invariants, all suites, production smoke and deployment guidance.

## Redsys reference

Current official signing and hosted checkout documentation:

- https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/firmar-una-operacion/
- https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/autorizacion/
- https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/devolver-o-anular-un-pago/

Integration uses HMAC_SHA512_V2, AES-CBC order diversification and the official test vector. Card entry is hosted by Redsys. Browser redirects are informational; settlement requires a valid authenticated bank response matching the persisted expected order, amount, currency, merchant and operation. Gateway config and secrets are server-only. EUR is the initial merchant currency; the existing ARS sample catalog must be changed deliberately before charging through an EUR terminal.

Merchant enrollment, bank credentials, production domain, real email/SMS delivery, third-party booking integrations and application signing/publication await their corresponding accounts and environments. Tests use local infrastructure and explicit provider fixtures.

## First delivery evidence

Payments/cash/receipts are implemented; [operator and Redsys guide](payments.md). Baseline full suites passed with 712 API and 613 web tests; subsequent focused money/print/reconciliation regressions pass as well. The Redsys adapter passes 11 tests on the pinned Bun 1.4.4 container without networking. The real mobile cash workflow was explored before its four passing light/dark mobile/desktop Playwright cases (including axe). This does not mark the other delivery blocks complete or replace real-bank activation.
