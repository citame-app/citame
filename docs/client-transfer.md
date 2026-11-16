# Client CSV import and export

Owners and managers can use **Clients → Import clients / Export CSV**. Other access profiles cannot perform bulk transfer through either the interface or API. Downloads include private notes: keep them in an appropriately restricted location. Importing a contact does not create a login, send an invitation, merge profiles or grant marketing consent.

## Import

Download the blank template, choose a UTF-8 CSV file, or paste its contents. The format uses commas and supports quoted commas, doubled quotes, multiline notes and an optional UTF-8 BOM. Supported headers are `name`, `email`, `phone`, `notes` and `tags`; column order can vary. Names and at least one email/phone are required. Separate tags with semicolons. Each file is limited to 500 client records and 400,000 UTF-8 bytes; split larger migrations into reviewed batches. Unsupported headers are rejected, including an attempted consent column.

Review the preview before importing. New valid profiles are selected initially; selection can be cleared or changed. Invalid rows must be corrected in the source. Matching existing contacts and repeats within the file are skipped. An email matching one profile and a phone matching another are shown as conflicting contacts and cannot be imported. Matching ignores email case/surrounding whitespace and phone formatting; it is a conservative duplicate warning, not proof of identity or permission to combine records. Only selected, reviewed new records are added, atomically. Existing notes, labels, booking restrictions, account links and history remain untouched.

A changed matching directory invalidates the review. Review again before saving. Concurrent imports and walk-in booking creation share the salon scheduling coordinator during contact lookup/insertion. Ordinary contact edits and independently created login profiles can still introduce duplicate contacts; contacts are not a globally unique identity. Profile deduplication/merging is a separate, unfinished feature.

After a connection failure, retry the unchanged import. Its identifier and selected records are retained while the form remains open, so an already committed batch returns its original receipt without another insertion, even when the preview is now stale. Changing the file/selection creates a different request. A page reload does not retain the draft: check the directory before importing again. The receipt stores created profile IDs and counts, without retaining the original file or private text. Audit entries contain counts and actor identity. Private preview/export responses use `Cache-Control: private, no-store`.

## Export

Export includes **all matching active profiles**, independent of the visible directory page, with name, email, phone, notes and labels. Clear the search for the whole directory. The maximum is 5,000 matching profiles; a larger selection fails explicitly instead of returning a truncated list. Narrow the search for another batch. Deleted profiles, authentication data, financial balances and private booking-access reasons are excluded.

The downloaded CSV quotes every field and adds an apostrophe to spreadsheet-sensitive leading text. The `escaped_fields` column records exactly which values were protected, allowing this application's importer to restore original phone numbers/text without removing genuine apostrophes. Keep that column intact for a round trip. Exported files can exceed the import batch limits and may need splitting before reimport. Reimporting unchanged contacts produces skipped duplicates, not another copy of the profiles.

## Verification

Parser/API tests cover CSV quoting, byte/record limits, invalid rows, normalized and conflicting contacts, explicit selection, concurrent/stale imports, idempotent recovery, live owner/manager permissions, private audit metadata, searched export, formula protection and rejection of truncated exports. The browser workflow uploads an actual CSV, reviews Spanish rows, changes selection, loses the response after the real API commits, recovers the same import, downloads the searched export and reviews the exported file as repeated contacts. Four mobile/desktop and light/dark cases pass with axe and horizontal-overflow checks. Browser accounts/files belong to the isolated fixture and send no email or bank request.

Full local web verification passed 699 tests, contracts 138 and database 47. Forced type checks and repository lint passed. The full API suite passed 927 tests across 93 files, including the payment, resource, recurrence, waitlist, reward, permission and sync regressions.
