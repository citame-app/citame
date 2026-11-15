# ADR 0013: Retention value and settlement

Status: accepted for the single-location expansion, 2026-11-15.

Gift cards, packages, membership periods, promotions and loyalty reuse checkout settlement rather than mutating balances from browser callbacks. Provider credentials remain server-only and no card number/CVV is stored. New-money collection and prepaid-value redemption must be reported separately to prevent double counting.

## Gift cards

A purchase creates one pending, server-priced gift card and its receipt atomically. Only full retained settlement activates its face value. The application stores a code hash, random nonce and a masked suffix; the bearer code is derived with a purpose-separated server HMAC and revealed only to an authorized buyer/operator after activation. Auth-key rotation does not invalidate existing bearer codes for redemption, which uses their stored hash. An authorized manager can reissue a code with an audited reason if later revelation is unavailable.

Redemption locks the checkout then the gift card, validates active/unexpired status and available value, records one successful stored-value tender and one immutable debit, then runs normal fulfillment. A gift card cannot buy another gift card. Refunds of gift-card tender restore value to that same card exactly once; expiry is not silently extended.

Refunds of a gift-card purchase must not leave both the refunded money and spendable gift value. Requested/ambiguous bank refunds reserve the corresponding unspent gift value. Completed refunds remove it; failed refunds release the reservation. Aggregate refund allocation first returns excess captured money before reducing issued face value. Later authenticated captures can restore value previously removed from a still-active gift if the retained funds again cover it. Fully returned gifts are closed; later captures remain refundable reconciliation money and cannot reactivate that voucher. Checkout row locks serialize financial state and gift-card locks serialize value use. An immutable movement records each actual balance change; repeated status refreshes are no-ops.

Gift cards are bearer instruments. Knowing a code permits checking its balance and redeeming it against an authorized checkout; this does not expose the buyer, internal reference, ledger or purchase history. Codes travel in authenticated POST bodies and no-store responses, never query strings or audit metadata. There are no implicit foreign-exchange conversions.

## Further retention blocks

Packages and membership periods belong to a client and grant explicit eligible-service uses only after their purchase is paid. Renewal invoices can be paid through hosted Redsys; unattended recurring bank charges need the bank-enabled COF/tokenization flow and explicit client authorization before activation. The bank keeps card details. Official references: https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-funcionalidades-avanzadas/tokenizacion/ and https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-funcionalidades-avanzadas/tokenizacion/tokenizacion-mit/ .

Loyalty and promotional quotas require transactional reservations, deterministic validity and idempotent settlement/refund effects. Their implementations and UI remain separately open in FEATURE-EXPANSION.md. No real charge, recurring mandate or external message is authorized by a local test.
