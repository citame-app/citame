# Forms and consent

Forms are private, optional configuration for the single Sisters of Beauty business. There are no automatically published health or legal templates. Supply the salon's approved wording before using a real consent form. Recorded confirmation is an authenticated checkbox acknowledgement with its author, source and time; it is not a handwriting capture or a qualified electronic signature.

## Configure and publish

Owners and managers use **Settings → Forms and consent**. Start a blank draft, choose a questionnaire or consent form, and enter the title, introduction, questions and service scope. Text, longer text, dates, explicit yes/no, numeric bounds, single/multiple choices and explicit consent are supported. Each question and choice has a stable identity, even after reordering. A consent form requires at least one required explicit-consent question.

Saving does not publish. **Review and publish** displays the exact saved wording before making a new immutable revision current. Unsaved changes must be saved first. Editing a draft leaves the published version and previous answers unchanged. A colleague's newer revision rejects stale writes; the local draft remains visible until an explicit discard/reload. Stopping a form removes it from new booking requirements and preserves its history. Publishing changed wording or reactivating an archived form creates another revision, including when returning to older wording.

Forms can cover all services or an explicit selection. A parent service's form also applies to its variants. Every active applicable form is shown during the final booking review. Optional forms can be skipped. A required form must have valid answers and explicit confirmation before a visit can be created. Zero and a literal **No** are valid answers; an unchecked required consent is not consent.

**Allow the team to record responses** defaults off. When enabled in the published revision, the team can record answers reviewed with the client and explicitly confirm permission to do so. This is labelled **Recorded by the team**, never as a client-authored statement. Otherwise the customer must complete the form in their authenticated web flow.

## Booking and recent responses

The current form revisions are checked under the same scheduling lock as booking. A publication during review requires a fresh review; client identity, appointment, private answers, resources, deposit creation and notifications roll back together on failure. Applicable service options are resolved before the check. Rescheduling an existing visit preserves the original record rather than rewriting its historical confirmation.

Normal bookings, reviewed recurring series, waitlist acceptance, MCP and offline replay share the required-form gate. A bounded recurring series explicitly shows that the supplied answers accompany all reviewed dates. Each association retains the original response capture time. Series review hashes include the current applicable form revisions.

A response to the current revision, captured within the preceding 24 hours and not in the future, can accompany another reviewed visit. Interactive flows offer an explicit choice to use the recent recorded response or complete another one. Required forms in compatibility/MCP/offline requests can use a recent human-completed response belonging to that same client; agents cannot submit invented inline answers through MCP. Older or foreign responses cannot satisfy a requirement. Completing a new account response does not itself book an appointment.

Booking retries retain the same visit identifier. Explicit form revisions, selected response identities and canonical answers are part of its fingerprint; a refreshable review hash is not. A lost response can recover the original visit. Changing or omitting an originally confirmed packet cannot silently replace it or create another copy with the same identifier. Appointment/MCP responses and ordinary sync changes contain no private answers.

## Private history and corrections

Clients read their own responses under **My account → Profile**; authorised team members read them in the client's record. The history list contains title, revision, author source and time. Opening a response loads the original frozen questions and answers. Responses cannot be edited or deleted through these workflows; a correction is another statement. The submission API can associate a new statement with an existing visit only when both belong to the same client.

Published revisions, answers and appointment associations have database immutability/ownership triggers. Account removal may clear the author's foreign key without deleting or reattributing the historical record. The first associated appointment is retained on the response; a separate immutable join records additional reviewed visits, including series. Archiving a form does not remove responses. Private routes use `private, no-store`; audit events record identifiers/source/counts, not question wording or answers. Answer drafts remain in component memory, with no browser-storage persistence. Marketing consent is separate.

Limits: 100 form definitions, 10 active forms, 30 questions/options per form/question, 1,000 responses per client and 50,000 across the salon. Each answer string is bounded to 4,000 characters. Limits reject explicitly rather than dropping excess content. Database/backups remain subject to the deployment's retention and access processes; this feature does not erase historical backups or supply an automated retention policy.

## Offline and native behaviour

Desktop can complete an applicable form while reviewing a waitlist offer. Operators can explicitly choose a recent response or record new answers when the form permits team responses. An optional form can be skipped. Questions and answers remain in memory during review. An unconfirmed request can be resent with the same answers and identity. The server rejects a review of superseded requirements and validates the current answers in the same transaction as the booking.

When connected, the Desktop calendar checks applicable forms before confirming a new visit. The same editor supports an existing client or a new client created with the booking. The server validates the reviewed service prices, current form revisions and replica generation. A lost reply can be checked by resending the same appointment identity and responses during the review. Private answers stay in memory until confirmation and stay outside the offline replica. From **Cloud management → Forms and consent**, connected owners and managers can manage the same drafts and published revisions in Desktop. Draft review shows the saved text, options, requirements and service scope before publishing. Private response history is available in Cloud.

Offline replay cannot bypass a required form. It records an actionable `intake_required` conflict and continues processing rather than endlessly retrying a deterministic validation failure. After a human completes the form, the operator may explicitly retry the proposal. If they booked in the web application, they should discard the old offline proposal to avoid a second visit. Native English/Spanish conflict instructions are included.

## Local verification

TDD regressions cover immutable revisions/answers/associations, own-client privacy, recent/current response selection, stale publication after lock waits, role demotion while waiting, canonical booking retries, series, held-offer acceptance, MCP and offline replay. React tests cover no/zero/required consent, subject changes, failed reads preserving drafts, explicit publication and stale-editor reload. Eight Chromium journeys cover customer and team responses across mobile/desktop and light/dark, EN/ES, actual private history, uncertain responses, axe and horizontal overflow. The publication flow also reproduces and protects against a success notice covering the dialog action.

Run the isolated browser fixture with `bun run --cwd apps/web build`, then `bun run --cwd apps/web e2e:intake`. It uses local Postgres/Valkey, synthetic questions and fixture accounts; no bank or real message is sent.
