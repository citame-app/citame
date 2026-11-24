# Sync protocol specification

Audience: implementers of the desktop client (Phase 5). Rationale and trade-offs: [ADR 0007](adr/0007-sync-protocol.md). The machine-readable definition is `packages/contracts/src/sync.ts` (zod); this document is the contract in prose plus examples.

All endpoints live on the API origin and require either a Better Auth session cookie or a first-party desktop OAuth bearer token for the Citame desktop audience and are available to roles `owner` and `staff`. Anonymous calls get `401`, the `client` role gets `403`. All bodies are JSON (UTF-8), all timestamps ISO 8601 with offset, all ids UUIDs. Errors use the usual envelope `{ "error": { "code", "message" } }`.

## Concepts

| Term      | Meaning                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `seq`     | Monotonic integer position in the server's change log. Not contiguous (gaps happen).                                          |
| cursor    | The last `seq` a client has fully applied. Persist it in local SQLite together with the data it describes (same transaction). |
| outbox    | Local queue of mutations awaiting send or reconciliation. Each has a UUIDv7 `mutationId` generated once, when the user acts. |
| tombstone | A change with `op: "delete"`: remove the local row.                                                                           |

Guarantee: if you have seen `seq = n`, you have seen every change that will ever commit with a seq below `n`. Your cursor is always safe to resume from.

## Client algorithm

1. **Write locally first.** Apply the user's action to local SQLite, append a mutation to the outbox, show the row as "pending sync".
2. **Push** the outbox head (up to 100 mutations, in creation order) with `POST /sync/push`. Keep one request in flight. Wait for an applied receipt before sending another edit that depends on it for the same appointment.
3. On `applied`, remove the mutation from the send queue. Desktop persists the receipt cursor and keeps the calendar projection for an accepted appointment, its new client or a time block until the ordered pull reaches that cursor. On `rejected`, move the mutation and any dependent appointment edits to the conflict inbox for review. On `retry`, keep the mutation and its dependents in the send queue for backoff.
4. **Pull** with `GET /sync/pull?since=<cursor>`; apply the changes and store `nextCursor` in the same local transaction; repeat immediately while `hasMore` is true.
5. Keep `GET /sync/stream` open; on every `change` event, pull. Also pull on startup, on reconnect, and every 60 s as a safety net.

Order of work when coming online: push first, then pull (pull then shows the effect of your own mutations and of everyone else's).

Every pull page returns `generation`. Send the generation of the local mirror with every push. Normal upgrades keep the generation stable. Activating a restored database changes the generation across all API replicas. The server rejects a mismatched push with `409 sync_generation_changed` before executing any member of the batch. A missing generation identifies the original `initial` history for older clients.

When a pull reports a different generation, the desktop atomically moves queued mutations to local Conflicts, resets the mirror and cursor, and stores the new generation. It rebuilds from zero even if the old cursor is still below the new head. The rebuild state survives restart and the client waits for the final page before accepting edits. Previously open conflicts also require manual review. Upgrade older desktops before reconnecting them. The pull endpoint stays available, but older apps with pending changes may stop before reaching it when their push is rejected.

Show the local version while a calendar edit waits for its receipt. After acknowledgement, prefer the canonical row as soon as its version includes or supersedes the edit. Retire the confirmed projection and its receipt together when the pull cursor catches up or when the pull returns a tombstone for that entity. Use the current calendar scope to decide which effective appointments and time blocks to display. This preserves the calendar across a restart or network failure between push and pull.

An acknowledged time block remains visible and blocks booking. Editing it again requires the authoritative block revision, because the server can adjust the device's edit timestamp. The display name of a newly booked client stays on the local appointment even if the client directory is no longer available to that account.

Clients that understand the `unknown_booksy_payment` appointment billing hold request
`booksyPaymentReview=1` on pull. Clients using the original reason set receive an
`unknown_amount` hold, so collection stays disabled across upgrades. A payment review
changes the appointment version and republishes the row. Evidence references stay in the
server audit trail.

The response includes the current `clientDirectory` permission and `calendarScope` even when the cursor is already at the log head. `calendarScope` is `all`, `none`, or a staff ID. When either scope changes, the native client clears its previous mirror and cached views before pulling a new snapshot from zero. It keeps its outbox and conflict records. Older servers can omit these fields.

`viewerEditCalendar` carries the current calendar edit permission, including on empty pulls. Desktop saves this decision and uses it separately from `calendarScope`, which controls visible appointments. Desktop checks permission and calendar scope when preparing or confirming an online booking and when queuing creation, rescheduling, cancellation, or an attendance outcome. Older servers can omit the permission. Desktop keeps the last explicit value when available and otherwise recognizes restricted personal calendars through `timeOffScope: "none"`. Cloud rechecks authorization during replay.

`viewerRole` carries the current staff or owner role. A desktop profile with a different saved role returns to sign-in so it can open the replica for the new role. It keeps the previous profile’s pending edits. A server response denying sync also returns the app to sign-in. A network outage keeps the offline profile open.

Linked Desktop devices load team photo metadata at `GET /admin/staff/portrait-directory`. Reads and uploads use `/admin/staff/:id/portrait`, and publication uses `/admin/staff/:id/portrait/publication`. The same-origin gateway forwards those paths to the authenticated API. The directory uses the staff permissions of the browser API, and `/admin/staff` remains the browser page on Cloud.

Desktop reads the booking protection status and applicable deadlines from the private appointment context at `GET /appointments/:id/context`. The context includes deposit, fee and refund amounts only for callers with commerce access. The existing checkout ID also requires access to that specific sale. Desktop opens that receipt with a read request and verifies that it belongs to the selected appointment. Amounts and checkout links stay in the open appointment detail. The sync response advertises `appointmentDepositStatus` and includes `depositStatus` with the state, deadlines and attendance restriction. A null status indicates an unprotected appointment. Desktop stores the operational status in the calendar replica and enriches existing rows at the same appointment version with a separate backfill cursor. That pass leaves the main cursor, notices and outbox intact. Desktop hides attendance actions when a loaded deposit state requires payment or prohibits a change. The API enforces booking protection on every submitted status transition.

## Reviewed recurring bookings

Reviewed desktop series use `POST /appointments/desktop-series/preview` and
`POST /appointments/desktop-series` through the authenticated gateway. These are online
operations. Both calls carry the current desktop generation, service quotes and intake review
hash. The commit adds the series review hash, its idempotency key and one client-generated
appointment ID per date. SQLite records the IDs against the same generation before dispatch.
The server commits the complete series together. Each appointment then arrives in the ordinary
pull feed. The originating device suppresses its own incoming-booking notices. Private intake
answers stay in the open review and do not enter the outbox.

## POST /sync/push

Request:

```json
{
  "deviceId": "front-desk-1",
  "generation": "initial",
  "mutations": [
    {
      "mutationId": "01a1d81f-2231-75bd-ba65-bc41f42803e9",
      "createdAt": "2026-03-09T11:58:03.120Z",
      "kind": "appointment.create",
      "payload": {
        "id": "01a1d81f-2232-7c10-8a11-0e5d6a0b9f10",
        "staffId": "01a1d81e-0000-7000-8000-000000000001",
        "serviceIds": ["01a1d81e-0000-7000-8000-0000000000a1"],
        "startsAt": "2026-03-09T12:00:00.000Z",
        "clientId": "01a1d81e-0000-7000-8000-0000000000c1",
        "notes": "first visit",
        "override": false
      }
    }
  ]
}
```

- `deviceId`: stable per installation, 1 to 100 chars (diagnostics only).
- `mutations`: 1 to 100 items, applied strictly in array order.
- `mutationId`: UUIDv7, generated once per mutation and reused on every resend.
- `createdAt`: when the user made the edit (device clock). Used by last-writer-wins kinds; ignored by appointment kinds.
- `client.update` can carry `payload.expectedUpdatedAt`, the revision the operator reviewed. The API compares it under the contact row lock. A stale edit becomes a sync conflict even if it was submitted with a later device clock.
- `time_off.update` and `time_off.delete` can carry `payload.expectedUpdatedAt`, the block revision the device displayed. The API checks it under the same calendar lock as web schedule edits and returns `version_conflict` for a stale revision. The field is optional for existing API clients.

Response `200`:

```json
{
  "results": [
    {
      "mutationId": "01a1d81f-2231-75bd-ba65-bc41f42803e9",
      "status": "applied",
      "appliedSeq": 412,
      "replayed": false
    },
    {
      "mutationId": "01a1d81f-3000-7000-8000-000000000002",
      "status": "rejected",
      "reason": "slot_taken",
      "message": "The selected time slot is no longer available",
      "replayed": false
    },
    {
      "mutationId": "01a1d81f-3000-7000-8000-000000000003",
      "status": "retry",
      "message": "Temporary server error; resend with backoff"
    }
  ],
  "headSeq": 415
}
```

One result per mutation, in request order. `appliedSeq` is the last log seq the mutation wrote (null if it changed nothing); once your cursor reaches it, your pull has seen the mutation's effect. `replayed: true` means the server already had a result for this `mutationId` and returned it unchanged.

For clients that send several edits to the same appointment in one batch, the server responds with `conflict` for later edits based on a higher version than a rejected edit in that batch. Upgrade Desktop clients before moving live appointment editing to Citame so their local outboxes also protect edits across requests.

Free text is capped (the same limits as the REST API, counted in UTF-16 code units, so an emoji counts as two): names (client `name`, inline client `name`, staff `displayName`) 200, `phone` 32, `email` 254, `notes` 2000, time-off `reason` 500. A longer value makes the mutation `invalid`. The whole request body is capped at 1 MiB (`HTTP_MAX_BODY_BYTES`): bigger bodies are answered `413`.

A malformed envelope (no `deviceId`, empty or more than 100 mutations, an element without a UUIDv7 `mutationId`) fails the whole request with `400 validation_error`. A malformed individual mutation (unknown `kind`, bad payload) is `rejected` with reason `invalid`.

### Mutation kinds

| `kind`                   | `payload`                                                                                                                                                   | Who                          | Conflict model       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------- |
| `appointment.create`     | `id` (required, client-assigned), `staffId`, `serviceIds[]`, `startsAt`, exactly one of `clientId` / `client {name, phone?, email?}`, `notes?`, `override?` | owner; staff on own calendar | server-authoritative |
| `appointment.reschedule` | `id`, `version`, `startsAt?`, `staffId?` (at least one), `notes?`, `override?`                                                                              | same                         | server-authoritative |
| `appointment.cancel`     | `id`, `version`                                                                                                                                             | same                         | server-authoritative |
| `appointment.set_status` | `id`, `version`, `status` (`completed` or `no_show`), `notes?`                                                                                              | owner or writable calendar staff for initial outcomes, all-calendar editors for corrections | server-authoritative |
| `client.create`          | `id`, `name`, `phone?`, `email?`, `notes?`                                                                                                                  | owner, staff                 | LWW                  |
| `client.update`          | `id`, any of `name`, `phone` (nullable), `notes` (nullable), or `emailChange: { email, expectedUpdatedAt }`, optional top-level `expectedUpdatedAt`                                                                      | users with client access     | revision or LWW                  |
| `time_off.create`        | `id`, `staffId`, `startsAt`, `endsAt`, `reason?`                                                                                                            | owner; staff for self        | LWW                  |
| `time_off.update`        | `id`, `staffId`, any of `startsAt`, `endsAt`, `reason`                                                                                                      | same                         | LWW                  |
| `time_off.delete`        | `id`, `staffId`                                                                                                                                             | same                         | LWW                  |
| `service.update`         | `id`, any catalog field or `active`                                                                                                                         | owner                        | LWW                  |
| `service.configure`      | `id`, exact reviewed `version`, and at least one of a partial `service` update, an `assignment` with reviewed and proposed staff IDs, or a reviewed `catalog` update. The parts commit together. The device keeps the original values for conflict review. | owner or catalog manager | exact revision and reviewed team, idempotent |
| `service.resources`      | `id`, exact resource `version`, `selectionMode` and the complete set of resource requirements and quantities. A reviewed snapshot is available from `GET /admin/services/:id/resources/reviewed`. | owner or catalog manager | exact revision, validates affected future allocations, idempotent |
| `resource.create`         | Client-generated `id`, `name`, `kind` and `capacity`. New pools start active. | owner or catalog manager | idempotent |
| `resource.update`         | `id`, exact pool `version`, `name`, `kind`, `capacity` and `active`. | owner or catalog manager | exact revision, validates future allocations, idempotent |
| `combination.create`      | Client-generated `id`, `name`, nullable `description`, ordered `serviceIds` and `active`. | owner or catalog manager | validates live catalogue and team, idempotent |
| `combination.update`      | Same fields as creation plus the exact reviewed `version`. An unchanged selection can be archived even when some of its services are no longer eligible. | owner or catalog manager | exact revision, idempotent |
| `product.create`          | Client-generated `id` and the inventory creation fields, including opening stock. The mutation ID is the creation idempotency key. | inventory writers | idempotent product and opening movement |
| `product.update`          | `id` and `changes` with the exact reviewed `version` and the altered catalogue fields. The stock ledger stays authoritative. An optional `classification` contains nullable category, subcategory and brand IDs from the managed catalogue. Clients may continue sending the original text labels. | inventory writers | exact revision, idempotent |
| `portfolio.upload` | `idempotencyKey`, active `serviceId`, `caption`, `alt` and bounded `imageBase64`. Writes a private draft and emits the portfolio refresh marker. | owner or catalog manager | idempotent across retries and reviewed restore replay |
| `product.photo`           | `id`, reviewed photo `version` (or null for no photo), and bounded `imageBase64` (or null to remove it). The private binary uses a separate authenticated endpoint. | inventory writers | exact photo version, idempotent |
| `inventory.brand_logo` | Brand `id`, the reviewed logo `version` (null before the first edit), and bounded `imageBase64` (null to remove). Removal preserves a new revision. The commerce refresh invalidates the classification list and the authenticated image URL. | inventory writers | exact logo version, idempotent via mutation ID |
| `supplier.save`          | Supplier `id`, fields, active status and reviewed `version` (zero for creation). | inventory writers | exact version, idempotent |
| `purchase_order.write` | Order `id`, reviewed `version` (zero for creation) and `action` of `save`, `order`, or `cancel`. Save includes supplier, expected date, notes and requested quantities. The commerce marker acknowledges the mutation. | inventory writers | exact order version, idempotent |
| `stock.receipt`          | A receipt `id`, author, delivery date, optional supplier and invoice reference, and all reviewed product versions and quantities. An optional `purchaseOrder: {id, version}` binds the delivery to its reviewed order and supplier. An optional `warehouseId` routes receipt stock to an active secondary warehouse. Existing payloads without it still receive stock in the main warehouse. The server uses the receipt ID as the business idempotency key. | inventory writers | exact product versions, all lines atomic, idempotent |
| `inventory.classification_save` | Classification `id`, `kind`, `name`, nullable `parentId`, `position`, `active` and reviewed `version` (zero for creation). The parent must be a top-level category. | inventory writers | exact version, idempotent; writes emit a commerce refresh |
| `inventory.classification_reorder` | Group `kind`, nullable `parentId`, full ordered sibling `entries` with IDs and reviewed versions, and the Desktop move's `source`, `anchor` and `after` flag for conflict review. The order is committed together and publishes a commerce refresh. | inventory writers | exact sibling membership and revisions, idempotent via mutation ID |
| `warehouse.save`         | Client-generated warehouse `id`, `name`, `active` and reviewed `version` (zero for creation). The main warehouse is implicit and immutable. | inventory writers | exact version, idempotent |
| `warehouse.transfer`     | Client-generated document `id`, `sourceId`, `destinationId` (null for the main warehouse), `reason` and lines with `productId`, reviewed `version` and `quantity`. | inventory writers | all lines atomic, exact product versions, idempotent |
| `warehouse.adjust`       | Client-generated movement `id`, `productId`, explicit `warehouseId` (UUID or `main`), `kind` of `receive`, `consume`, or `count`, `quantity`, `reason`, product `version` and location `reviewedOnHand`. A count sets physical units. | inventory writers | exact product version and reviewed stock, idempotent |
| `service.create`         | `id` (client-assigned) and `service` with the same fields as REST creation, including eligible catalogue options and professional IDs                          | owner or catalog manager     | transactional, idempotent |
| `service.staff_replace`  | `id`, `reviewedStaffIds`, `staffIds`. The server compares the current team with the reviewed set before replacing assignments.                            | owner                        | exact team set       |
| `staff.update`           | `id`, `displayName?`, `active?`                                                                                                                             | owner                        | LWW                  |
| `settings.update`        | `{ expectedRevision, changes }` with the edited salon settings fields. Legacy clients may send a flat settings patch.                                      | owner                        | revision or legacy LWW |

A reviewed settings edit uses the `revision` from `ownerConfiguration` or `/admin/settings/desktop`. The server checks it while holding the settings row lock. Successful retries with the same mutation ID return the recorded result without applying the change again. A restored generation quarantines queued settings with the other pending mutations until the owner reviews them again. [ADR 0022](adr/0022-reviewed-offline-salon-settings.md) describes the revision and acknowledgment rules.

`version` is the `version` of the appointment as you last received it (it increases on every server-side change). If you queue several mutations for the same appointment while offline, increment your local copy yourself after each: the second mutation in the example below carries `version: 2` because the first one will bring it to 2.

```json
[
  {
    "kind": "appointment.reschedule",
    "payload": { "id": "A", "version": 1, "startsAt": "2026-03-09T13:00:00.000Z" }
  },
  { "kind": "appointment.cancel", "payload": { "id": "A", "version": 2 } }
]
```

### Rejection reasons

| `reason`           | Meaning                                                                                                                       | What the client does                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `slot_taken`       | Another appointment holds that time for the staff member                                                                      | Show the conflict; user picks another time or cancels the pending booking |
| `slot_unavailable` | Outside working hours, during time off, or breaks the notice or advance window                                                | Same; staff can resend with `override: true` for the notice window only   |
| `conflict`         | Stale appointment `version`, or an LWW edit older than what the server has                                                    | Pull, then show the user the server state and let them redo the edit      |
| `not_found`        | The row does not exist (yet, or was deleted)                                                                                  | Usually a dependency arrived late or the row was deleted; surface it      |
| `invalid_state`    | State machine forbids it (cancelled appointment, closing before start, duplicate id, deactivating staff with future bookings) | Surface                                                                   |
| `forbidden`        | Not allowed for this user                                                                                                     | Surface; do not retry                                                     |
| `invalid`          | Malformed or violates a constraint, or the `mutationId` was used by someone else                                              | Surface (this is a client bug)                                            |

Rejections are final and stored: resending the same `mutationId` returns the same rejection. To retry after the user resolved it, create a NEW mutation with a NEW `mutationId`.

A peak-time appointment includes the optional `appointment.create.payload.peakPriceReview` token. Present the total and surcharge before booking, then send the token for the reviewed selection. The booking stores that rate in the service snapshot. Changing the rate, slot, treatment terms or salon timezone invalidates the token. New or changed surcharges return an appointment creation rejection with reason `conflict`. Review the current quote as a new proposal before retrying.

### Idempotency, retries and backoff

- Network failure, timeout or a 5xx with no body: resend the SAME batch. Replays are free and exact (`replayed: true`).
- `429 rate_limited`: honor `Retry-After`. In the desktop sync worker, local edits, manual sync and live notifications wait for the scheduled retry. Edits stay queued in SQLite.
- Result `status: "retry"`: the mutation and every mutation after it in that batch were NOT processed; resend them in the next batch.
- Backoff: exponential with full jitter, base 1 s, factor 2, cap 60 s; reset after any success. Do not retry `400`, `401` (re-authenticate first) or `403`.
- Do not split or reorder a batch on resend; keep outbox order. Never run two pushes concurrently.

## GET /sync/pull?since=&limit=

- `since` (integer, default 0): your cursor. `0` returns a full snapshot.
- `limit` (1 to 500, default 200): maximum change-log rows scanned.
- `catalogColors=1` (optional, staff and owners): also return `catalogColors`, a map from service IDs to configured colors. It includes inactive services and excludes deleted services. An empty map means there are no configured colors. Desktop installations request it on upgrade even at the current cursor and record completion after repairing the local service projection.
- `reviewRequests=1` (optional): ask for the `review_requests` refresh topic. The server requires the caller's current `editCatalog` permission. Clients that omit the flag still advance their cursor past these notices.
- `intakeViews=1` (optional): enable `intake_forms` for callers with `deleteClients` and `intake_records` for callers with `clients`. Older clients advance past these notices without receiving the new topic values.
- `peakPriceViews=1` (optional): opt into the payload-free `peak_prices` refresh marker with `editCalendar`. Older clients advance their cursor past the marker.
- `peakPrices=full` or `peakPrices=delta` (optional): request the reviewed pricing snapshot `{ version, timezone, rules }` for offline bookings. `full` backfills a missing cache. `delta` only returns rules when the page scans a rule or salon-settings change. A client applies the snapshot with its cursor in the same SQLite transaction and clears it on a replica reset or when `peakPriceAccess` is false.
- `bookingPolicy=1` (optional): enable the payload-free `booking_policy` refresh topic. Read the public policy or the owner-only reviewed policy after receiving a notice. Both owner clients use `GET /admin/settings/booking-policy/reviewed` to retrieve the current sync generation and policy. Publish with `PUT /admin/settings/booking-policy/reviewed` using that generation and policy version. The legacy version-only PUT is accepted only in the initial generation.
- `portfolio=1` (optional): return the payload-free `portfolio` refresh topic to callers with `editCatalog`. The gallery reloads the authenticated list and the selected image. The response advertises `portfolioUploads` when queued private drafts are supported for the caller. Direct desktop writes send the generation reported by the gallery and the reviewed photo version or upload key.

- `promotionViews=1` (optional): opt into the payload-free `promotions` refresh topic. The caller needs both `commerce` and `editCatalog`. Promotion edits and changes to the visible usage count refresh the authenticated list and the promotion choices for social creatives. Older clients advance their cursor past the marker.
- `resourceCatalogue=1` (optional): return the payload-free `resource_catalogue` refresh topic to callers with `editCatalog`. Refresh open resource pools and service requirements when receiving this notice. Desktop reads the selected service's reviewed snapshot before replacing its cache.
- `resourcePools=full` or `resourcePools=delta` (optional, requires `editCatalog`): request the complete resource pool catalogue, up to 50 rows. Use `full` on the first sync after opening the replica or when it lacks a copy. Use `delta` to include the catalogue only on pages that scan a resource catalogue marker. The desktop applies the catalogue, permission and cursor in one local transaction.
- `combinationCatalogue=1` (optional, requires `editCatalog`): opt into the payload-free `service_combinations` refresh topic. Cloud uses it to invalidate its combination listings.
- `combinations=full` or `combinations=delta` (optional, requires `editCatalog`): request up to 100 complete treatment combinations. Use `full` when opening a replica or when its cache is missing. Use `delta` thereafter to include the list when the page covers a combination, service, or staff qualification change. SQLite applies the list, permission and cursor together.
- `fixedCombinationTerms=1` (optional, requires `editCatalog`): evaluate a fixed-price combination's `bookable` flag for its reviewed professionals and visibility. For a staff-only combination, `bookable` refers to the centre's calendar. Clients without this flag see fixed-price combinations marked unavailable.
- `bookingCombinations=full` or `bookingCombinations=delta` (optional, requires `editCalendar` and a visible calendar): return a separate, scoped selection of bookable fixed-price combinations, including staff-only offers. Omit the snapshot in delta mode when the page has no related changes. The permission flag `bookingCombinationAccess` controls local retention. Scoped appointment changes also carry the eligible staff captured at booking, limited to the current staff member for own-calendar accounts. A fixed-price booking sends its reviewed combination along with the ordered treatment IDs. The server rechecks eligibility and current terms before accepting an offline booking.

A full booking combination snapshot includes `bookedCombinationTerms` for existing editable appointments in the operator's scope. Desktop fills missing data only on the matching local appointment version. The enrichment leaves the booking prices and calendar notices intact and never rewinds the replica cursor.
- `inventoryAccess=1` (optional): returns `viewerReadInventory` and `viewerWriteInventory` for the current account. The device stores the grants with the reviewed replica generation and cursor and removes cached orders and warehouse balances when read access is lost. The server rechecks authorization before writing.

Warehouse clients use the commerce marker for acknowledgments and invalidate idle warehouse views when it advances. The document ID for a transfer or adjustment survives retries and conflict review. The adjustment lookup returns the exact reviewed balance, product version and requested quantity so a difference with the same delta cannot pass as the reviewed count. When reviewing a transfer after a restore, Desktop checks whether that document already exists before making the proposal editable.

Desktop combination proposals can be amended before their first submission. SQLite reserves the payload before sending it. An in-flight or ambiguously delivered change retains its mutation ID and payload until it is confirmed or rejected.

```json
{
  "changes": [
    {
      "seq": 410,
      "entity": "client",
      "id": "01a1...c1",
      "op": "upsert",
      "data": {
        "id": "01a1...c1",
        "name": "Lucia",
        "phone": null,
        "email": null,
        "notes": "vip",
        "createdAt": "2026-03-01T10:00:00.000Z",
        "updatedAt": "2026-03-09T11:00:00.000Z"
      }
    },
    {
      "seq": 412,
      "entity": "appointment",
      "id": "01a1...a1",
      "op": "upsert",
      "data": {
        "id": "01a1...a1",
        "staffId": "01a1...01",
        "clientId": "01a1...c1",
        "startsAt": "2026-03-09T12:00:00.000Z",
        "endsAt": "2026-03-09T13:00:00.000Z",
        "status": "booked",
        "notes": null,
        "version": 1,
        "services": [
          {
            "serviceId": "01a1...a1",
            "name": "Haircut",
            "durationMinutes": 45,
            "bufferMinutes": 15,
            "priceCents": 10000,
            "currency": "ARS"
          }
        ],
        "createdAt": "2026-03-09T11:58:03.000Z",
        "updatedAt": "2026-03-09T11:58:03.000Z"
      }
    },
    { "seq": 414, "entity": "time_off", "id": "01a1...t1", "op": "delete", "data": null }
  ],
  "nextCursor": 414,
  "hasMore": false,
  "headSeq": 415
}
```

Rules:

- `timeOffScope` is the caller's current permission for blocking calendar time. It is returned even on an empty page and can be cached for offline controls. The values are `all`, `none`, or the caller's own staff ID.
- Entities: `appointment`, `client`, `service`, `staff`, `service_staff`, `working_hours`, `time_off`, `salon_settings` (its `id` is `"1"`). The `data` shapes are `syncXxxSchema` in `packages/contracts/src/sync.ts`. Appointment upserts can include `serviceBadges` for visible appointments. Each badge identifies its line by `servicePosition` and records the professional request and whether an internal note or customer comment exists. Commerce access adds billing flags, billing source and any `billingReviewReasons` or external settlement details. The indicators contain no note text.
- A visible client upsert may include `emailEditable`. Only active standalone profiles can edit contact email. An `emailChange` requires its own reviewed contact timestamp, including when `email` is null to clear it. The server invalidates prior email marketing consent when the address changes.
- A visible client upsert may include `controlsVersion` and, when requested with `clientGroups=1`, `groupNames`. The groups are distinct, nonempty normalized names matching the Cloud directory filter. A visible contact with no groups carries an empty list. A server that provides this projection for the caller returns `clientGroups: true`, including on empty pages. Desktop waits for that confirmation before filling in groups on older local contact rows. That backfill uses its own cursor, leaves the main cursor and queued edits intact, and updates only the missing group names. Clients with directory access use the revision to refresh an open controls panel or pause a draft for review. Original tag spelling, booking access and its private reason are fetched on demand through the authorized, uncached controls endpoint.
- A salon settings upsert includes `ownerConfiguration` for the owner. It contains the editable owner settings and their revision. The desktop replica stores that snapshot with the current sync generation so it can open and queue edits offline.
- The preference indicator survives a staff reassignment. Checkout status changes can re-announce an appointment with the same version so the replica receives the current billing indicator.
- A visible appointment upsert can include `resources` with the confirmed allocation names, optional stable `resourceId` identifiers, and the largest quantity reserved for each resource across its sequential services. An omitted field represents an empty allocation in that snapshot. Resource edits re-announce the appointment without changing its version. On upgrade, Desktop fills missing allocations and stable IDs on existing appointments with a separate replay cursor once the server advertises `bookedResourceIds`. The main cursor, notices and queued changes are retained.
- When an operator verifies a partial Booksy payment, both calendar feeds show the reconciled split and clear the historical Booksy payment and invoice review reasons. An invoiced service can still show its invoice indicator while the remaining amount is due. The paid indicator returns when a Citame receipt settles the balance.
- Desktop opens the text of appointment notes on demand over `GET /appointments/:id/context`. The ordinary calendar access rules apply, the response disables HTTP caching and the text stays out of the SQLite replica.
- Internal notes and the service's professional preference save online through `PATCH /appointments/:id/context`. The editor submits the appointment version and the service annotation version from the same read. It sends a preference update only for an explicit change, so other edits preserve an originally requested professional after reassignment. The server rejects stale versions, and desktop keeps the rejected draft in memory for manual review.
- Keep `sourceUnpriced` on unresolved imported service snapshots. The price becomes usable after the reviewed amount arrives in an appointment upsert. Evidence references and private source annotations stay on the server.
- `data` is the row's CURRENT state, which may be newer than `seq`. Upserts are idempotent: apply by primary key. A later entry for the same row will carry the same or newer state.
- Desktop tracks the confirmed appointment version and resulting slot when it acknowledges a queued booking, move or cancellation. It uses that state as a baseline when a newer row arrives before the confirmed version was pulled. The receipt sequence tells it when to discard the acknowledgement.
- Within one response a row appears at most once (latest entry wins).
- `op: "delete"` has `data: null`: delete the local row (a no-op if absent). A tombstone also means "no longer visible to you" (for example an appointment moved to another staff member's calendar).
- Store `nextCursor` and send it as the next `since`. It never decreases. If `hasMore` is true pull again immediately; `changes` may be empty while `hasMore` is true.
- On HTTP 429, wait for `Retry-After` and retry the same cursor. Pulls have separate network-address and verified-account quotas. All devices and sessions for the same account share its quota.
- The optional `refresh` list contains online view names (`commerce`, `waitlist`, `inbox`, `review_requests`, `intake_forms`, `intake_records`, `promotions`). A page can contain only these notifications and still advance the cursor. Reload each view through its regular authenticated endpoint. The owner-only `email_delivery`, `whatsapp_desk` and `whatsapp_settings` topics require `emailDelivery=1`, `whatsappDesk=1` and `whatsappSettings=1`, respectively. They carry no provider details or credentials. The list carries no row data. Financial records, review invitations and intake forms and answers stay out of the offline replica. Persist the notifications and cursor together so a retry cannot skip them.
- `409 invalid_state` means your cursor is ahead of the server. Drop the local mirror and resync from `since=0`. Check the returned generation before applying any page.
- Staff only receive their own calendar's appointments, working hours and time off (everything else arrives as tombstones). The `userId` of `staff` rows is `null` for staff callers.
- Apply a page in one local transaction together with the cursor update; apply `service_staff` and other references without assuming parents arrived first (insert order inside a page is by `seq`, not by dependency).

## GET /sync/stream (SSE)

`Content-Type: text/event-stream`. Events:

```
event: change
id: 415
data: {"seq":415}

: ping
```

- A `change` event is sent on connection and when the committed head advances. API writes publish through Valkey. Each API process with active streams also checks the database head once a second to detect background commits and recover missed notifications. A `change` event only signals that clients should pull.
- `: ping` comment lines arrive every 15 s; if nothing arrives for 45 s, reconnect.
- Reconnect with the same backoff as above, then pull. `Last-Event-ID` is not needed: the cursor is the source of truth.
- The web client lets the browser retry transient EventSource errors. If the browser closes the source after a terminal HTTP error, the web client checks every 30 seconds and opens a new source once online. A rate-limited web pull keeps its cursor and pauses recovery requests until `Retry-After` expires.
- Authentication accepts a web session cookie or a first-party desktop OAuth bearer token. Rate limited per caller: `429` with `Retry-After` (default 30 new connections per minute). `401`/`403` as for the other endpoints.
- The server closes streams when it shuts down; treat a closed stream like any disconnect.

## Error summary

| Status | `error.code`       | When                                                                               |
| ------ | ------------------ | ---------------------------------------------------------------------------------- |
| 400    | `validation_error` | Bad envelope or query (`limit` out of range, empty batch, more than 100 mutations) |
| 401    | `unauthorized`     | No session                                                                         |
| 403    | `forbidden`        | Role `client`                                                                      |
| 409    | `invalid_state`    | Pull cursor ahead of the server                                                    |
| 429    | `rate_limited`     | Global, pull or stream rate limit. See `Retry-After`.                              |
| 500    | `internal_error`   | Unexpected; retry the same batch with backoff                                      |

## Local schema hints

Keep one table per entity keyed by `id`, a `sync_state(cursor)` row, and an `outbox(mutation_id, created_at, kind, payload, state)` table. Generate `mutation_id` with UUIDv7 at the moment the user acts, never at send time, and keep the `createdAt` of the edit stable across resends.

### Offline gift register

The pull response includes `giftCardsScope` for centre accounts that can access the gift
register. The opaque token describes the account's visible set. Desktop deletes its saved
register and movement pages when the token is absent or changes, when the replica resets
and when the operator signs out.

`GET /admin/gift-cards/replica?page=1` returns up to 128 masked cards, the current scope,
database generation, commerce revision, sync log head, and `hasMore`. Desktop publishes a
complete copy only if every page shares its scope, generation and commerce revision. It also
checks that the final log head covers the most recent local commerce refresh. A movement
response includes the scope and generation required to save it with the corresponding register.
Desktop retains up to 64 recently opened pages of movements. Saved balances can be searched
offline and are marked with their last retrieval time. Codes and financial writes use the online
gift register.
