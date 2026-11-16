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
- [ ] Reputation and acquisition: completed-appointment reviews and moderated public portfolio are implemented; booking links/QR/widget/social entry points remain open.
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

## Recurring appointment progress

The operator calendar now reviews and creates bounded weekly/monthly series atomically. Repeats retain salon-local time across DST and use the original day for independently clamped shorter months. Each appointment keeps its normal snapshot, payment, deposit, cancellation and notification behavior. Calendar/account views expose the series and individual changes; reads are scoped to current calendars and the client's own visits. Changed terms invalidate the preview, unavailable dates cannot create partial series, and retries cannot duplicate the series. [Operator guide and limits](recurring-appointments.md). Automated waitlists, resources, service variants/add-ons and processing gaps remain open, so the overall scheduling block stays unchecked.

Verification: full suites passed with 856 API, 667 web, 129 contract and 47 database tests. Four light/dark mobile/desktop browser cases passed for a real occupied-date preview, refreshed availability, creation, private customer view and cancellation of only the middle visit; axe and horizontal-overflow checks passed. The final scope/UI corrections also pass, and the subsequent focused regression omits deleted visits without renumbering the remaining visits. Typechecking and repository lint pass. The browser fixture is local and sends no bank operation or message.

## Waitlist progress

Owner-controlled waitlists default off. Customers and permitted operators can register bounded service/date/time preferences; an independent bounded scheduler offers an actually available professional and temporarily reserves the slot. Availability, normal booking, rescheduling, delegated booking and offline replay honor unexpired holds. Acceptance binds the reviewed price and current deposit terms, creates an ordinary appointment atomically and is idempotent. Expiry/decline releases capacity, blocked or unavailable profiles/services/performers withdraw offers, and per-customer active/daily limits constrain repeated holds. Customer accounts, scoped operator queues, explicit policy/offer controls, existing booking links and EN/ES layouts are integrated. [Operator guide and delivery scope](waitlist.md). Email/SMS offer delivery remains part of the open durable messaging block; offers currently appear in the authenticated account. Resources and the remaining scheduling features are still open.

Verification: full suites passed with 871 API, 671 web, 129 contract and 47 database tests. The subsequent 15-test waitlist regression includes an offer issued exactly at salon-local midnight in the daily cap. Four light/dark mobile/desktop Chromium cases passed for policy editing, a private offer, explicit deposit consent, conversion, expiry, released availability and request cancellation; Spanish layout, page title, axe and horizontal-overflow checks pass. The mobile review capture was visually reviewed. Typechecking and repository lint pass. Recurrence date/DST tests also pass on pinned Bun 1.4.4 without networking. All browser accounts and expiry controls are isolated fixtures; no bank request or real message was sent.

### Shared-resource scheduling progress

Rooms, stations and equipment now have transactional pooled capacity, per-service quantities, future-visit/offer reconfiguration, protected booking and waitlist release paths, calendar detail and an English/Spanish administration panel. Reprogramming uses authorized self-exclusion and booked service durations. See [the resource guide](resources.md) and [ADR 0015](adr/0015-shared-resource-capacity.md). The broad scheduling item remains open for variants, add-ons, combinations and processing gaps.

### Variant and extra scheduling progress

The catalog now supports independently priced/timed variants, explicit eligible extras (including price-only extras), family exclusivity, atomic editor submissions and server validation shared with recurrence and waitlists. The English/Spanish customer and operator selectors preserve sequence and compatible extras. See [the service-options guide](service-options.md). Curated combinations, processing gaps and native presentation of option metadata remain open.

### Reviewed booking terms

Interactive bookings now bind every selected service to its reviewed price/duration/option identity, rechecking after scheduling locks. Changed terms require fresh selection and timing; the operator form preserves its draft and refreshes current terms. Existing API/offline clients may omit the optional fence for compatibility. See [reviewed quote behavior and verification](booking-quotes.md).

Local verification after variants/extras: the complete API suite passed 901 tests, web 689, contracts 134, database 47, forced type checks and repository lint. Subsequent reviewed-quote and notification regressions passed 47 targeted API tests (including MCP), 693 web tests, and four real browser cases that reject a changed price then confirm only after a fresh review. These counts describe tested local code; the unchecked delivery blocks above remain open.

Interactive booking retries now retain an intent UUID and recover only the original creator's matching visit, including uncertain responses and concurrent walk-ins. The four option-booking browser cases pass with a deliberately lost post-commit response and recovery of the same visit. Targeted REST/MCP/audit verification passed 45 tests; full web 696, contracts 136, forced type checks and repository lint passed. This closes the retry correction without checking off any remaining feature block.

### Reviewed client transfer progress

Owner/manager CSV transfer now provides UTF-8/file/record limits, selected-row previews, normalized duplicate/conflicting-contact detection, stale-review fencing, atomic idempotent import, searched private export and reversible spreadsheet protection. Spanish/English forms preserve drafts on failures and collapse the source when reviewing rows. [Operator guide and limits](client-transfer.md). This adds import/export; merging, photos and versioned forms/waivers remain open.

Four real mobile/desktop light/dark browser cases pass for CSV upload, rejected/repeated rows, explicit selection, lost post-commit response recovery, searched download and exported-file duplicate review; axe and horizontal overflow pass. Full web 699, contracts 138 and database 47 tests pass; forced type checks and repository lint pass.

## Booksy reference cross-check

The [official Spanish feature catalog](https://biz.booksy.com/es-es/funcionalidades), reviewed 2026-11-16, also identifies these single-business gaps beyond the original grouped checklist. They remain required work rather than implied parity:

- [ ] Delegated booking and management for family/friends with explicit account ownership and scoped permissions.
- [ ] Parallel-client service capacity in addition to resources, combinations and processing gaps.
- [ ] Optional home appointments with reviewed travel area/fees and protected travel time.
- [ ] Calendar import from Google/Apple-compatible feeds/files, with duplicate/conflict handling; external account activation requires its credentials.
- [x] Date-specific staff shifts and safe copying to future dates/weeks, beyond weekly hours/time-off. [Guide](date-shifts.md).
- [ ] Time-specific happy-hour and last-minute promotions, beyond existing validity windows and generic offers.
- [ ] Unlimited-visit membership terms and usage safeguards, beyond the implemented discrete prepaid visits.
- [ ] Shareable social creative for services/offers/reviews, plus moderated portfolio and booking/QR/widget entry.

The public multi-business marketplace, paid discovery/Boost and multisite remain outside the owner's confirmed current scope. External Instagram/Google booking activation, signing and bank/provider enrollment await actual accounts and approval; preparing local adapters is separate from claiming activation. This list does not claim equivalence with Booksy's network or proprietary integrations.

Full API verification after reviewed booking retries and client transfer passed **927 tests across 93 files** (0 failures). This includes the existing payment, resource, recurrence, waitlist, reward, permission and sync regressions. The broader unchecked feature blocks remain unfinished.

### Private client photo progress

Client records now provide a team-only JPEG/PNG/WebP gallery with explicit storage confirmation, normalized metadata-free pixels, scoped reads, bounded concurrent processing/storage, revision-fenced editing, retained uncertain-upload drafts and confirmed image/caption/date erasure. [Operator guide and operational limits](client-photos.md). Public portfolio publishing, native photo presentation, deduplication/merging and versioned intake forms remain unfinished.

The production API image builds and passes nine photo/image integration tests on pinned Bun 1.4.4 with a read-only filesystem. Thirty-six focused client tests passed before the final quota/error refinements. Eight real photo/CSV browser workflows pass across light/dark and mobile/desktop, with axe, overflow, uncertain-response recovery and photo revision checks. A reproduced notification overlap now has a live browser hit-target regression and measured sheet-footer handling. Full integration counts follow after the running suite completes.

Private-photo integration verification completed with **936 API, 704 web, 140 contract and 47 database tests passing**. Eight photo/CSV browser workflows and four booking-option regressions passed. Forced type checks and repository lint passed; the rebuilt production API image passed the nine photo/image cases on Bun 1.4.4, including capacity limits and confirmed erasure. Images were synthetic fixtures. No external service or real personal data was activated.

### Versioned forms and consent progress

Blank form drafts, explicit publication/archive, stable question/choice identities, eight answer types, service/variant scope, optional/required booking review and source-labelled private history are now integrated in EN/ES. Published wording and answers are immutable, and corrections append another statement. The core booking transaction protects normal visits, recurring series, held waitlist offers, MCP and offline replay; a recent human-completed response can accompany another reviewed visit within 24 hours. Live permission/publication races, changed-answer retries and immutable association ownership have regression coverage. [Operator guide and limits](intake-forms.md). No actual health/legal wording was supplied or published. Native conflict instructions are included; full native form presentation and CRM merging remain open, so the broad CRM/mobile checkboxes stay unchecked.

The full suites passed with **951 API, 712 web, 146 contract and 47 database tests** before the final channel/permission refinements. The subsequent 55-test API run passes for forms, live permission demotion, frozen associations, MCP and offline replay. Eight real customer/team browser journeys pass with uncertain-response recovery, revised-term rejection, EN/ES private history, axe and overflow checks. The production API image passed the original fifteen form integration cases on pinned Bun 1.4.4 with a read-only filesystem. Desktop/core tests pass (125 executed; four environment-dependent tests remain explicitly ignored). Final refinement checks are recorded below when complete.

Final form refinement verification: the rebuilt production image passes **20 intake/channel/permission tests** on Bun 1.4.4 with a read-only filesystem; the host's **55-test API regression** passes as well. All eight form browser workflows pass after the review-error recovery refinement. Forced type checking and repository lint pass. A further reproduced operator-close regression now asks before discarding private answers and clears them between completed booking flows; its 20 affected web tests pass. [Form operation and limits](intake-forms.md).

After the operator-close correction, the complete web suite passes **713 tests**, forced type checks and lint pass, and the rebuilt web bundle passes all four service-option/uncertain-booking browser regressions. The remaining grouped delivery items and additional Booksy single-business gaps are still open.

The shared-dialog refinement also passes all **eight photo/CSV browser regressions**. This verifies that success notices leave confirmation actions reachable and preserves the previous private-photo and transfer flows.

## Dated shift delivery

Owners/managers can review specific-date openings, closures, weekly restoration and bounded copying of effective source hours into explicit target dates. A versioned review captures source/target hours, affected appointments, offers and settings; changed reviews cannot overwrite newer work. Actor-scoped immutable batch receipts recover uncertain responses without replaying old changes over a colleague's newer schedule. Existing appointments retain their dates/status/price. Incompatible waitlist holds expire without reversing the entry/scheduling lock order, allowing other professionals to use shared resources. Availability, booking, rescheduling, recurrence, waitlist acceptance, calendar windows and scoped offline sync share the effective-date rules. The desktop replica upgrades without losing cursor or queued changes. [Operation, limits and verification](date-shifts.md).

Full verification passes with **969 API, 715 web, 149 contract and 47 database tests**. Desktop/core verification passes **127 tests**; four environment-dependent tests remain explicitly ignored. Four actual light/dark mobile/desktop Chromium workflows pass for an occupied-date review, unchanged original appointment, uncertain apply recovery, changed-source rejection, refreshed two-week copy, Spanish layout, axe and overflow checks. A reproduced long-review keyboard defect is corrected in shared panels with a live Page Down regression. Forced type checks and repository lint pass. The broad scheduling/mobile release blocks remain open for their other listed work.

Final shift refinements pass **716 web tests**, forced types and lint, plus the four shift browser workflows with a translated-active-tab visibility regression. The rebuilt API production image passes **13 shift/rule cases on Bun 1.4.4 with a read-only filesystem**. The shared keyboard/scroll changes also pass the eight intake workflows and eight photo/CSV browser regressions. These are isolated fixtures, with no external provider activation.

## Appointment review progress

Client-chosen public identities, explicit publication/treatment disclosure, completed-visit eligibility, immutable creation receipts, versioned edits, manual owner/manager moderation, reasons, public replies and content-erasing withdrawal are integrated in EN/ES. Public aggregate/service filtering cannot reveal unshared treatments; corrected outcomes stop qualifying immediately. [Operation and limits](reviews.md). Portfolio, booking/QR/widget entry and social creative remain unfinished; the grouped reputation/acquisition checkbox stays open.

The focused API suite passes eight integration cases, including SQL identity protection and moderator demotion while queued. The complete web suite passes **718 tests**, contracts **151**, and forced type checks pass. Browser and production-image verification are recorded after completion below.

All **four review browser workflows** pass with axe, overflow and Spanish withdrawal, and their mobile/desktop light/dark screenshots have been inspected. The production API image builds and passes the **eight review cases on pinned Bun 1.4.4 with a read-only filesystem**. Repository lint passes. No real reviews or external messages were created.

## Public portfolio progress

Separate private image drafts, explicit public-use permission, accessible captions/descriptions, optional frozen treatment links, reviewed publication/unpublication, revision-fenced editing and confirmed pixel/text erasure are implemented in EN/ES. Private client-gallery permissions never authorize this public gallery. [Operation and limits](portfolio.md). The five focused API cases pass, including the 200-image bound, SQL erasure protection and inactive catalog snapshots; the production image passes those same five cases on Bun 1.4.4 with a read-only filesystem. The complete web suite initially passes **719 tests**, contracts **152**, and forced types pass. Browser verification and the final action-layout refinement follow below. Acquisition links, QR/widget entry and social creative remain open.

The final **eight portfolio/review browser workflows** pass in mobile/desktop light/dark, with axe, overflow, treatment booking entry, Spanish erasure and inspected screenshots. A reproduced success-toast obstruction is corrected with portfolio actions in the measured panel footer and nonblocking notification content; dedicated DOM hit-target checks exercise both the gallery action and unpublish button while the notification is visible. The notification's close button stays interactive. All **719 web tests**, forced types and repository lint pass after this correction. Full API and shared-interface regressions are recorded after completion.

The complete API suite now passes **982 tests across 102 files**, with zero failures; database tests pass **47**, contracts **152**. All **eight photo/CSV** and **eight intake** browser regressions pass with the shared notification correction. No real reviews, photos, charges or external communications were created.

The **four dated-shift browser regressions** also pass, and the current production API image passes the combined **13 review/portfolio cases** on pinned Bun 1.4.4 with a read-only filesystem. Forced types and repository lint pass after the browser hit-target refinements.

Three further reproduced editor-lifecycle regressions now prevent late review/photo/moderation responses from closing another record opened meanwhile. The complete web suite passes **722 tests**, and forced type checking passes after the refinement. The final browser pass includes direct pointer dismissal of success notices as well as the nonblocking action checks.
