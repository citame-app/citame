# Reviewed duplicate client profiles

Owners and managers can open a client detail and choose **Review duplicate profiles**. Save or discard other profile edits first. Contact/name matches are suggestions, including normalized historical contacts. A shared family phone or email is never proof that two people are the same.

Choose the other profile, explicitly choose which profile survives, and select **Review identity link**. Review both contacts, original private notes, booking restrictions and history counts. Confirm that both records describe the same person before selecting **Join these profiles**. An account-linked profile must survive; the salon cannot join two login accounts. The surviving contact details are retained. Links cannot be undone in this interface.

## Preserved history and value

Original appointments, receipt lines, paid gifts, passes, point lots, expiry dates, refunds, form statements and review permissions retain their original client ids. No payment, point credit or funded visit is created by a merge. The account attached to the survivor can access the bounded group's own records, and eligible points and paid visits are available across that identity. Existing staff sales/calendar restrictions remain effective.

The directory and CSV export show one survivor. Search and CSV duplicate review recognize historical contacts without reimporting another profile. Original names, contacts and private notes remain labelled in **Original profile history**. Opening an old profile shows a link to the current survivor and disables new profile edits without silently discarding a contact draft.

Blocked access wins over normal or trusted access. Tags are combined, with at most twenty tags; a group is limited to twenty profiles and twenty active private photos. Resolve exceeded limits explicitly before linking. Team members can manage historical photos through the surviving profile; their original owner and private storage permissions remain unchanged.

Historical form responses remain available as private history. They never satisfy a new booking under the surviving subject automatically. A fresh booking needs its own applicable current form review. Existing waitlist requests retain their original subject, remain visible, and become unavailable for new offers; review and submit a new request under the survivor. Existing bookings retain their original identity and can still be managed by their authenticated owner.

## Consent and delivery

Notifications resolve the current surviving contact. A prior explicit opt-out in either profile suppresses that channel/category; merging never opts a client into SMS or marketing. A fresh authenticated preference change supersedes earlier group choices. An older signed unsubscribe link still disables reminders for the current identity. Already authorized recurring bank mandates remain bound to their original account and consent; linking an unregistered historical profile does not authorize a new recurring charge.

Review/photo publication and social permissions remain independent. A withdrawn statement stays withdrawn. Public review availability also respects deletion of the surviving profile. No actual delivery or bank charge is performed by the merge.

## Recovery, sync and concurrency

If contacts or counts change, the operation requires a new preview and confirmation. An uncertain response freezes the original pair, reviewed hash and request id in the current tab. **Recover this merge** retries that exact operation. A later expired session keeps the original request; sign in in the offered separate tab and return to recover. Leaving the review discards this in-memory recovery packet, so check the surviving profile before attempting a different operation. Private notes and recovery packets are not stored in browser persistence.

Sync retains historical aliases and their `mergedIntoId` link. The desktop replica accepts older payloads without the optional link, removes aliases from new-booking pickers and preserves its cursor, queued proposals and historic joins. A stale offline proposal is rejected as a conflict with instructions to review the surviving client; it is never silently reassigned.

Migration `0040` adds bounded identity traversal, immutable links and actor-scoped merge receipts. Application operations serialize merges, lock roots in deterministic order and recheck after lock waits. Monetary writers lock the current root before spending group value, retaining original FIFO lots and refund provenance. Inventory locks precede client locks for retail receipts. Raw SQL must insert the receipt before its paired link in one transaction; unpaired links/receipts, rewriting, cycles and groups over twenty are rejected by database constraints.

## Verification

The complete API suite passes 1,049 tests, including twenty new merge/constraint cases. Those twenty also pass on pinned Bun 1.4.4 in the read-only production API image. The full web suite passes 761 tests; contracts 160, database 47 and scripts 27 pass. Desktop tests execute 132 cases, with four environment-dependent cases explicitly ignored; Clippy passes. Four host and four read-only production-image mobile/desktop light/dark browser workflows pass, including changed contacts, uncertain/401 recovery, original visit identity, Spanish, axe and long-name overflow checks. Eight existing private-photo/CSV and eight intake-form browser regressions also pass. The final recovery link is verified in the rebuilt production workflow; its fixture container is absent after teardown.

All operations use isolated synthetic test data. No real client data was merged and no provider was enabled.
