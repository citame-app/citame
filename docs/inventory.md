# Retail inventory

Open **Sales & register → Inventory**. The owner and managers can create/edit/archive products, record supplier deliveries, salon consumption and physical counts, and inspect stock history. Reception and professionals can read the catalog and availability; unit costs are excluded from their API responses. Clients have no inventory access.

Catalog prices are EUR amounts including the configured tax percentage. An empty unit cost means unknown, not zero. SKU values are normalized to uppercase and unique; optional barcodes are also unique. Archived products remain in historical receipts and movements.

In the web catalogue, you can save a category or brand while the list refreshes in the background. If someone changed that entry or the database was restored, Citame keeps your edits and blocks another save until you review the current version.

**Content per pack** is optional and records an amount and unit such as 150 ml. Stock movements and sale quantities still use the selected stock unit. Product details show the latest saved content, and the product CSV exports it in `package_content_quantity` and `package_content_unit`. Clearing both fields removes the content without changing stock or prior sales.

**On hand** means physical units, **reserved** means units held by open sales, and **available** is their difference. Low-stock filtering uses available units. Physical counts replace the on-hand total; they cannot reduce it below reservations. All stock changes require a reason, optimistic version and idempotency key. If a product changes during editing, reload it before submitting a new adjustment.

The web form saves the submitted movement for the signed-in account and product in the current tab before sending it. If the result is uncertain, reopen the product in the same tab and use **Retry the same movement**. Reloading the tab preserves the original quantity, reason, version, idempotency key and server generation. Closing the tab ends this recovery scope. The API rejects a web submission if the browser session has switched accounts. When the server rejects a movement from before a restore, choose **Load current stock**, compare the balance and recent movements, then select **Discard previous request** to prepare another adjustment.

API clients must obtain `inventoryGeneration` from the product detail and send it as `generation` with `POST /admin/inventory/products/:id/movements`. For MCP, use `get_product` before `record_stock_movement`. The server rejects missing generations and changes from an earlier restored database. Deploy the API and web build together so existing browser tabs can reload the updated form.

In GPUI, open **Inventory → Stock history** on a product to read the shared ledger and register deliveries, consumption or counts. The desktop saves the submitted request before contacting Citame. If the result is uncertain, retry the same movement after reconnecting, including after an app restart. A server restore fences the movement to the generation it was prepared against. Review current stock and history when the server rejects a request from an earlier generation. See the [desktop inventory guide](../apps/desktop/README.md#inventory).

In the web or GPUI inventory, **Stock movements** lists all products. Paging and CSV export use the same cutoff for committed movements while you browse. Opening a product preserves the page and filters. A stock change matching the filters shows a notice. Use **Show latest movements** to include it and return to page one. A server restore invalidates the old cutoff, so a new view must be loaded before exporting.

In **New sale**, search for products, add quantities, and optionally add a custom line, discount and tip. The server reads each product's authoritative price/tax and reserves stock transactionally. The receipt retains those values after later catalog edits. Full payment (or a fully discounted checkout) consumes reserved stock exactly once. Partial payment keeps the remaining units reserved.

Unpaid product checkouts expire after 30 minutes if they have no captured or unresolved payments. The API and standalone worker sweep up to 50 expired carts per minute; multiple replicas are safe. An operator can explicitly void an unpaid checkout from its receipt. Bank attempts and partially collected payments must be resolved first. A signed bank success arriving after a checkout was voided is retained as captured money for reconciliation/refund; it does not sell inventory already released to another cart.

A financial refund does not imply a physical product return. The owner or a manager can record a physical return from a fulfilled receipt, specifying the product, quantity and reason. Repeated requests with the same key do not duplicate stock. Total physical returns cannot exceed the quantity originally sold. Refund money separately using the receipt's payment history.

Migration `0010_retail_inventory.sql` adds the product, reservation and stock-movement ledgers. Settled historical receipts receive a fulfillment marker without retroactively creating inventory movements. Voided appointment receipts remain in history; a replacement active receipt can be created for the same appointment.

Migration `0074_inventory_ledger_position.sql` adds the ledger position with a zero default for existing movements. It keeps their dates, quantities and ordering. New rows receive a position at commit under the same lock used by the sync log. This keeps pagination stable when a transaction started before the current view and commits afterward. Apply the migration before starting the new API.

Tests cover competing last-unit checkouts, server-side pricing, catalog edits after reservation, counts versus reserved units, free checkout fulfillment, idempotent stock deduction/returns, excess return rejection, expiry and unresolved/partial payments. The browser flow covers creation, supplier delivery, retail settlement, physical return and archive in light/dark mobile/desktop Chromium, with accessibility checks.
