# Packages and memberships

One Sisters of Beauty business, one location. In **Sales & register → Gift cards & rewards → Packages & memberships**, owners/managers configure plans; permitted operators sell them to an existing client. Customer accounts show their own purchases, period history, available/used/refund-held visits and purchase receipts. Customer online purchase/renewal requires a configured bank payment method; operators can record a salon payment. No sample production plan or price is created automatically.

## Terms and activation

Packages contain 1–1,000 visits, optional validity in calendar days and eligible EUR services. Memberships define a 1–12 month interval, visits and/or a percentage discount on eligible services. Prices include the configured tax. Every included visit must have at least one cent of funding. Edits and archival affect new purchases; existing contracts keep their original name, price, tax, eligible services and interval.

A new purchase has a pending receipt and no usable visits. Only full retained payment activates its period. First payment establishes the salon-local billing anchor. Subsequent cycles always derive from that original anchor, preserving end-of-month and daylight-saving behavior. Paid future periods apply to bookings within those dates. Late renewals skip elapsed cycles; payment of an abandoned renewal invoice also selects the current cycle. Packages expire by calendar days in the timezone recorded at purchase. Eligibility uses the appointment's service date, rather than allowing an expiring pass to cover arbitrarily distant bookings.

Membership renewal currently creates a separate invoice for explicit payment. Only one pending/upcoming renewal is created under concurrent requests. Stopping renewal preserves paid benefits until their recorded expiry. A pending bank attempt must be resolved before cancellation. Automatic recurring requests fail closed with `payment_unavailable`; no card mandate or automatic charge is fabricated. Automatic Redsys billing, its explicit customer mandate and delivery notices remain in the expansion backlog until their implementation/configuration is complete. Cash, Bizum and gift-card payment do not create a recurring card mandate.

## Checkout and returns

Open the booked appointment's receipt and select **Use prepaid visit**. A visit covers one eligible service line in full, after its approved discount. It cannot cover products, tips, custom items, another pass or a gift-card purchase. Apply visits before other payments if their remaining balance would otherwise fall below the service line amount. The buyer must match the receipt client. Concurrent checkouts cannot spend the same unit. Idempotent replay does not consume it again.

Each visit owns an immutable portion of the purchase price and tax, including any remainder cents. Returning a redeemed visit must return that entire tender; it restores the original unit and its exact allocation once. Refunding the original purchase returns whole unused units at their original allocations. Select the number in the purchase receipt's refund form; the server quotes the amount. For split payments, select a payment with sufficient refundable value. Excess bank captures are returned before prepaid value. Refunded units cannot reactivate after a late capture.

Pending or ambiguous bank purchase refunds hold selected units unavailable until confirmed or explicitly reconciled; a failed return releases them. A pending refund also suspends new membership discount quotes for that period. Previously approved receipts retain their prices. Returning any access-only membership fee closes that benefit period. Split original payments can be returned separately to their original methods; the quote is capped at that payment's remaining captured amount. Fully returned purchases are closed; late bank captures remain refundable money, not new entitlements. Financial reconciliation never retries an ambiguous bank operation automatically.

## Money, reports and access

Receipt tender shows the covered service's nominal price. Staff commission and service revenue use the visit's actual prepaid allocation, excluding its allocated tax; a higher catalog price does not inflate commission. Returning a pass visit reverses its commission while preserving separately paid service lines. Reports and CSV distinguish new collections, gift tender, nominal prepaid tender, recognized prepaid allocations and membership access fees. Purchase funding is not counted twice as service revenue. These operational reports are not fiscal certification.

Owners/managers configure plans. Sales permissions govern purchases and receipt access. Reception can sell and inspect salon purchases, professionals see their own sales and eligible passes for their authorized appointment receipts, restricted staff cannot use customer-route aliases to bypass access. Customers see only their own passes. Only refund-authorized operators request purchase return quotes or refunds. Mutations and activations are audited.

Migration `0015` adds frozen contracts, periods, discrete visit units, immutable redemptions and durable refund allocations. Gift-card and existing payment/stock/commission ledgers remain integrated in the same settlement transactions. No customer, payment or banking credentials are required to configure a plan locally.
