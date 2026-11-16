# Loyalty points and promotion codes

The points program starts disabled. Under Sales & register → Gift cards & rewards → Loyalty & promotions, an owner can configure earning steps, point value, redemption percentage and expiry. Owners/managers can create promotion codes and record reasoned point adjustments. No external provider or message delivery is required for these local operations.

## Points

Select a customer in a new salon sale to attribute its points. Anonymous sales have no account to credit. Customer accounts show their available/reserved points, points to recover after returns, upcoming expiry and activity. A customer sees only their own account. Professionals can see a customer's operational point balance but their activity history includes only receipts they are authorized to inspect. Adjustment reasons remain private audit data.

Eligible services, retail products and manually priced items earn points on fulfillment, after discounts. Tips, gift-card purchases and package/membership purchases do not earn points. Spending a gift balance on an eligible service can earn once. Prepaid visits earn from the original funded allocation, rather than a potentially higher catalog face value. Protected appointment deposits do not earn points before completion. The earning policy in force at settlement applies; changing a program never awards old receipts retroactively. Each receipt is awarded at most once.

To use points, open the unpaid receipt, enter the point quantity and preview the discount. The server checks the balance, configured value and maximum percentage of eligible remaining spending; it does not discount tips or gift/pass purchase lines. Apply the reviewed amount explicitly. Points are allocated from the oldest valid credits, reserved atomically, and cannot be spent on two concurrent receipts. One points redemption or promotion may be applied to a receipt, before any payment attempt. Choose a reward discount or a prepaid visit tender; combining both could consume points without reducing the discrete visit required. Gift-card monetary tender remains compatible. The receipt retains its accepted value if the program later changes or is disabled.

Purchase returns reduce the original earning proportionally to retained eligible value, with integer rounding. Points already used can produce a negative points balance; future earnings compensate that balance. This is a points adjustment, never a new monetary charge. Monetary returns also restore redeemed points proportionally, keeping the original credits' expiry. Repeated partial returns cannot restore the same points twice. Returned credits that have expired are not made spendable again. Restoring points previously reversed by a purchase return clears the corresponding point deficit instead of minting new value.

A fully point-funded zero-total receipt has no fictitious cash payment. A refund-authorized manager can explicitly return its original points from the receipt. Actual captured payments must be returned first. Physical product returns remain separate from money/point returns. Corrections and returns are audited and idempotent.

## Promotions

Codes have a name, percentage or fixed EUR amount, minimum eligible spend, optional discount cap, total/per-customer usage limits, start/end instants, eligible item kinds and optional service restrictions. Code matching normalizes case and surrounding whitespace. Local time inputs use the salon timezone and reject nonexistent local times. Server validity compares instants, including when timestamps have different offsets. Codes cannot be reused to overwrite an existing offer; edits require the current revision.

A promotion quote keeps the better existing discount on each eligible line. It does not silently stack with a stronger membership/manual discount. The quote shows the additional saving and new receipt total before application. Gift/pass purchase value and tips are excluded. Existing approved receipts retain their terms when an offer is edited or archived. A stale quote or receipt total is rejected before changing balances or reserving a use.

Both reserved and fulfilled receipts consume usage limits. Voiding an unpaid reservation releases its use. A fulfilled receipt keeps its usage recorded after refunds, preventing repeated promotion recycling. A code's quota is locked while reserving it, including across different customers and API replicas. The list shows reserved/used counts and supports literal name/code search and pagination.

## Reservations, refunds and expiry

Counter-sale reward reservations last 30 minutes before any payment. The independent expiry loop voids an abandoned receipt and releases its stock, points and code quota. A pending or captured payment preserves the agreed reservation for resolution; an unknown bank outcome is not treated as an unpaid abandonment. Booked visits retain their reward until completion or cancellation. Cancelling an unfulfilled rewarded visit releases its points/code and closes its receipt; captured funds remain in the existing refund/reconciliation ledger.

Point balances exclude expired credits immediately, even if the background expiry ledger update has not run yet. The expiry loop is independent of email/payment configuration and stays active when the points program is disabled. Workers use receipt/customer locks to serialize expiry, payments, returns and competing redemptions. New reward reservations lock retail stock before the customer balance, preserving settlement's lock order when a discount makes a receipt free.

Refunds are the existing explicit salon operations. A bank return that is still requested, dispatched or ambiguous does not restore value as if it had succeeded. The original method and financial reconciliation remain authoritative. Promotion/loyalty operations never send campaigns or create new bank charges.

Migrations `0019_abandoned_longshot.sql` and `0020_useful_phantom_reporter.sql` add the program, conserved point credits, activity, promotion claims and original-credit return allocations. Apply all pending migrations before starting the updated API. `bun run --cwd apps/web e2e:rewards` uses an isolated local test database and explicit fixtures, with no real payment or customer delivery. Marketing consent, segments, campaigns and delivery are tracked separately in [feature expansion](FEATURE-EXPANSION.md).
