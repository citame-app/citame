# Service catalogue and complete visits

Sisters of Beauty currently has one business and one salon. The reference is Booksy's Spanish service behaviour. This delivery extends the existing Citame catalogue, booking and checkout; it does not declare complete Booksy parity or certify a production deployment.

## Catalogue and editor

The team can organise services with categories and display order, search/filter them, hide them from online booking, set preparation instructions and choose each service's start interval (or inherit the salon interval). Internal services remain available to authorised calendar operators. Customer-created bookings and waitlist offers enforce online visibility on the server, including a hidden parent of a variant.

The editor creates variants and eligible extras from their parent, shows related options and inherits category, currency, performers, preparation instructions, visibility and interval where appropriate. Variants retain their own duration and price. Extras stay with a compatible treatment and qualified professional. Selected services survive category/search changes; incompatible choices explain why they cannot be selected. Mixed currencies are rejected by both the UI and server.

Catalog, Combinations and Processing time are URL-addressable tabs. Duration and processing are saved atomically with configuration and performer changes under the existing catalogue revision fence. The bulk processing tab remains available. Existing resource, capacity and booked-snapshot protections still apply.

## The five price types

| Type | Customer experience | Checkout |
| --- | --- | --- |
| Fixed | Advertised exact amount | Ordinary frozen charge |
| Variable | “Price varies”; no invented zero price | Team must set the final amount |
| Hidden | Amount concealed in discovery; disclosed before confirmation | Ordinary frozen charge |
| Free | Explicitly free | No service charge |
| From | Advertised minimum, with an explanation of final pricing | Team sets a final amount at least equal to that minimum |

Variable and from bookings require explicit customer acceptance of the displayed pricing terms. Acceptance resets when the reviewed selection/quote changes. This follows the requested Booksy model; it does not impose a separate pre-booking quotation workflow. The API, MCP and waitlist acceptance enforce the same condition, so older callers cannot treat an unresolved price as a free fixed booking.

Unresolved receipts cannot collect their balance, consume a prepaid visit, apply a promotion or fulfil a zero-value sale. In **Sales & register → Receipt**, the authorised team reviews every pending line and selects **Set final prices**, then collects the resulting balance normally. An unknown amount starts blank in this form. Fixed lines cannot be repriced. Finalisation checks the current actor, receipt revision, advertised minima and outstanding bank operations, recalculates tax/benefits, audits the change and keeps the original appointment snapshots intact.

A variable service can use a disclosed fixed deposit; a percentage alone cannot establish a deposit on an unknown amount. The customer must accept that exact deposit amount. The deposit is credited to the final balance. Service fulfilment and commissions wait for the final amount. Provider calls remain behind the existing configured gateway; the local preview has payments disabled. No real Redsys terminal or bank charge was activated by this work.

## Complete visits with several professionals

Customers can select one common professional or qualified professionals per treatment family. Availability finds a complete sequential itinerary, including resources, cleanup and the normal scheduling rules. The first treatment follows its public start interval; later hand-offs can start between those grid slots.

`POST /appointments/visits` creates 2–8 ordered treatment parts, up to 24 distinct service/extra IDs, in a single transaction. A conflict in a later part rolls back the entire reservation. Calendar locks are ordered, ownership is checked, and the identifier binds the actor and original reviewed request. A lost response and later authentication failure retain the same packet for safe retry. The authenticated confirmation URL survives reloads.

Each part has its own appointment, receipt, deposit and subsequent cancellation/rescheduling lifecycle. This is disclosed before confirmation and on the result page. Post-booking cancellation and rescheduling remain per appointment.

The staff commerce API can prepare the receipts for a complete visit through
`POST /admin/commerce/visits/:appointmentId/checkouts`. It accepts an appointment from a native
itinerary or a group preserved during import. The operation reuses existing receipts, keeps the
professional and service amounts for each part, and prepares new receipts in one transaction.
Cancelled parts and externally settled parts remain visible with their existing receipt if one
exists. An unresolved imported charge requires review before the visit can be prepared. Accounts
need access to every calendar and receipt in the group.
As in individual checkout, preparing a zero-total receipt with final prices settles it for zero.

The prepared visit includes a payment review if it has an amount payable now and every open
receipt can be reviewed. Complete outstanding price reviews and reconcile pending bank payments
before recording the visit payment. Staff can submit
its token and an idempotency key to `POST /admin/commerce/visits/:appointmentId/payments` to record
cash or a card payment already taken on an external terminal. The command validates the current
visit and receipts, creates one allocation per payable receipt, and commits the group in one
transaction. A lost response can replay the same command from any appointment in the visit.
Existing refunds continue to apply to the individual payments. In the Web calendar, open a
grouped appointment and choose **Review visit payment**. The details show each professional,
service and amount, with access to open receipts. An uncertain request can be retried from
another appointment in the same group on the same browser tab and account. Desktop offers the
same review in the appointment details. An uncertain Desktop payment can be retried after
restart or from another part of the visit under the same account and server profile.
An aggregate hosted card or Bizum payment remains pending.

Web saves the retry details before sending a new payment. If the browser blocks site storage,
no payment is submitted. A local browser run with synthetic records verified a committed
payment followed by a lost response, a retry from the other appointment, and access to its
two receipts from the confirmation on mobile.

Desktop saves the original command in SQLite before its first submission and requires an
explicit retry. It checks the acknowledgement against the receipt IDs and amounts returned by
the server review. A synthetic API run verified the client recovered a committed payment after
a lost response by reopening SQLite and retrying from another appointment. The live review and
receipt display require connectivity.

## Verification — 2026-11-17

Development used Bun and Playwright TDD, as authorised for this web project. New price, catalogue, visit and footer regressions were observed failing before their corrections. Deterministic browser locators and response/state waits cover the real explored interactions.

- Full API: **1,065 passed**, 112 files.
- Full web: **777 passed**, 143 files.
- Contracts: **162 passed**, 32 files. Database: **47 passed**, 8 files.
- Forced TypeScript and repository Biome checks: four workspaces passed each.
- Pinned Bun 1.4.4 production API image: **62 changed-path API tests passed** under read-only/capability-restricted execution.
- Production web image: **16 service workflows passed** across mobile/desktop and light/dark, covering variable/from finalisation, contextual variants/extras, catalogue filters, complete visits, lost post-commit responses, 401 recovery, reload, axe and horizontal overflow. The final 16-case run includes the mobile footer-clearance regression and the hovered primary-action contrast check.
- Existing production-web regressions: **4 processing/capacity and 4 combination workflows passed**.
- Preview smoke checks: five widths (320, 390, 768, 1024, 1440), both themes, Spanish catalogue, owner login and editor. No page errors or horizontal overflow. Hover and held-press primary-button states passed axe AA. A missing shared motion colour was corrected in application tokens; copied kit files were not changed.

Fixtures are synthetic and isolated from the user's preview database. Payment records in browser tests use the synthetic external-card bookkeeping method; they are not bank charges. Chromium responsive testing does not certify physical Android devices or Safari/iOS.

## Preview and migration

The local preview is at <http://localhost:4280/book>; team editing is at <http://localhost:4280/admin/services>. Its existing database was backed up before additive migrations and the two runtime images were updated. Counts remained **2 users, 1 client, 6 services, 0 appointments**. No test reservations or test services were inserted into this preview. Real provider activation, domain, hosting and business-specific content still require the actual supplied configuration.

Migrations 0041–0044 add catalogue presentation fields, visit grouping, price types/pending receipt pricing and service start intervals. Legacy defaults retain fixed prices, online visibility, no category/preparation text and the salon's start grid. No production credentials, remote repository or domain were fabricated.

## Design-check status

**GATE: ERROR (third invocation incomplete)**. The last complete pass was GATE: FAIL 33 (round 2 of 3). Its footer collision is fixed and verified; remaining findings, applied waivers, warnings and unverified areas are retained in [the full design-check report](service-substitution/design-check.md). No kit file or checker was edited and no new waiver was added. This is not a visual-gate PASS.

## Remaining parity and design limits

Advanced per-service controls still outside this delivery include leading padding before a treatment, service-card photograph/calendar-colour editing and home visits with manual approval/travel rules. Multi-business discovery and multisite remain outside the owner's current single-salon scope. Grouped payment availability and later management are described above. Broader product work is tracked in [the expansion checklist](FEATURE-EXPANSION.md).

The design skill's marketing-page gate has open composition findings on the application form (hero photograph/CTA, screen-sized sections, decorative moment, catalogue-column alignment and transparent native-input focus detection). These must not be represented as a design PASS. Actual browser checks verify visible focus via the associated labels, meaningful application layout, contrast and reachable controls. The previous home-page gate and JavaScript performance-budget finding remain documented in [the redesign report](ui-redesign/verification.md). Gate output for this route will be recorded after final checking.

Reference voice and visual system: clear EN/ES service language; existing warm ivory/rose palette, local Lora/Nunito Sans, responsive catalogue and fixed/sticky summary. No new synthetic salon photographs, location details, reviews, domain or prices were invented. Existing AI editorial stand-ins and pending client materials are identified in the redesign report.

## Reproduce

From the repository root:

```sh
bun run --cwd apps/api test
bun run --cwd apps/web test
bun run --cwd packages/contracts test
bun run --cwd packages/db test
bunx turbo run typecheck lint --force
docker build -f docker/api.Dockerfile -t sob-api:service-substitution .
docker build -f docker/web.Dockerfile -t sob-web:citame-e2e .
E2E_WEB_IMAGE=true bun run --cwd apps/web e2e:options
E2E_WEB_IMAGE=true bun run --cwd apps/web e2e:processing
E2E_WEB_IMAGE=true bun run --cwd apps/web e2e:combinations
```

Official Booksy sources reviewed for this behaviour:

- [Service setup and price types](https://support.booksy.com/hc/es-es/articles/20706548191378).
- [Service booking settings](https://support.booksy.com/hc/es-es/articles/21028092250258).
- [Categories](https://support.booksy.com/hc/es-es/articles/16538281912850).
- [Staff pricing and variants](https://support.booksy.com/hc/es-es/articles/16538342476946).
- [Checkout](https://support.booksy.com/hc/es-es/articles/16465470458642).
