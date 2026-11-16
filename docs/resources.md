# Shared rooms and equipment

Sisters of Beauty has one salon. Professionals share rooms, treatment stations and equipment: two available professionals do not imply two available treatment rooms.

Open **Services → Rooms & equipment**. Create a resource pool, choose its type and enter the number of interchangeable units. A named room can be a pool with capacity one; two interchangeable treatment rooms can share a pool with capacity two. The type is descriptive and does not change allocation rules. There are at most 50 pools, 20 units per pool and 8 resource requirements per service.

Choose a service in the same panel and enter its required quantity for each pool. Zero removes a requirement. A quantity reserves that many units for the entire service and its cleanup buffer. Services within a visit run sequentially. A service without requirements continues to use only its professional's calendar. Customers do not need to choose a room or equipment.

Saving requirements updates all affected future booked visits and unexpired waitlist offers in the same transaction. If they cannot all fit, nothing changes and the operator keeps the draft. Visits already in progress and history keep their resource allocation. Future interchangeable units can be reassigned internally to make space; units already in use cannot move. Lowering capacity succeeds only when existing allocations still fit, and an active/future allocation prevents deactivating its pool. Reducing capacity below a service's configured quantity makes that service unavailable until its requirements or capacity are corrected.

The panel uses revisions to reject stale edits. A failed save keeps the draft. **Reload current settings** explicitly discards that draft and loads the current revision and capacities. Leaving with unsaved edits requires confirmation. New-resource retries keep the same request key for the same draft, including after an uncertain network response. Both English and Spanish and the existing light/dark themes are supported.

## Booking behavior

Availability accounts for shared resources across all professionals. Booking, recurring series, waitlist matching and moving a visit all enforce resource capacity transactionally. An expiring waitlist offer reserves resources as well as its professional. Declining, cancelling, accepting or expiring the offer releases its resource hold. Writers can release an already expired offer's resource units before the bounded worker reaches its queue entry; the expired offer still cannot be accepted.

A pending booking deposit continues to occupy capacity. Cancellation and deposit expiry release it in the same database transaction that cancels the visit. Completion and no-show preserve the recorded allocation for the visit's historical time window. Payment capture after an expired hold follows the existing reconciliation workflow and cannot restore the visit or its resource allocation.

Reprogramming uses an authenticated appointment-specific availability endpoint. It checks permission before excluding that visit from calendar/resource occupancy, and uses the durations and buffers booked originally. Changing the live catalog cannot silently extend a booked visit. The ordinary public availability endpoint cannot exclude someone else's appointment. The staff calendar detail shows allocated resource names and quantities; internal unit identifiers are not exposed to customers.

## Implementation and operation

Migrations 0023 and 0024 create pools, service requirements and owner-linked resource reservations. A deferred PostgreSQL exclusion constraint prevents overlapping active reservations for the same unit. Deferral allows an atomic move or reallocation to temporarily exchange unit numbers, while the final committed state must fit. Database triggers derive reservation windows and active state from their appointment or waitlist-offer owner, including cancellation paths outside the ordinary appointment command. Frozen offsets prevent reservations from extending outside their owner window.

One transaction-scoped scheduling coordinator serializes capacity writers for this single salon. Appointment-linked financial mutations lock their receipt first and then acquire the scheduling coordinator before value, inventory, client or appointment locks. Ordinary appointment changes follow the same receipt-first order; new appointments have no existing receipt. Resource reconfiguration holds the coordinator and locks all affected parent visits/offers before changing resource rows. It never waits for an existing receipt. See [ADR 0015](adr/0015-shared-resource-capacity.md).

No external configuration or worker credential is needed for room allocation. The normal bounded waitlist and deposit-expiry workers must still run for their respective lifecycle workflows. The feature is part of the scheduling expansion; service variants, add-ons, combinations and processing gaps remain separate work in [the delivery checklist](FEATURE-EXPANSION.md).

## Verification

Run `bun test src/modules/resources src/modules/waitlist` from `apps/api`. The fixtures use dedicated local test databases. Resource tests cover cross-professional booking races, rollback of impossible future requirements, authorization, revision/quantity fences, booked-duration rescheduling, payment coordination, calendar summaries, deposit expiry and expired waitlist offers.

Run `bun test src/features/admin/resources` from `apps/web` for component regressions. Build the web app and run `bun run e2e:resources` from that directory for the real isolated Postgres/API/browser stack. Its mobile/desktop and light/dark cases configure a pool and service requirements, race bookings, reject an impossible capacity reduction and then save it after a visit is cancelled. Axe and overflow checks run on the forms. This fixture never imports into production and never contacts a bank.

The full API baseline passed 886 tests before the additional resource lifecycle probes. Those probes reproduced and fixed active-offer reconfiguration (using immutable normalized service IDs rather than SQL inspection of driver-encoded JSON); all 17 resource tests then passed. Final web coverage is 678 tests, contracts 132, database 47, with forced type checks and repository lint passing. The four real browser cases also verify the saved requirements after closing/reopening the panel in Spanish; the stale-cache regression has a component test. These are local verification results, not approval to activate production integrations.
