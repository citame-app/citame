# Reviewed service quotes

Current interactive web booking flows submit a quote identity for every selected service. A service's public `quoteHash` is a SHA-256 identity over its current public name, description, duration, cleanup time, price, currency and option metadata. It is an integrity tag for stale-review detection, not a payment authorization or a secret.

A booking can carry `serviceQuotes`, a map from each selected service UUID to its reviewed hash. The server requires an exact map for the selected services, verifies it before preflight and verifies it again after acquiring the scheduling/calendar locks. If any reviewed terms have changed, it returns `409 version_conflict` before creating the visit, its client profile or its notifications. Prices and durations still come from the server's service records. The hash also detects a direct data correction that changes duration/price without advancing the administrative revision.

The customer flow refreshes the catalog and returns to service selection with a clear message. It clears the old professional/time choice, so the customer reviews the new terms and chooses an appropriate slot again. The operator form keeps its draft, refreshes service/staff/availability data and uses the refreshed quotes on the next submission. Recurring previews accept the same optional fence and retain their stronger whole-series review hash.

The map is optional for compatibility with existing API, MCP and offline clients. Such clients retain their previous server-priced behavior; this change does not claim that an older client has reviewed a quote it did not submit. Public and sync service DTOs expose `quoteHash` so clients can adopt the fence. Waitlist offers separately bind their frozen service and deposit terms before acceptance.

Notifications in the mobile booking flow reserve space above the measured booking summary. A resize observer and breakpoint handling update this inset; unmounting the summary removes it. A stale-quote message must remain readable without blocking the next booking action.

## Verification

API tests cover changed prices, changed duration/cleanup, incomplete/unrelated maps, compatibility requests and a catalog update committed while a booking waits for the scheduling lock. Component tests cover quote map construction, operator retry after refresh and notification inset resize/cleanup. The real isolated option-booking browser test first reviews a €30 variant plus a €5 extra, changes the variant to €35, verifies the initial confirmation returns 409, then explicitly reviews and books the new €40 total. It runs on mobile/desktop and light/dark with Spanish selection, axe and overflow checks. No real bank is contacted.

MCP clients can copy the quote hashes from `list_services` and keep one request identifier for a booking intent. A retry returns the original booking even if current catalog prices have changed after it was created. Reusing that identifier with a different service sequence or note is rejected. Quote-conflict tool errors explicitly ask the agent to reload current terms and obtain customer review before retrying a new booking.
