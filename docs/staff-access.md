# Staff access profiles

The installation has five effective access levels. The owner account always retains full access, account administration and salon settings. Staff accounts use one of four operational presets:

| Access                 | Calendars                                    | Sales and register                                 | Catalog and costs            | Reports and commissions                               |
| ---------------------- | -------------------------------------------- | -------------------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| Owner                  | All; manage schedules                        | All; refunds and bank reconciliation               | Full                         | Full; configure commissions and record payouts        |
| Manager                | All; manage schedules                        | All; refunds and bank reconciliation               | Full                         | Full; configure commissions and record payouts        |
| Reception              | All; create and change bookings              | All sales; open/count/close register               | Read inventory; costs hidden | Operational booking reports; own commission statement |
| Professional (default) | Own; create/change bookings and own time off | Own attributed sales; no salon cash-balance access | Read inventory; costs hidden | Own booking reports and commission statement          |
| Restricted             | Own calendar and schedule, read only         | No access                                          | No inventory access          | No reports or commissions                             |

Only the owner can create accounts, change account roles or change access presets. Manager access does not grant those permissions or salon-settings administration. Professionals and reception retain client-directory access; restricted accounts have no client-directory access and do not receive client contact details in the appointment drawer.

Open **Team → professional → Staff access** as the owner. Choose the preset and save. Changes use an optimistic version so concurrent edits cannot silently overwrite each other. Existing sessions use the persisted profile on their next API request; signing in again is unnecessary. Reloading the web interface updates its navigation and controls. Owner/client account roles remain separate from staff presets; a staff preset cannot promote an account to owner.

Unlinked calendars can have their intended staff preset prepared, but a preset alone does not create a login. Accounts created through **Add staff** receive the professional preset by default. Changes are recorded in the audit log.

The API enforces the permission matrix for REST, shared booking/catalog policies and synchronization writes. Restricted accounts can read their own calendar and hours/time off, but cannot create/change appointments, notes or time off. Sync reads omit client-directory records when client access is disabled. Customer checkout routes enforce staff permissions as well, so choosing a different route cannot bypass restrictions.

The browser adapts navigation, calendar creation/drag/keyboard actions, appointment controls, staff schedule editing, inventory cost controls, cash operations and commission administration to the effective profile. This controls presentation; authorization still comes from the database-backed API principal. Offline data already downloaded to a device cannot be remotely unread; subsequent synchronization reads and writes enforce the current permissions.

Migration `0013_staff_access_presets.sql` gives existing staff the professional preset. This deliberately narrows the new sales ledger from salon-wide staff visibility to attributed own sales. The owner can select Reception where salon-wide sales and register management are required.
