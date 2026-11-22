# Gift cards

Open **Sales & register → Gift cards & rewards**. Clients use the same area under **My account**. An operator can create a prepaid purchase for a walk-in bearer or associate it with an existing client. Clients can buy online when the bank provider is configured; the interface explains when online purchase is unavailable.

Gift value is EUR and becomes spendable only when its purchase is fully paid. Pending purchases expose no redeemable code. The receipt uses the reviewed sale price, and the card activates with the selected value. A gift card cannot buy another gift card. Card creation and receipt creation share one transaction and replay key.

After activation, an authorized buyer/operator can reveal, copy or print the code. The voucher prints in an isolated document containing that card's value/code and expiry; it does not clone the cash drawer, other sales or payment forms. The code is a bearer credential: its holder can check the balance and redeem it against a checkout they are authorized to pay. Balance checks do not expose the buyer, reference, receipt or history.

Gift codes travel in authenticated POST bodies and no-store responses. The database stores a hash, random nonce and masked suffix, not the plaintext code. Code generation uses a purpose-separated HMAC from the server authentication secret. Changing that secret does not invalidate already-issued codes for redemption, because redemption checks their stored hash. Later revelation may require the owner/manager to reissue the code with an audited reason. Reissue invalidates the old code and preserves value.

## Publishing gift offers

Open **Sales & register → Gift cards → Gift templates** on Web or **Cash register → Gift cards → Gift templates** on Desktop. Choose a name, design, gift value and sale price. To limit use to specific treatments, select them in the editor. An optional validity period begins when the gift is paid. The preview reflects the terms that the buyer will see. Keep unfinished offers as drafts and use the publication control when the offer is ready.

An offer appears on the public profile while online payment is available and its reviewed treatments are still valid. If the catalogue changes, open the relevant template and save the reviewed terms again. Buyers sign in, confirm the offer, and open the receipt for payment. Orders already created retain their original price, terms and design after changes or withdrawal.

Open **Pending online orders** in the gift register to locate orders awaiting payment and reopen their receipts. The list follows normal sales permissions and removes an order when it settles or is cancelled. Desktop can browse the latest authorized pending list offline and displays the age of that snapshot.

## Redeeming and refunding

Choose **Gift card** in a receipt's payment methods, enter its code and the amount to apply. The amount must fit both the receipt's remaining balance and the card's available, unexpired value. The remaining receipt balance can be paid with another method. Checkout/card row locks and immutable movements prevent competing redemptions or repeated requests from spending value twice.

A refund of gift-card tender returns value to that same card exactly once; it does not return cash or silently extend expiry. An owner/manager can adjust expiry with a reason and version fence if a returned balance needs its validity reviewed.

A refund of the original gift purchase must be covered by its unspent value. Requested or ambiguous online refunds reserve that value, preventing redemption while the bank result remains unknown. Bank rejection releases the hold; a completed refund removes it. Excess captures are refunded before reducing face value. Verified late captures can restore value previously removed from a still-active gift when retained funds cover it again. The ledger records those adjustments and avoids counting a bank replay twice. Fully returned purchases close the gift and its purchase receipt; later captures remain money to reconcile/refund and cannot reactivate the cancelled voucher. Replaying the original purchase request returns the existing receipt even if the requested expiry has since passed.

## Reporting and access

Financial reports separate **new money collected** from **gift value redeemed/returned**. Gift issuance is shown separately from settled service/retail sales. A gift-card refund returns stored value without being counted as a second cash refund. CSV summary fields use integer cents and make the same distinction; per-method rows describe applied/returned tender.

Owner, manager and reception can manage salon-wide gift purchases within their sales permissions. Professionals see their own created/owned cards; clients see their own purchases or cards associated with their client profile. Reissue, expiry changes and refunds require owner/manager permissions. Movement history is paginated and excludes bearer codes and other clients' identities.

Local verification uses synthetic cards, accounting records and fake bank responses. No real payment, refund or gift delivery has been sent. Bonos, memberships, loyalty and promotions remain separately tracked in FEATURE-EXPANSION.md.
