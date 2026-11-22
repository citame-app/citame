# ADR 0012: Commerce, retail reservations and entitlement accounting

Status: accepted for the single-location expansion, 2026-11-15.

## Existing payment boundary

Redsys is a server-only adapter, disabled until configured. Checkout totals and appointment-price snapshots are server-authoritative. Payments/refunds have immutable amounts, idempotency keys and audit events. A bank redirect is informational; only an authenticated matching notification or an explicitly audited owner reconciliation can establish settlement. Reserved refunds prevent overspending. Lost bank results are reconciled, not automatically retried. Known late/excess captures remain in the ledger and can be refunded.

## Retail extension

- Products have SKU/barcode, EUR catalog price, optional catalog unit cost, inclusive tax basis points, active state, physical stock, reserved stock, low-stock threshold and an optimistic version. Costs are private to authorized managers; an unknown cost is not represented as a known zero cost.
- Checkout locks all selected product rows in stable id order, resolves prices from the catalog, and reserves quantities atomically. Duplicate product lines aggregate for stock checks. A customer never supplies the product's effective unit price/tax/cost.
- Reservations attach to immutable checkout lines. On full payment they are consumed in the same transaction as settlement, producing one stock-sale movement per line. A fulfillment marker prevents duplicate inventory or later entitlement fulfillment. Free checkouts follow the same fulfillment path.
- Cash collection rolls back if fulfillment fails. Bank callbacks retain unallocatable money for reconciliation rather than claiming successful fulfillment. Stock is held while a bank attempt or captured partial payment remains unresolved.
- Unpaid carts with no pending/captured payments can expire or be explicitly voided, releasing reservations. A background sweep in the real API/worker entrypoints handles expiry; integration tests invoke the sweep with an explicit clock. Workers process one checkout per transaction, use skip-locked checkout claims and stable product-lock ordering.
- Voided appointment checkouts remain in history; a partial unique index permits a replacement active checkout for that appointment. Opening an existing receipt does not overwrite its staff-approved discount.
- Returns and internal consumption are explicit stock movements. A refund does not automatically mean a product was physically returned. Returns against a sold line cannot exceed the sold quantity and are idempotent. Product deactivation preserves history and existing reservations.
- Purchase orders record procurement in Cloud and Desktop. Desktop applies its persistent queue through the same authorization and version checks as Cloud. Marking an order as placed records an action already performed with the supplier. Linked receipts verify the reviewed order and product versions, apply stock movements, and update received quantities in one transaction. Retrying a confirmed receipt returns the original document. Cancelling outstanding units preserves posted deliveries.
- The retail product balances remain totals across locations. Existing inventory and reservations belong to the main warehouse. Secondary balances update the product allocation under the same product lock. Checkout reserves and sells from the main warehouse. Transfers preserve the total and write both ledger entries in one transaction. A location with physical stock cannot be archived.
- Inventory adjustments cannot reduce physical stock below reserved stock. Prices/costs on an existing checkout are snapshots. Monetary values and stock base units are integers; there is no implicit exchange-rate conversion.
- A numbered stock receipt records a completed delivery. It locks products in ID order, verifies the reviewed versions, and writes every movement in one transaction. The receipt keeps its supplier name and product details at receipt time. Later catalogue and supplier edits preserve that history. Receipt numbers can have gaps after rolled-back writes. Retrying the same actor and request returns the existing receipt.
- Desktop stores reviewed supplier and product data for offline preparation. A queued receipt's UUID is also its server identity. If a restored replica retains that receipt, Desktop can recognise it by ID during conflict review without posting its movements again.

## Following blocks

Keep fulfillment hooks transaction-scoped so gift-card issuance/redemption, packages, memberships, loyalty and commission accrual can reuse the settlement boundary without duplicating balances or events. Service-product consumption must be distinguished from retail sale and retain an explicit reason/audit trail. Five staff-access presets and their scoped financial/catalog permissions are part of the staff-management delivery, with the owner retaining control of access changes.

Booking deposits/holds, waitlist offers, resource/capacity scheduling, CRM/forms/reviews/portfolio and consent-based marketing remain separately tracked in FEATURE-EXPANSION.md. Multitenant marketplace and multisite operations remain outside the confirmed present scope.


### Gift sale price and redeemable value

The gift card stores its original redeemable value. The single gift line on the purchase
receipt records the final sale price. Checkout can collect only that price. After settlement,
the card activates with the full redeemable value.

Purchase refunds remove the proportion of gift value corresponding to the cumulative cash
returned. Keep cumulative refunded cash and open refund reservations separate. Round the
cumulative value up to a cent, then apply only the difference from the amount already removed
or reserved. A full refund revokes the original gift value. Reject a refund that would remove
spent value. Reversing a failed bank refund releases its reservation. Excess bank captures
remain refundable without changing the gift value. Purchases and retries for an equal value and
price retain the original request identity.
