# Appointment start windows and last-minute offer terms

Under **Sales & register → Gift cards & rewards → Loyalty & promotions**, owners/managers can enable appointment-start conditions on a service promotion. These conditions are optional; existing codes keep their original payload and behavior. Timed offers apply only to appointment service lines, never a counter sale without a booking.

Select at least one weekday, an inclusive local start and an exclusive local end. These are appointment **start** times in the salon timezone, rather than the payment time or the end of the treatment. For example, Monday 10:00–13:00 includes a 10:00 start and excludes a 13:00 start. The explicit end-of-day option represents 24:00. Overnight windows need separate offers. Both occurrences of a repeated daylight-saving local hour follow the same local rule; an absent hour cannot be invented.

The optional last-minute bound is 1–168 whole hours. Eligibility measures the interval from the appointment's original creation to its proposed start. Waiting until checkout does not make an advance booking eligible. Blank permits advance bookings. For a lead-only offer, choose every weekday and 00:00–24:00. Existing validity instants, usage limits, per-customer quotas, minimum spend, caps and service restrictions still apply.

The receipt preview displays the complete weekday/start/zone/lead conditions before explicit application. Applying a timed offer requires the reviewed promotion revision. An edited offer needs a fresh preview even when the saving in cents is unchanged. The accepted receipt stores its own timing terms and timezone; later offer edits, archive or salon timezone edits cannot rewrite them.

Moving a discounted visit must satisfy the saved weekday, start window and original booking lead. Staff notice overrides do not bypass this rule. A rejected move retains the original appointment and discount. Choose another qualifying time or ask the salon to review the appropriate cancellation/new-booking process; the application never silently removes the discount, reprices a visit or creates a new charge. Cancelling an unfulfilled rewarded visit retains the established quota/receipt/refund behavior.

Unknown editor responses retain the exact original submission for retry. Fields freeze until retry or an explicit confirmed discard/reload. A successful original edit can make a same-revision retry stale; reload the current record before changing it. No draft is placed in browser storage. Local social artwork and captions include all these conditions and keep the existing fit/revision checks.

Apply migration `0039_robust_ozymandias.sql` before starting this API. Its nullable `checkout_reward.appointment_timing` preserves legacy receipts. Existing receipt → scheduling → calendar → customer locking also serializes applying a discount with rescheduling. The API, MCP and offline replay share the appointment update guard; older native clients receive the established `invalid_state` rejection with the saved-condition explanation.

Timed codes can be verified on an **unpaid receipt** before a payment attempt and during the [online booking review](booking-promotions.md), which recalculates protected deposits. Showing offers automatically in public availability remains pending.

Verification uses synthetic appointments and prices, including original-booking lead boundaries, local weekdays, exclusive ends, DST, changed quote revisions, allowed/rejected moves and frozen terms after an offer is disabled. Browser journeys cover uncertain creation recovery, explicit review/application, preserved receipts, Spanish, touch targets, accessibility and overflow. No real bank or external message is involved.
