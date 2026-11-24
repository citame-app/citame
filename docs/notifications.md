# Notifications: operator guide

Design and guarantees: [ADR 0010](adr/0010-notifications-and-reminders.md). This page is what you need to run it.

## What gets sent

| When                                                | Kind                                        | Category      |
| --------------------------------------------------- | ------------------------------------------- | ------------- |
| Appointment booked (any channel: web, desktop, MCP) | `confirmation` (with `.ics` calendar entry) | transactional |
| Appointment moved to another time or staff member   | `rescheduled` (with `.ics`)                 | transactional |
| Appointment cancelled                               | `cancellation`                              | transactional |
| First lead time before the start (default 24 h)     | `reminder_24h`                              | reminder      |
| Second lead time before the start (default 2 h)     | `reminder_2h`                               | reminder      |

Lead times are owner settings (Admin, Settings, Reminders; API: `PATCH /admin/settings` with `reminderFirstLeadMinutes` / `reminderSecondLeadMinutes`, 5 to 20160 minutes, `null` = off). A whole number of days keeps the same clock time in the salon timezone across DST. They apply to appointments booked or moved after the change.

Times in messages are always in the salon timezone. Language comes from the client's preference (account, Notifications), else `NOTIFY_DEFAULT_LOCALE` (`en` or `es-AR`).

## Turning it on

Nothing is sent by default. Two switches:

1. Configure appointment email in **Settings → Email delivery**, SMS with Twilio, or [WhatsApp Business](whatsapp-business.md).
2. A worker: `NOTIFY_WORKER_ENABLED=true` (inside the API process) **or** run `bun run worker` / `docker compose --profile worker up -d worker` (keep the flag `false` on the API in that case, though running both is safe under normal operation: leases coordinate claims; crash recovery remains at least once).

Scheduling happens regardless (rows are written with every booking), so enabling the worker later delivers what is due; reminders whose time passed while it was off are still sent if the appointment has not started (confirmations for appointments that already started are skipped).

### Appointment email delivery

An owner can inherit the deployment's SMTP sender, disable appointment email, or configure SMTP, Gmail / Google Workspace, or Resend in **Settings → Email delivery**. Save and send a test message before enabling operational reminders. See [operations.md](operations.md#appointment-email) for provider requirements. Account-security email uses the deployment SMTP settings.

### Environment

| Variable                                                    | Default                                  | Meaning                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NOTIFY_WORKER_ENABLED`                                     | `false`                                  | Run the worker in the API process.                                                               |
| `NOTIFY_EMAIL_PROVIDER`                                     | `none`                                   | `none` or `smtp`.                                                                                |
| `SMTP_URL`                                                  |                                          | `smtp://user:pass@host:587` (`smtps://` for implicit TLS). Required for `smtp`. Secret.          |
| `NOTIFY_EMAIL_FROM`                                         | `Sisters of Beauty <no-reply@localhost>` | Sender. Use an address on a domain you control (SPF, DKIM, DMARC).                               |
| `NOTIFY_SMS_PROVIDER`                                       | `none`                                   | `none` or `twilio`.                                                                              |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`    |                                          | Required for `twilio`. `TWILIO_FROM` is an E.164 number or a `MG...` messaging service. Secrets. |
| `NOTIFY_DEFAULT_LOCALE`                                     | `en`                                     | `en` or `es-AR`.                                                                                 |
| `NOTIFY_PUBLIC_URL`                                         | `BETTER_AUTH_URL`                        | Public origin used in links (the web app).                                                       |
| `NOTIFY_POLL_INTERVAL_MS`                                   | `5000`                                   | Idle poll interval.                                                                              |
| `NOTIFY_BATCH_SIZE`                                         | `10`                                     | Jobs claimed per poll.                                                                           |
| `NOTIFY_VISIBILITY_TIMEOUT_SECONDS`                         | `120`                                    | Lease of a claimed job; keep it well above the slowest send.                                     |
| `NOTIFY_MAX_ATTEMPTS`                                       | `5`                                      | Attempts before dead-lettering.                                                                  |
| `NOTIFY_BACKOFF_BASE_SECONDS`, `NOTIFY_BACKOFF_MAX_SECONDS` | `30`, `3600`                             | Exponential backoff bounds (with jitter).                                                        |

## Account security emails

Verification, password reset, existing-account notices and staff invitations use a separate durable `account_email_outbox`. The API commits an encrypted message before returning, then delivers without waiting for SMTP. Its account-mail worker starts whenever SMTP is configured, independently of `NOTIFY_WORKER_ENABLED`; the standalone worker also processes these jobs. Appointment reminders still need one of the worker switches above.

Jobs survive API restarts. Concurrent workers use leased, fenced claims and renew leases while sending. Delivery is **at least once**: an SMTP acceptance followed by a crash can produce a duplicate. Retries stop at `NOTIFY_MAX_ATTEMPTS` or when the action link expires. The per-kind/mailbox 60-second throttle and idempotency survive restarts. Terminal jobs erase their encrypted payload; housekeeping removes sent/skipped rows after `REMINDER_RETENTION_DAYS` and failed rows after `DEAD_LETTER_RETENTION_DAYS`.

Owner queue stats include `accountEmails`; Prometheus exposes `sob_account_email_queue{status="pending|processing|sent|failed|skipped|cancelled|overdue"}`. To investigate, query only metadata: `SELECT id, status, attempts, last_error, scheduled_for FROM account_email_outbox ORDER BY created_at DESC LIMIT 20;`. Safe error codes include `delivery_retry`, `delivery_failed`, `attempts_exhausted`, `link_expired` and `payload_unreadable`. Failed/expired payloads are erased, so request a fresh verification/reset/invitation instead of requeueing a terminal account-email row.

Encryption derives from `BETTER_AUTH_SECRET`. Drain pending mail before a planned rotation; after rotation old ciphertext cannot be delivered, and users must request new action links. Keep the same secret on API and standalone workers.

## Local development with Mailpit

```sh
docker compose --profile mail up -d mailpit      # SMTP 127.0.0.1:1025, inbox http://localhost:8025
export NOTIFY_EMAIL_PROVIDER=smtp SMTP_URL=smtp://localhost:1025 NOTIFY_WORKER_ENABLED=true
bun run --cwd apps/api dev
```

Book an appointment as a client whose profile has an email: the confirmation shows up in Mailpit within a poll interval. To see a reminder immediately, move its time: `UPDATE reminder SET scheduled_for = now() WHERE kind = 'reminder_24h';`.

## Operating it

- Queue depth: `GET /admin/notifications/stats` (owner session): counts per status plus `overdue` (pending for more than five minutes: the worker is down or stuck) and this process's counters. Prometheus exposition is available at the protected `/metrics` endpoint (see [operations.md](operations.md)).
- Logs: JSON lines, `component: "notifications"`, with `reminderId`, `kind`, `channel`, `attempt`, `workerId`. No addresses or bodies.
- Failed messages (dead letters): `SELECT id, kind, channel, attempts, last_error FROM reminder WHERE status = 'failed';`. After fixing the cause, requeue a failed row without a WhatsApp dispatch marker with `UPDATE reminder SET status = 'pending', attempts = 0, scheduled_for = now() WHERE id = '...' AND status = 'failed' AND whatsapp_dispatch_at IS NULL;`. A marked WhatsApp send may already have reached the client. Review its delivery status in the WhatsApp desk.
- Why was a message not sent? `SELECT kind, channel, last_error FROM reminder WHERE appointment_id = '...' AND status = 'skipped';` Reasons: `channel_disabled`, `opted_out`, `no_address`, `invalid_phone`, `appointment_not_booked`, `appointment_gone`, `already_started`, `not_cancelled`, `client_gone`.
- Crash safety: kill the worker at any time. An unmarked job becomes eligible again when its lease expires, up to the attempt limit. A marked WhatsApp job with an interrupted outcome is reported as delivery unknown. A confirmed WhatsApp rate limit retries with bounded backoff. SIGTERM waits for the job in flight.
- Rotating `BETTER_AUTH_SECRET` invalidates existing unsubscribe links and queued account-email ciphertext (see above).

## Opt-out

- Reminder emails include a footer link and `List-Unsubscribe` / one-click headers. The link needs no login, opens a confirmation page (it never changes anything on `GET`) and switches **email reminders** off. Confirmations, changes and cancellations still arrive.
- Clients manage every switch in Account, Notifications: per channel (email, SMS, WhatsApp) and category (booking messages, reminders), plus message language.
- Choices are checked at send time, so they also apply to appointments already booked.

## SMS: regulatory checklist

Texting people is regulated and the rules depend on where you and your clients are. This software gives you the mechanisms; it does not make you compliant. Before enabling SMS:

- **Consent.** SMS is off for every client until they switch it on in their account; that switch is the recorded opt-in (`notification_preference` row with its timestamp). Do not bulk-enable it. Argentina: the Ley 25.326 (personal data) and the Registro No Llame (Ley 26.951) are the usual references. EU: GDPR and ePrivacy. US: TCPA and carrier 10DLC registration. Verify the current local rules with a lawyer.
- **Opt-out (STOP).** Reminder SMS end with "Reply STOP". Twilio handles STOP on its numbers and blocks further sends (the API then answers with an error that becomes a dead letter); the app does not yet receive the webhook to flip the in-app switch, so also honour opt-outs received other ways by switching the client's SMS preference off (account, or `notification_preference`).
- **Sender identity and registration.** Many countries require a registered sender id or number and message templates (US 10DLC, India DLT, etc.). Argentine and EU numbers have their own carrier rules; configure it in your Twilio account.
- **Content.** Messages carry only salon name, local date and time, no personal data beyond what the client booked. Keep them transactional or reminder-only: no marketing without separate consent.
- **Numbers.** Only E.164 numbers (`+5491155550000`) are texted; anything else is skipped as `invalid_phone`.
- **Cost and abuse.** The queue is bounded by bookings, but set a spend limit in the provider account.

## Email deliverability

Use a sender on your own domain with SPF, DKIM and DMARC set up at your relay; without them reminders land in spam. Mailpit and `no-reply@localhost` are for development only.

## Campaign SMS tests

Set `NOTIFY_CAMPAIGN_TEST_SMS_TO` to a number controlled by the centre in E.164 format and configure Twilio with `NOTIFY_SMS_PROVIDER=twilio`. An owner with a verified account email can open a saved SMS or optimized draft in Web or Desktop, choose **Review recipients** and send one test. Citame shows the last four digits of the configured destination. The test goes directly through the provider and creates no audience deliveries. When the provider outcome is uncertain, check the displayed phone before explicitly sending a replacement.

## What is verified and what is not

Verified by automated tests: scheduling and DST maths, transactional hooks (REST, sync push and service/MCP path), worker claims, retries, dead letter, crash recovery and many-workers-send-once against real Postgres with a fake provider, SMTP delivery against a real local SMTP server, Twilio request shape against a stub, templates, signed links, preferences, opt-out, and the web pages (unit tests, Playwright with axe at two viewports, light and dark). **Not verified:** delivery through a real relay or the real Twilio API.
