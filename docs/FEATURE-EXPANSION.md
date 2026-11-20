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
- [x] Scheduling: automated waitlist and expiring offers, resources/capacity, recurring appointments, service variants/add-ons/combinations and processing gaps.
- [x] CRM: client tags, blocked/trusted clients, photos, import/export and deduplication; custom intake forms/waivers with versioned answers.
- [x] Reputation and acquisition: completed-appointment reviews, moderated public portfolio, booking links/QR/widget and separately consented local social creative with revocation. [Guide](social-creative.md).
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
- [x] Parallel-client service capacity in addition to resources, combinations and processing gaps. [Guide](processing-and-capacity.md).
- [ ] Optional home appointments with reviewed travel area/fees and protected travel time.
- [ ] Calendar import from Google/Apple-compatible feeds/files, with duplicate/conflict handling; external account activation requires its credentials.
- [x] Date-specific staff shifts and safe copying to future dates/weeks, beyond weekly hours/time-off. [Guide](date-shifts.md).
- [ ] Time-specific happy-hour and last-minute promotions, beyond existing validity windows and generic offers.
- [ ] Unlimited-visit membership terms and usage safeguards, beyond the implemented discrete prepaid visits.
- [x] Shareable social creative for services/offers/reviews, plus moderated portfolio and booking/QR/widget entry. [Guide](social-creative.md).

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

## Booking entry progress

The owner/manager composer now generates selected-treatment/professional links, local QR PNGs, clipboard/native share entry and escaped widget snippets. Public widgets read only the catalog, omit authenticated session bootstrap, carry explicit content language and open booking in a separate first-party tab. External embedding stays off until exact parent origins are configured; other pages, API and error responses retain their framing protection. Stale QR responses and removed-professional choices have runnable regressions. [Operation, configuration and limits](booking-entry.md). No actual domain or social account was configured. Social creative and its separate permissions remain open.

The first four real mobile/desktop light/dark workflows pass with independent PNG decoding, approved/denied cross-origin framing, private-session exclusion, booking popup, clipboard, Spanish, axe and overflow checks. All **26 script tests** pass, including database backup/restore. The subsequent stale-selection refinement is being verified before the final counts are recorded.

After the stale-selection refinement, all **733 web tests** pass, and the four entry workflows pass again on the host build. The web production image builds with frozen dependencies on Bun 1.4.4 and passes the same four browser workflows with a read-only filesystem. A reproduced custom-port healthcheck error now has coverage for configured ports and IPv6; the production browser cases assert actual Docker health. A dedicated owner-labelled wrapper is verifying fixture teardown, since killing only the foreground Docker CLI left its container running.

The final **four production-image entry workflows pass**, including actual healthy-container assertions, and the labelled fixture container is confirmed absent after automatic teardown. No deployment or external activation occurred. The broad reputation/acquisition checkbox remains open for the separate social-creative workflow and consent.

Final entry verification also passes forced type checks, repository lint and **26 script tests** after the runtime-wrapper and health-probe refinements. The current complete web suite is **733 passing tests**. API/database/contracts remain at the preceding **982/47/152** verified baseline; this entry block changes no API/database contract or financial behavior.

## Consented social creative delivery

The single-salon owner/manager composer exports branded treatment, service-offer and separately consented review artwork with local QR generation, bundled fonts, complete text captions, three formats and three palettes. Offer conditions never truncate; an unreadable fit requires a larger format. New review permission is optional, unchecked and independent of website publication; clients can revoke it while keeping the website review. Each preview and export rechecks current terms and permission with HTTP cache bypass. Changed prices/revisions and withdrawn permission stop export while preserving selections. [Operation and limits](social-creative.md).

Verification passes **742 web, 153 contract and 47 database tests**, plus the **17 review/portfolio API cases** on the pinned Bun 1.4.4 production image with a read-only filesystem. All **four host and four production-image browser workflows** pass, with independently decoded PNG QR codes, exact dimensions, full offer terms, fit recovery, current-price rejection, client opt-in/moderation and Spanish revocation while preserving website publication, axe and overflow checks. Exported fixture images have been visually inspected. The production browser container is confirmed removed after teardown. Forced types and repository lint passed before the subsequent scheduling work. The complete API rerun is still in progress; no full API result is claimed here. No social account, real feedback or external publication was used.

The social-creative complete API rerun passes **986 tests across 102 files**, with zero failures. The next scheduling-combination work has its own separate verification below.

## Curated treatment combinations

Owners/managers can create, version-edit and archive ordered selections of existing treatments, variants and eligible extras. The public booking step shows current totals and replaces the selection on an explicit choice. Members must share a currency and a qualified professional; unavailable sources withdraw the shortcut without altering booked snapshots. Concurrent create retries preserve one actor-scoped original submission; stale edits preserve drafts, and unknown responses retain their exact packet. The bounded directory includes archives and supports reusing an existing entry. [Operation and limits](treatment-combinations.md). Processing gaps and parallel-professional capacity remain open, so the grouped scheduling block is still unchecked.

Verification passes **744 web, 154 contract and 47 database tests**, forced types and lint. The focused service/catalog API regression passes **20 cases**; the production API image passes **16 combination/variant/extra cases** on pinned Bun 1.4.4 with a read-only filesystem. All **four host and four final production-image browser journeys** pass for uncertain creation, conflicting edits, ordered booking, unchanged booked prices after archive, Spanish, long names, axe and overflow. A reproduced label/content mismatch was fixed and the four production workflows pass again; their fixture container is confirmed removed after teardown. Existing variant/extra browser regressions are running separately. The last complete API baseline is the preceding **986 tests**, before these seven new combination cases; no new complete-suite count is inferred.

The **four existing variant/extra browser regressions also pass** after the combination and button-accessibility changes, including changed-price rejection and uncertain booking recovery.

## Processing and concurrent-professional delivery

Owners/managers explicitly configure a treatment’s hands-off middle interval and each professional’s concurrent active-work limit (default one, maximum six). New appointments and waitlist offers freeze their work plans; later catalog changes and rescheduling preserve those reviewed intervals. Physical rooms/equipment retain full-window occupancy. Reduced capacity cannot displace booked visits or held offers. Versioned EN/ES editors preserve drafts and freeze uncertain submissions. The calendar and desktop expose saved timing, and desktop proposals retain reviewed prices, quote hashes and timing across later syncs. Rejected terms require a fresh proposal. [Operation, migration and limits](processing-and-capacity.md), [decision](adr/0016-professional-work-capacity.md).

The complete API suite passes **1,007 tests across 105 files**, including concurrent capacity, direct SQL constraints/lock waits, frozen processing, rooms and waitlist transfer. Complete suites pass **749 web, 157 contract, 47 database and 27 script tests**; the contention proof now checks active work rather than full client-span overlaps. Desktop/core passes **131 executed tests**, with four environment-dependent cases explicitly ignored; formatting and Clippy pass. Forced types and repository lint pass. The read-only production API image passes **14 processing/work-window cases** on pinned Bun 1.4.4. All **four host and four production-image light/dark mobile/desktop browser workflows** pass for processing configuration, uncertain save recovery, booking another client during exposure, saved calendar annotation after source edits, rejected capacity reduction, cancellation/reduction recovery, Spanish, axe and overflow. The production web container was healthy during execution and absent after teardown. Existing scheduling browser regressions are recorded below after completion. No external provider was activated.

The **four existing variant/extra and four dated-shift browser regressions also pass** after the processing/capacity changes, including uncertain booking recovery, source-review fencing, keyboard access, Spanish, axe and overflow.

## Timed promotion progress

Optional salon-local weekday/start windows and original-booking lead limits now qualify service-appointment discounts. Review/application binds the promotion revision, receipts freeze timing and timezone, and moves must satisfy the original terms even after the source offer changes. EN/ES editor, receipt review/history and local social captions disclose the conditions. Uncertain editor writes freeze their original packet. [Operation, migration and current limits](timed-promotions.md).

Focused verification passes **58 reward/deposit/capacity API cases**, including seven timed-offer cases and four pure timezone/lead cases. Complete web verification passes **753 tests**, contracts **160**; forced types and lint pass. All **four host light/dark mobile/desktop browser workflows** pass, including a reproduced touch-target correction, uncertain save recovery, same-penny changed-revision rejection, fresh review/application, rejected move, saved conditions and Spanish/axe/overflow. The read-only production API image passes **11 timed-offer/clock cases on pinned Bun 1.4.4**, using a separate production-test database. Production browser and full API results follow after completion.

The Booksy timed-offer checkbox remains open for **promotion selection during the initial booking review and discounted deposit calculation**, plus availability presentation. The current explicit unpaid-receipt workflow is usable and does not claim that missing booking integration.

Timed-offer verification finishes with **1,018 API tests across 107 files, zero failures**, **47 database and 27 script tests**, including backup/restore, and forced types/lint. All **four production-image timed-offer browser workflows** pass; their container is absent after teardown. The **four existing loyalty/coupon browser regressions also pass**. Saved Spanish receipt captures have been visually inspected. This complete API result precedes the separate initial-booking promotion work and its new tests.

## Initial-booking promotion progress

Customers can now review a code against their own current service/staff/time selection before confirming. The appointment, discounted receipt, coupon claim and net deposit are atomic; changed/exhausted offers preserve the selection and require review or explicit removal. The confirmation and customer appointment card show the agreed service total and separate discount. Original service snapshots remain unchanged. Unknown booking responses freeze their original packet, retain it through later authentication errors and recover the same visit/receipt after source archive. [Operation, limits and recovery](booking-promotions.md).

The focused new API suite passes **11 cases**, including final-use concurrency, protected/free/nonprotected visits, non-stacking membership savings, cancellation and original-payment refund. An additional reproduced premature-fulfillment case is corrected for free online visits without deposits. Complete web verification passes **756 tests**; forced types and lint pass after correcting the EUR output narrowing. All **four host light/dark mobile/desktop booking workflows** pass with changed-offer rejection, renewed net-deposit consent, unknown/401 recovery, navigation guarding, original identity, discounted confirmation, Spanish, axe and overflow. Production-image and complete API results follow when finished. Discounted availability presentation remains open.

The **four production-image initial-booking workflows pass**, and their fixture container is confirmed removed after teardown. The API production image passes all **11 initial-booking promotion cases** on pinned Bun 1.4.4 with a read-only filesystem and separate test database. The **four existing variant/extra booking regressions pass** after updating their old generic-error expectation to the explicit uncertain-request state and checking frozen notes. The complete API rerun remains separate and in progress.

The initial-booking complete API rerun passes **1,029 tests across 108 files**, zero failures. This includes the original financial, scheduling, permission, MCP and sync suites plus the eleven new booking-promotion cases. Complete contracts remain **160**, web **756**. A final long-name browser layout refinement is tracked separately before this delivery is closed.

Final booking-layout refinement passes all **four host and four rebuilt production-image workflows** with an unbroken long offer name. A reproduced mobile overflow that obstructed policy consent is corrected with bounded fieldsets and wrapped offer headings; the actual consent click, axe and horizontal-overflow checks pass. The production container is absent after teardown. Forced types/lint and **27 script tests** pass, including backup/restore and offline release metadata. Form-booking regressions are being checked separately before the next functional block.

All **eight existing intake-form browser regressions also pass** after the booking packet/fieldset changes, including original private-answer recovery, changed wording and paper-response history. Offline release validation succeeds without inventing an image registry or publishing anything. No external provider was enabled. The separate CRM identity-link design remains proposed, not implemented by this delivery.

## Reviewed duplicate client identities

Owner/manager duplicate suggestions, explicit source/survivor review, fresh contact/control fences, immutable actor-key receipts and EN/ES recovery are now integrated. Original visits, financial lots, paid gifts/passes, private images, intake statements and review permissions keep their ids. The surviving account receives scoped group history/value without granting new consent or resetting coupon limits. Historical contacts find one survivor in directory/CSV review. Old profiles retain labelled notes and show their survivor; stale new proposals are rejected through REST, MCP and sync. Desktop pickers exclude aliases while preserving queued requests and the replica cursor. Existing waitlist subjects require a new review. [Operation and limits](client-merging.md), [decision](adr/0017-client-identity-links.md).

The complete API suite passes **1,049 tests across 110 files**, including twenty new identity/group-value, raw SQL, queued booking, opposite-link and inventory-lock-order cases. The read-only production API image passes all **20 new cases** on pinned Bun 1.4.4. Complete suites pass **761 web, 160 contract, 47 database and 27 script tests**, including backup/restore. Desktop passes **132 executed tests**, with four environment-dependent cases explicitly ignored; Clippy and formatting pass. Forced types and lint pass. Four host and four production-image mobile/desktop light/dark browser workflows pass, including stale contacts, lost response/401 recovery, original visit ids, Spanish, axe and a reproduced long-name overflow fix. The eight existing private-photo/CSV workflows pass. Final intake regression and fixture cleanup are recorded after completion below. No provider was enabled and no real client was merged. The overall expansion still has open marketing/mobile and additional single-business features.

Final CRM verification also passes all **eight intake-form browser regressions** after the historical-profile editor changes. The final production merge workflows pass after adding the separate-tab sign-in recovery link, and their labelled fixture container is absent after teardown. The local user preview at port 4280 now runs the verified images with its existing synthetic data preserved; owner sign-in and the new review entry were exercised in Chromium. No external deployment occurred.

## Catalogue and complete-visit delivery — 2026-11-17

Categories/search/order, online visibility, preparation instructions, service-specific start intervals, contextual variant/extra creation, inline atomic processing, the five Booksy price types and safe final-price checkout are implemented. Multi-professional visits reserve the whole ordered itinerary atomically and recover actor-bound retries; later payments and management remain per appointment. [Operator behaviour, verification and explicit remaining parity](service-substitution.md). Existing historical progress entries above describe their original delivery dates and are not a declaration that the entire grouped scheduling scope is closed.
