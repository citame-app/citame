# Sales reports and staff commissions

Open **Sales & register → Financial reports & commissions**. The owner or a manager sees the salon's financial summary and can choose a professional. A staff member opens **My commissions** to see only their own earnings and payout history. Clients cannot access these records.

Use **Sales & register → Unpaid appointments** in the web or desktop app to collect by appointment date. Authorized cashiers can still collect or reconcile an appointment assigned to an inactive professional. The appointment and receipt retain that professional's attribution.

## Commission rules

The owner or a manager configures separate service and retail percentages for each professional. The rates apply at full settlement, after allocating discounts and excluding included tax. Tips and custom items do not earn commission. Missing rules mean no commission; historical settled receipts do not retroactively acquire earnings when a rule is later created. Each accrual stores its original base, rate and integer amount, so later rule or catalog edits do not rewrite earnings.

For appointments, attribution follows the booked professional. For a new retail sale, the owner, a manager or reception can choose a professional; professional sales are attributed to their own profile. An unassigned sale earns no staff commission. Retail prices, costs and taxes come from the server's catalog snapshot.

Original commissions use integer division rounded down to a cent. After a refund, the retained fraction of the sale determines the current net commission, rounded to the nearest cent. Excess bank captures never increase commission above the original amount. Partial payments accrue no commission until the whole checkout is paid.

## Payout records

**Record completed payout** records money already paid to the professional externally. It does not initiate a bank transfer or remove cash from the register. Enter a traceable reference. If paid from the cash drawer, also record the actual drawer withdrawal with its reason so the physical register remains correct.

Duplicate requests with the same key return the existing payout. Concurrent payout requests cannot both spend the same outstanding balance. A later customer refund can make the outstanding balance negative; the statement shows that amount to carry forward against future earnings. Original accruals and completed payout records remain visible.

Commission and payout histories paginate independently. CSV export explicitly exports the currently visible commission rows, including original and current adjusted amounts, integer cents, currency and dates. User-entered text is escaped to prevent spreadsheet formula execution.

In Desktop, open **Reports → Commissions** to view both histories, the balance and the CSV for the current
commission page. Owners and managers can select a professional. Other staff with the commerce
permission see their own statement. Desktop refreshes the view on committed checkout or payout
changes while connected.

Owners and managers can edit rates and record payments already made through **Reports → Commissions**
in Desktop. Rates use the version and database generation read when the editor was opened. A version
conflict requires reopening the current policy. Desktop saves the reviewed payout with its request
key before sending it. If the outcome is uncertain, reopen the payout for the same professional
and retry the saved request. That retry uses the original reference, amount and key. A database
restore requires reviewing the statement from the current generation before retrying the old
request. Confirm the reconciliation to bind the same payment and key to the restored generation.
If the payment was already recorded separately, use **Verify this existing payment** on its dated
ledger entry. Desktop clears the local request only after the server verifies the selected entry
against the saved professional, amount and reference. Reviewed writes send the same record back
for the same request key and reject a second entry with the same professional, amount and
reference. Recording a payout only adds an accounting entry.

## Financial summary

Dates are inclusive salon-local calendar dates, with a maximum range of 366 days. Collections and completed refunds are grouped by their confirmation time. The settled-sale totals, included tax, tips and known retail costs use full-settlement time. These are different measures: a partial collection can occur before the sale appears in settled totals, and a refund can occur in a later reporting period.

Retail unit costs are snapshots. Unknown costs are counted separately and never silently treated as known zero costs. The cost total describes stock sold; physical returns remain separate inventory movements. The summary is not a profit statement or certified fiscal/payroll system.

The owner or a manager can inspect collections/refunds per payment method and cash sessions opened in the selected date range, including counted differences, and export the summary to CSV. Financial mutations invalidate receipt, inventory and accounting caches together. Financial screens also refresh when reopened, on focus and every 30 seconds.

In Desktop, open **Reports → Financial reports** to use the same summary. Apply a date range to see
EUR totals, payment method amounts and cash sessions. The optional professional filter limits
amounts to that attribution. Cash sessions are shared across the team, so the history is shown
for the unfiltered team only. Desktop refreshes the open report when the connected replica advances.
The CSV uses the same metric, payment method and cash session columns as the Web report.

Migrations `0011_staff_accounting.sql` and `0012_backfill_checkout_attribution.sql` add the ledgers and prepare previously open receipts. The upgrade retains settled historical totals and allocates discounts/tax on unfulfilled open receipts using exact integer arithmetic. No bank transfers or real charges are performed by local verification.

Gift-card tender is prepaid value, not a second collection of cash. The summary excludes gift redemption/refund from new-money totals and excludes gift purchases from settled service/retail sales. Gift value issued and applied/returned are separate metrics; CSV method rows describe applied and returned tender.
