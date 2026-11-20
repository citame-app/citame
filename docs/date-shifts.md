# Dated shifts and reviewed copying

Owners and managers use **Team → Dates and shifts** to compare a week across the active roster. The table shows weekly hours, dated overrides and absence intervals in the salon timezone. The week stays in the URL, and selecting a professional opens their editor on that week. Absence reasons are available through the individual workflow. Professionals with access to their own calendar can inspect their own dates. Editing follows the existing schedule-administration permissions.

The weekly template remains the default. A particular date can instead be **Closed** or have **Custom hours**. **Use weekly hours** restores inheritance from the latest weekly template; it retains the date's revision, so an older review cannot overwrite a subsequent change. Dates that have no override retain their weekly hours. Editing is limited to today through the following 730 salon-local calendar days; past dates remain readable.

## Review before applying

Enter the date's ranges and choose **Review changes**. The review shows current and proposed hours for every target date, existing appointments that no longer fit and held waitlist offers that will expire. Applying does not move, cancel, reprice or otherwise change existing appointments. In GPUI, select **Open appointment** in the conflict list and use **Back to schedules** to continue the same draft. After changing the appointment, wait for synchronization and review the dates again. If the server rejects the appointment change, resolve it in the sync conflicts panel or explicitly review against the appointment currently on the server.

Up to eight non-overlapping ranges may be entered for a custom date. Touching ranges are permitted, and zero ranges means explicitly closed. Every start and end is a wall-clock time in the displayed salon timezone. Nonexistent local times at a daylight-saving transition are rejected; choose an actual time on that date. The normal booking notice, maximum advance window, time off, staff qualifications and resource limits still apply.

The live review binds source/target revisions, weekly hours, settings, affected appointments, time off and active offers. If a colleague changes these before applying, refresh and review the current dates. Draft edits remain visible after a failed read or write. Leaving a dirty date window requires discarding the edits explicitly. If the apply response is lost, retry the same review: its actor-scoped batch identifier prevents repeated writes, including after a colleague makes newer changes. A replay returns the current dated hours and preserves those newer changes.

## Copy a period

Save current edits before opening **Copy a period**. Choose the source start, one to seven days, the first target start and one to twelve target weeks. Source and target dates must not overlap, and each target date must be unique. Review lists every resulting target date, including closed days.

Copying freezes the effective source hours, combining custom dates and the source's inherited weekly template. The copied dates become explicit custom/closed dates: a later weekly-template edit does not change them. Restore **Use weekly hours** on those dates to resume inheritance. A source with more than eight ranges must be simplified or copied in smaller custom configurations; inherited weekly schedules remain fully readable up to their existing 56-range limit.

The source can be within two years before or after today. At most 84 target dates can be changed in one reviewed batch. A read window spans at most 366 consecutive days. Review rejects windows with more than 5,000 affected scheduled records instead of silently truncating conflicts. Each professional retains at most 5,000 dated-shift history rows; restoring weekly hours preserves the revision rather than deleting that history.

## Weekly working hours

In the web, open **Team** and select a professional’s hours. In GPUI, choose **Hours** on their row in **Team shifts**. Select a weekday and edit its ranges or leave it empty for a day off. Copy a day with active ranges to one or more weekdays, then save the whole weekly template. A date that follows the weekly schedule picks up the new hours. Dated overrides and existing appointments retain their saved times. After saving, review any appointments that no longer fit. Use **Open appointment** and return to the same weekly editor. Its conflict list refreshes after the appointment change leaves the sync queue.

Both editors save against the revision opened with the draft. A new edit or server restore invalidates older revisions. An outdated draft stays visible until you discard it and reload the latest schedule. Repeating a save while the requested schedule is already current adds no audit entry or sync changes. Desktop clients need a server that returns a weekly revision. The API accepts requests without a revision from older web clients and MCP.

## Shared booking and offline behaviour

Availability, ordinary/operator/MCP bookings, rescheduling, reviewed series, waitlist acceptance and the calendar's displayed working windows use the same effective date rules. Expiring an incompatible waitlist hold immediately releases its slot for availability and ordinary resource reservation. The bounded waitlist worker subsequently processes the expired offer and reconsiders the request. Schedule changes do not acquire queue-entry locks while holding the global scheduling lock.

The sync protocol includes scoped `date_shift` records, with a literal `null` for weekly inheritance and `[]` for a closed day. The desktop replica stores these separately and upgrades its SQLite schema without losing the cursor or queued changes. A connected desktop can review and apply a change for one date or copy a period through the same schedule API, with the same permissions and replay protection as the web editor. An applied batch has an immutable receipt. Account removal may clear its author reference without reattributing or deleting its history.

## Local verification

In GPUI, **Team shifts** reads the saved week from SQLite, with the last synchronized calendar permissions. Dates and professional names remain in view when scrolling. Enter a date as `YYYY-MM-DD`, then press Enter or choose **Go to week**. Pending local blocks are labelled until sync acknowledges them. Selecting a professional opens their native calendar on that week. **Edit shift** opens the individual date for a manager or owner with a connection. Choose **Copy…** on the professional’s row to use the displayed week as the starting point for a copy. This also works when viewing past weeks. The review shows the centre timezone, which dates inherit weekly hours, affected appointments and offers that will expire.

`bun run e2e:shifts` from `apps/web` uses the explicit isolated Postgres/Valkey/API fixture and the built web bundle. Build the web app first. The fixture resets its dedicated test database; it does not load production data or contact a bank or messaging provider.
