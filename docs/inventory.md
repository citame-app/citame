# Retail inventory

Open **Sales & register → Inventory**. The owner and managers can create/edit/archive products, record supplier deliveries, salon consumption and physical counts, and inspect stock history. Reception and professionals can read the catalog and availability; unit costs are excluded from their API responses. Clients have no inventory access.

Catalog prices are EUR amounts including the configured tax percentage. An empty unit cost means unknown, not zero. SKU values are normalized to uppercase and unique; optional barcodes are also unique. Archived products remain in historical receipts and movements.

**On hand** means physical units, **reserved** means units held by open sales, and **available** is their difference. Low-stock filtering uses available units. Physical counts replace the on-hand total; they cannot reduce it below reservations. All stock changes require a reason, optimistic version and idempotency key. If a product changes during editing, reload it before submitting a new adjustment.

In **New sale**, search for products, add quantities, and optionally add a custom line, discount and tip. The server reads each product's authoritative price/tax and reserves stock transactionally. The receipt retains those values after later catalog edits. Full payment (or a fully discounted checkout) consumes reserved stock exactly once. Partial payment keeps the remaining units reserved.

Unpaid product checkouts expire after 30 minutes if they have no captured or unresolved payments. The API and standalone worker sweep up to 50 expired carts per minute; multiple replicas are safe. An operator can explicitly void an unpaid checkout from its receipt. Bank attempts and partially collected payments must be resolved first. A signed bank success arriving after a checkout was voided is retained as captured money for reconciliation/refund; it does not sell inventory already released to another cart.

A financial refund does not imply a physical product return. The owner or a manager can record a physical return from a fulfilled receipt, specifying the product, quantity and reason. Repeated requests with the same key do not duplicate stock. Total physical returns cannot exceed the quantity originally sold. Refund money separately using the receipt's payment history.

Migration `0010_retail_inventory.sql` adds the product, reservation and stock-movement ledgers. Settled historical receipts receive a fulfillment marker without retroactively creating inventory movements. Voided appointment receipts remain in history; a replacement active receipt can be created for the same appointment.

Tests cover competing last-unit checkouts, server-side pricing, catalog edits after reservation, counts versus reserved units, free checkout fulfillment, idempotent stock deduction/returns, excess return rejection, expiry and unresolved/partial payments. The browser flow covers creation, supplier delivery, retail settlement, physical return and archive in light/dark mobile/desktop Chromium, with accessibility checks.
