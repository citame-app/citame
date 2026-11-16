# Sisters of Beauty — operational feature expansion

Requested 2026-11-15. This supersedes the original v1 non-goals for the features below. Scope confirmed by the owner: one Sisters of Beauty business and one location today; multisite and a multi-business marketplace are future phases. Existing booking, offline desktop, security and accessibility behavior must remain working.

The release is not complete merely because a table or endpoint exists. Each operational feature needs authorization, transactional invariants, accessible English/Spanish UI, empty/loading/error states and runnable regression coverage. External services remain disabled until configured. No real bank charges, campaigns or app-store publication are part of local verification.

## Delivery checklist

- [x] Payments and checkout: provider interface, hosted Redsys card/Bizum, signed notifications, order/amount/currency matching, idempotence, pending/declined states, cash/card records, partial payments, receipts, refund/reconciliation workflow, cash sessions and tips.
- [x] Booking protection: configurable deposits, payment holds and expiry, accepted cancellation policy and bounded fees; no card data stored locally. [Operator guide](booking-deposits.md).
- [x] Retail inventory: products, stock movements, low-stock alerts, checkout reservations/deduction, expiry/void and physical returns; [operator guide](inventory.md).
- [x] Staff accounting: service/product commission rules, attribution, immutable accruals, refund adjustments, payout records, sales/cash reports and CSV exports; [operator guide](accounting.md).
- [x] Staff access: five effective access levels with scoped calendar, sales, cash, inventory, costs and commission permissions; [access guide](staff-access.md).
- [x] Gift cards: paid activation, bearer codes, balances, partial redemption, refund holds/restoration, closure, code/expiry recovery, vouchers and customer account UI; [operator guide](gift-cards.md).
- [x] Packages and memberships: multi-visit plans, paid periods, eligible-service entitlements, opt-in card renewals and cancellation; [operator guide](passes.md).
- [x] Loyalty and promotions: accrual/redemption, original-credit refund adjustments, discounts, usage limits and validity; [operator guide](loyalty-and-promotions.md).
- [ ] Scheduling: automated waitlist and expiring offers, resources/capacity, recurring appointments, service variants/add-ons/combinations and processing gaps.
- [ ] CRM: client tags, blocked/trusted clients, photos, import/export and deduplication; custom intake forms/waivers with versioned answers.
- [ ] Reputation and acquisition: verified post-visit reviews, moderated public portfolio, booking links/QR/widget/social entry points.
- [ ] Marketing: explicit channel consent, client segments, templates, scheduled campaigns, unsubscribe/suppression, durable delivery and outcomes, including transactional gift/pass delivery.
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

## Retail delivery evidence

Inventory integration: 726 API, 620 web, 118 contract and 47 database tests passed. Eight real Chromium checkout/inventory cases passed across mobile/desktop and light/dark, including axe and horizontal-overflow checks. Typechecking and repository lint passed. Inventory is tracked separately from commissions and access presets, which remain open.

## Accounting delivery evidence

Commission/accounting plus checkout/inventory regression coverage: 38 targeted API tests passed, including stale revisions, refund adjustments, payout concurrency and upgrade of open receipts. Full web (623), contracts (120), database (47) suites passed before the final CSV addition; the added CSV and affected UI tests pass. Four real mobile/desktop light/dark browser cases passed, including downloaded CSV contents and axe. Financial statement cache invalidation was corrected from a reproduced browser regression.

## Access delivery evidence

Full suites passed: 742 API, 627 web, 123 contracts and 47 database tests. Four light/dark mobile/desktop Chromium workflows passed for owner profile changes, read-only calendar presentation, live-session promotion and rejected account/access escalation, including axe and horizontal-overflow checks. Shared policies also cover sync and MCP; a customer-route permission bypass was reproduced and covered before correction. Typechecking and repository lint pass.

## Gift-card delivery evidence

Full suites passed with 752 API, 632 web, 125 contract and 47 database tests; four light/dark mobile/desktop Chromium gift workflows passed, including isolated print-document inspection, redemption/refund balance checks and axe. A subsequent financial regression run passed 55 tests for full-return closure and late captures; all 12 gift tests pass after also covering expired-request replay. Typechecking and repository lint pass. No real bank operation or gift delivery was performed.

## Prepaid visits and membership progress

Packages and manually renewed memberships now have frozen server-priced terms, paid activation, discrete visit allocations, period/expiry checks, concurrent redemption protection, whole-visit return quotes, bank-refund holds, manual renewal/cancellation, scoped EN/ES operator/customer UI and integrated commissions/reports; [operator guide](passes.md), [decision](adr/0014-prepaid-visits.md). Automatic recurring bank mandates and transactional delivery remain open and requests for automatic payment fail closed. This block remains unchecked until that remaining scope is addressed.

Prepaid verification: full suites passed with 776 API, 637 web, 128 contracts and 47 database tests. Four mobile/desktop light/dark Playwright workflows passed with actual plan creation, activation, redemption, full visit restoration, original-penny purchase returns, axe and horizontal-overflow checks. Subsequent financial edge regressions passed 44 tests, covering settlement timing, split-method access-fee returns and excess-first quotes. Typechecking and repository lint pass. Automatic recurring payment remains unavailable and is not represented as delivered.

## CRM controls progress

Client labels, literal tag search, blocked/trusted profiles, owner/manager access control, private reasons, audited revisions and EN/ES editing are implemented; [guide](client-controls.md). Shared booking checks protect REST, MCP and offline replay. Concurrent controls preserve drafts and metadata updates preserve unsaved contact edits. Photos, imports/merges and versioned forms/waivers remain open; the overall CRM block is not marked complete.

CRM controls verification: 785 API, 641 web, 129 contracts and 47 database tests passed in the full suites. Four mobile/desktop light/dark Chromium workflows passed with blocked booking checks, searched tags, preserved contact drafts, axe and horizontal-overflow checks. Subsequent focused UI coverage also checks visible duplicate-label validation. Typechecking and repository lint pass.

## Automatic membership renewal delivery

The previous gateway groundwork is now integrated: explicit customer consent binds the displayed plan revision and frozen price; authenticated hosted payment can establish an encrypted reference, and a bounded scheduler claims each renewal once before contacting the provider. Unknown outcomes remain pending for reconciliation without automatic retries. Cancellation erases the reference and stops future dispatch, including when settlement races with an older displayed revision; already funded benefits remain valid. Blocked/unlinked customers, changed terms, archived services, invalid encryption bindings and expired references cannot trigger new charges. Operator lists identify the buyer without exposing private notes. Transactional delivery remains in the marketing block.

Verification: full suites passed with 808 API, 646 web, 129 contracts and 47 database tests. Subsequent buyer-context and unpaid-validity regressions pass. Four real mobile/desktop light/dark Chromium workflows passed for explicit consent, authenticated fixture capture, scheduled renewal, paid periods and cancellation, including axe and overflow checks. The fixture is opt-in and isolated from the production executable; no real bank request was made. Adapter/vault tests also pass on pinned Bun 1.4.4 without networking. Typechecking and repository lint pass. Activation still requires the real terminal's COF/MIT acceptance, credentials and a separate encryption key; recurring payments default off.

## Booking-protection delivery

Owner-controlled policies default off. Accepted policy revisions and reviewed service prices bind a server-priced appointment receipt; its deposit is collected once and the service remainder becomes payable after completion. Required funding gates confirmation/reminders. The independent expiry loop, signed callbacks and manual reconciliation preserve released time when a bank outcome arrives late. Existing membership discounts are retained, including fully discounted visits. Cancellation/no-show fees are capped by captured deposits; returning them reverses separate fee accounting. Refunds remain due back until actually confirmed. Refunds that leave a required deposit underfunded cancel the reservation, and a completed protected visit cannot be rewritten as a no-show.

Verification: 824 API, 654 web, 129 contract and 47 database tests passed in full suites. Subsequent focused financial regressions cover full discounts, completed-state corrections, refund visibility and expired manual reconciliation. Four real mobile/desktop light/dark Chromium workflows passed for policy editing, explicit agreement, hosted fixture payment, cancellation and original-method refund, including axe and overflow. This exposed and corrected the cancelled-card contrast regression. Light/mobile and dark/desktop captures were visually reviewed. External payment activation remains pending; no bank was contacted. See [operational behavior and constraints](booking-deposits.md).

## Loyalty and promotion delivery

The points program defaults off. Customer-linked salon sales earn once on fulfilled eligible value, with original allocated prepaid value, independent expiry and no double earning on gift/pass purchases. Atomic reservations prevent concurrent overspending. Returns reverse earnings, recover previously used point deficits and restore original redemption allocations with their original validity; zero-total point-funded receipts have an explicit manager return. Codes support fixed/percentage discounts, validity, spend/cap limits, eligible kinds/services, global/per-customer quotas and revision-fenced edits. Counter-sale abandonment releases points, quota and stock; pending bank results preserve claims, and booked visits keep rewards until completion/cancellation. A reward and a discrete prepaid visit cannot consume the same service without producing the promised saving. Private client accounts, scoped staff history, EN/ES controls, customer selection at sale creation and printable reward details are integrated. Campaign delivery remains separate work.

Verification: full API (845), contract (129) and database (47) suites passed. The full web suite passed with 662 tests, including the added printable reward regression. Four real light/dark mobile/desktop Chromium workflows passed for program editing, credits, reviewed redemption, customer activity, earning/returns, promotion creation and quota release, including axe and horizontal overflow. Long offer/receipt names were reproduced and corrected; customer mobile/desktop captures were visually reviewed. Typechecking and repository lint pass. All data and external-card operations were explicit isolated fixtures; no real bank request or delivery was made.

Subsequent money-range regression coverage passes 53 rewards, checkout and booking-protection tests, including percentage offers on supported gross values above the payable-total limit. The final four browser cases pass after the mobile metric and plural-message refinements.
