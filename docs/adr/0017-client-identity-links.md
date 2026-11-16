# ADR 0017: Reviewed client identity links

Status: accepted. Implemented in migration `0040` and the shared client identity service; operational behavior and verification are documented in [client merging](../client-merging.md).

Duplicate walk-in profiles should be associated with one surviving salon client without rewriting appointment, receipt, gift, pass, loyalty, intake or review history. Reassigning every foreign key would invalidate immutable statements, original request hashes and refund provenance. Instead retain the source profiles and add a directed `merged_into_id` identity link.

## Ownership and bounds

Only owner/manager client-directory administrators may confirm a merge. A source group must contain no linked login account. A group with an account must be the destination; two active accounts cannot be joined by salon administration. Linking account identities needs a separate account-ownership process. Suggestions based on normalized contacts or exact names never perform automatic merging and must distinguish family members sharing a contact.

A merge requires an explicit same-person confirmation and a fresh preview of the profiles, linked history, surviving contact details, access restrictions and photo limits. Blocked access wins over normal/trusted access. Import/contact data never grants marketing or public-photo permission. Keep private source notes as labelled history rather than silently truncating them into a bounded contact field.

The identity graph is acyclic and each group contains at most twenty profiles. Preserve existing links when a surviving unregistered root is later linked to another root; do not rewrite previous alias rows or immutable merge receipts. Resolve the root and bounded group explicitly. An alias cannot receive a login account or new independently edited contact/booking data. Stale offline booking proposals naming a merged profile require a fresh client review, with a specific rejection rather than silent reassignment.

## Financial and privacy behavior

Historical rows retain their original client ids and creation receipts. Customer ownership checks recognize only the bounded group attached to the authenticated surviving account. Queries use that group's ids, preserving existing calendar/sales permission scopes. Point balances/debt/reservations and eligible paid passes are computed across the group; movements, original credit lots, expiry and refund sources remain unchanged. A merge creates no payment, points, pass units, commission or refund.

All monetary writers must lock the current root before spending group value and revalidate identity after waiting. Merge operations serialize with one another, lock their two current roots in deterministic order and update only those roots, not old aliases or financial rows. This avoids taking receipt locks under client locks. Existing receipt → inventory → client/value ordering remains authoritative. Competing merges, redemption, refund and expiry need executable concurrency coverage before delivery.

Original form statements and associations remain unchanged. Existing linked visit statements stay private history; new bookings require statements for their current subject and never infer consent from a merge. Public review/photo permissions remain independent, including withdrawal. Notification dispatch must resolve the current contact and conservative preferences explicitly; it must never revive suppressed channels or treat historical contacts as opt-in.

## Read, sync and recovery

The directory/import/export show surviving profiles while duplicate detection recognizes historical alias contacts and reports one surviving identity. CRM history, private images and authorized customer records aggregate the bounded group without exposing another account. A merged source opens a clear link to its survivor. Deleting a surviving profile still checks future visits across the entire group.

Sync retains aliases for old calendar/history joins and includes their identity link. Native pickers exclude aliases; queued old proposals remain intact and cannot be silently rewritten. The replica upgrades without resetting its cursor or outbox.

Actor-scoped immutable merge receipts retain the exact original submitted selection through uncertain responses. Retrying cannot create another link or reinterpret a changed preview. Later links may change the currently resolved survivor; the original receipt still names its original source and destination. No actual client merge is authorized by this architecture document alone; application users must review each real operation.
