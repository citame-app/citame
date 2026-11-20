
## WhatsApp delivery exception

WhatsApp Cloud API accepts a callback correlation value but does not deduplicate sends using
that value. The worker renders the approved notification, then persists a dispatch marker just
before contacting Meta. After a crash or an ambiguous provider response it does not send the same
notification again. A crash between claiming dispatch and sending can therefore leave a notice
unsent. The job is reported as delivery unknown, and a signed Meta status can later settle the
delivery. This choice prioritizes avoiding duplicate appointment notices. SMTP and SMS retain
their existing retry behavior.

Timed WhatsApp reminders also have a unique reservation-start key for active or dispatched jobs.
Appointment metadata changes and repeated rule saves keep the same key. A changed appointment
start can schedule a new reminder, and rule changes can restore a withdrawn job that never
started delivery.
