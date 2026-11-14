# ADR 0010: Notifications, reminders and the job queue

Status: accepted (Phase 7)

## Context

Clients need a confirmation when they book, reminders before the appointment, and notice when it is moved or cancelled, by email and optionally SMS. The messages must go out exactly when they should, never twice, never after the appointment was cancelled, and never to someone who opted out. Appointments are written from four places (REST, sync push from the desktop, MCP tools, and the owner's calendar), all through `createAppointment` and `updateAppointment`.

## Decisions

### Postgres is the queue; Valkey is not on the delivery path

The plan listed a "Valkey-backed queue". We built the queue on the `reminder` table instead, claimed with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`:

- **Transactional scheduling.** A reminder row is inserted in the same transaction as the appointment change. A rolled-back booking leaves nothing, a committed cancellation can never lose its notice. With Valkey the enqueue would be a second write that can fail after the commit (or the reverse), which needs an outbox anyway. The table is that outbox, so the queue and the outbox are one thing.
- **One source of truth.** Status, attempts, last error, provider message id and the unique key live next to the appointment. Operators can answer "was this client reminded?" with SQL. Valkey lists and sorted sets would need reconciling with it.
- **Scale is small.** A salon produces tens to a few thousand messages a day. `SKIP LOCKED` on a partial index (`reminder_due_idx`, only `pending`/`processing` rows) is far below what Postgres handles.
- **Cost accepted:** workers poll (default every 5 s, immediately again when a batch was full), so a message leaves at most about one poll interval after it is due. Valkey wake-ups (pub/sub nudge after commit) would cut that to milliseconds, but a 5 s delay on a reminder is irrelevant and a lost nudge would be harmless; it stays a possible later optimisation, not a dependency.

Valkey still carries sessions, rate limits and the sync SSE fan-out; the worker does not need it.

### Rows, kinds, and the at-most-once key

`reminder(appointment_id, kind, channel, appointment_version, scheduled_for, status, attempts, last_error, provider_message_id, locked_until, locked_by, sent_at)`.

- Kinds: `confirmation`, `reminder_24h`, `reminder_2h`, `cancellation`, `rescheduled`. The two reminder kinds are the first and second reminder slots; their lead times are salon settings (defaults 1440 and 120 minutes, `null` turns one off).
- Channels: `email`, `sms`. Statuses: `pending`, `processing`, `sent`, `failed` (dead letter), `skipped`, `cancelled`.
- `UNIQUE (appointment_id, kind, channel, appointment_version)` is the idempotency key of scheduling: inserting is `ON CONFLICT DO NOTHING`, so replaying a sync mutation or retrying a request cannot create a second message. The version is part of the key so that moving an appointment legitimately issues a new reminder for the new time while the old ones are withdrawn.
- The table is not in the sync triggers: notifications are server-side state and the desktop replica never sees them.

### Scheduling

`planReminders` (pure) computes the times. A lead that is a whole number of days counts **calendar days in the salon timezone** (the client booked for 09:00 hears from us at 09:00 the day before, across DST changes; a wall-clock time that does not exist moves forward, an ambiguous one takes the earlier occurrence). Shorter leads are elapsed minutes. Reminders already due at scheduling time are dropped, so a late booking never receives a "24 hours" reminder.

The hooks live in the appointment service, inside its transaction:

- create: confirmation plus the reminders.
- slot or staff changed: pending rows are withdrawn (`cancelled`), a `rescheduled` notice and a fresh schedule are issued under the new version.
- cancelled: pending rows withdrawn, a `cancellation` notice enqueued.
- completed or no-show: pending rows withdrawn, no notice.
- notes-only edits change nothing.

Rows are created per channel for which the client has an address (email, phone). Consent and opt-outs are evaluated when sending, not when scheduling, so a client who opts in to SMS later, or opts out of email, is respected for appointments already booked. Changing the lead times in settings affects appointments booked or moved afterwards.

### The worker

- **Claim:** one transaction dead-letters expired leases that already used every attempt, then selects due rows (`scheduled_for <= now`, `pending`, or `processing` with an expired lease) `FOR UPDATE SKIP LOCKED`, and marks them `processing` with `attempts + 1`, `locked_until = now + visibility timeout` and `locked_by`. Concurrent workers get disjoint rows; a worker that dies leaves a row that becomes claimable when its lease expires.
- **Fencing:** the final write (`sent`, `skipped`, `failed`, retry) only applies while the row is still `processing` and `locked_by` is the writer. A worker that stalled past its lease cannot overwrite the new owner; the event is counted as `lease_lost`.
- **Send-time checks:** the worker re-reads the appointment, client, staff, services and settings; skips (with a reason in `last_error`) when the channel is disabled, the appointment is gone, not booked (or, for `cancellation`, not cancelled), already started, the client has no address (or an SMS number that is not E.164), or the preference is off.
- **Retries:** transient errors reschedule the same row with `delay = min(base * 2^(attempt-1), max)` and equal jitter (`delay * (0.5 + 0.5 * random)`); defaults base 30 s, max 1 h, 5 attempts. A permanent provider error (bad recipient, rejected content) or the last attempt moves the row to `failed`: the dead letter, kept in the table with its error, visible in `/admin/notifications/stats` and metrics. Requeueing is `UPDATE reminder SET status = 'pending', attempts = 0 WHERE id = ...`.
- **Runtime:** in the API process behind `NOTIFY_WORKER_ENABLED` (default off) and as `bun run worker` (`apps/api/src/worker.ts`, same code). Any number of processes can run at once. `stop()` stops polling and waits for the job in flight (SIGTERM/SIGINT).
- **Observability:** one JSON log line per event with ids only (never addresses or message bodies). In-process counters (`claimed`, `sent`, `skipped`, `retried`, `dead_lettered`, `lease_lost`, `errors`) with a Prometheus text renderer, ready for Phase 8; `GET /admin/notifications/stats` (owner) reports queue depth per status plus `overdue`.

### Delivery semantics: honest guarantees

Scheduling is **exactly-once** (unique key). Sending is **at-least-once with an idempotency key**, which becomes exactly-once only when the provider honours the key:

- A crash after the provider accepted the message but before the row is marked `sent` makes the lease expire and the next worker send the same row again. The key is the reminder id. The in-memory fake provider (and any HTTP provider that supports idempotency keys) records one delivery; tests cover this case and the many-workers case.
- **SMTP has no idempotency key.** The adapter sets a deterministic `Message-ID` (`<reminder-id@domain>`), which helps a human or a filter spot a duplicate but is not guaranteed to be deduplicated. In that crash window a client can get the same email twice.
- **Twilio's documented Messages API has no idempotency key either**, so SMS has the same window.
- The opposite failure (marking `sent` before sending) would lose messages, which is worse for reminders and confirmations. We chose a rare duplicate over a silent loss.
- A reminder is checked right before sending, so a cancellation committed in the few milliseconds between the check and the provider call can still be followed by the reminder and then the cancellation notice.

### Providers

`EmailProvider` and `SmsProvider` are small interfaces (`send(message) -> { messageId }`, errors classified as transient or permanent).

- **Email: SMTP through `nodemailer@10.3.1`** (self-hostable, works with any relay, Postfix, Mailpit in dev). `smtp-server@3.21.3` is a dev dependency: the adapter is tested against a real in-process SMTP server (no real mail leaves the machine). An HTTP provider such as Resend is a ~40-line adapter if an operator wants provider-side idempotency.
- **SMS: interface plus a Twilio REST adapter** (plain `fetch`, no SDK), disabled by default (`NOTIFY_SMS_PROVIDER=none`). Tested against a local stub only.
- Providers `none` mean the channel is off and its rows are marked `skipped: channel_disabled`. Nothing is ever sent until an operator turns the worker on and configures a provider.

### Preferences, consent and opt-out

- `client_profile.locale` (`en` or `es-AR`, null = salon default `NOTIFY_DEFAULT_LOCALE`) chooses the template language.
- `notification_preference(client, channel, category, enabled)` with two categories: **transactional** (confirmation, cancellation, rescheduled: messages about a booking the client made) and **reminder**. Defaults: email on for both, **SMS off** (switching it on is the consent to be texted).
- **Unsubscribe:** reminder emails carry a signed link, `v1.<payload>.<HMAC-SHA256>` over `{clientId, channel}` keyed from `BETTER_AUTH_SECRET`, no expiry (an unsubscribe link must keep working), able only to switch reminders off. `GET /notifications/opt-out?token=` only describes (mail scanners and link previews prefetch URLs, so a GET must never change anything); the web page confirms with a button (`POST`). The `List-Unsubscribe` header plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) points at `/api/notifications/opt-out?token=` and the POST accepts the token in the query string. Rotating `BETTER_AUTH_SECRET` invalidates links already sent.
- Transactional messages have no unsubscribe link (they are service messages) but the client can switch them off in the account.

### Privacy

A message contains only the recipient's own appointment: salon name, services, staff display name, local time in the salon timezone, links. Never the notes (client notes and staff notes), other clients, contact details, or any token other than the recipient's own opt-out. Logs and audit entries hold ids and counts, never addresses, phone numbers or bodies. SMTP credentials and Twilio tokens come from the environment and are never logged. Audit entries: `notifications.preferences`, `notifications.opt_out`.

## Consequences

- No Valkey dependency for delivery and no second system to reconcile; polling latency of seconds.
- Duplicates are possible only in the crash window between provider acceptance and the status write, and only for providers without idempotency keys.
- A failed or skipped row is data: debugging is a `SELECT`.
- `reminder` rows grow with bookings. Housekeeping (deleting old `sent`/`skipped` rows) is not implemented; rows go with their appointment (`ON DELETE CASCADE`) and are small.

## Not done / follow-ups

- Real SMTP relays and real Twilio were not exercised (credentials needed): only local protocol-level tests.
- Email verification and password reset (listed as Phase 7 gaps in ADR 0003 and 0005) are not part of this change; the SMTP adapter is what they will use.
- SMS inbound `STOP` handling is the carrier's/Twilio's (on Twilio numbers it is automatic); the app does not receive webhooks, so a STOP does not flip the in-app SMS switch yet.
- Phone normalisation is strict: only E.164 numbers (`+54911...`) are texted, others are skipped with `invalid_phone`.
- Quiet hours (no messages at night) are not modelled.
