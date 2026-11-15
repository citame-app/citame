# Sales reports and staff commissions

Open **Sales & register → Financial reports & commissions**. The owner or a manager sees the salon's financial summary and can choose a professional. A staff member opens **My commissions** to see only their own earnings and payout history. Clients cannot access these records.

## Commission rules

The owner or a manager configures separate service and retail percentages for each professional. The rates apply at full settlement, after allocating discounts and excluding included tax. Tips and custom items do not earn commission. Missing rules mean no commission; historical settled receipts do not retroactively acquire earnings when a rule is later created. Each accrual stores its original base, rate and integer amount, so later rule or catalog edits do not rewrite earnings.

For appointments, attribution follows the booked professional. For a new retail sale, the owner, a manager or reception can choose a professional; professional sales are attributed to their own profile. An unassigned sale earns no staff commission. Retail prices, costs and taxes come from the server's catalog snapshot.

Original commissions use integer division rounded down to a cent. After a refund, the retained fraction of the sale determines the current net commission, rounded to the nearest cent. Excess bank captures never increase commission above the original amount. Partial payments accrue no commission until the whole checkout is paid.

## Payout records

**Record completed payout** records money already paid to the professional externally. It does not initiate a bank transfer or remove cash from the register. Enter a traceable reference. If paid from the cash drawer, also record the actual drawer withdrawal with its reason so the physical register remains correct.

Duplicate requests with the same key return the existing payout. Concurrent payout requests cannot both spend the same outstanding balance. A later customer refund can make the outstanding balance negative; the statement shows that amount to carry forward against future earnings. Original accruals and completed payout records remain visible.

Commission and payout histories paginate independently. CSV export explicitly exports the currently visible commission rows, including original and current adjusted amounts, integer cents, currency and dates. User-entered text is escaped to prevent spreadsheet formula execution.

## Financial summary

Dates are inclusive salon-local calendar dates, with a maximum range of 366 days. Collections and completed refunds are grouped by their confirmation time. The settled-sale totals, included tax, tips and known retail costs use full-settlement time. These are different measures: a partial collection can occur before the sale appears in settled totals, and a refund can occur in a later reporting period.

Retail unit costs are snapshots. Unknown costs are counted separately and never silently treated as known zero costs. The cost total describes stock sold; physical returns remain separate inventory movements. The summary is not a profit statement or certified fiscal/payroll system.

The owner or a manager can inspect collections/refunds per payment method and cash sessions opened in the selected date range, including counted differences, and export the summary to CSV. Financial mutations invalidate receipt, inventory and accounting caches together. Financial screens also refresh when reopened, on focus and every 30 seconds.

Migrations `0011_staff_accounting.sql` and `0012_backfill_checkout_attribution.sql` add the ledgers and prepare previously open receipts. The upgrade retains settled historical totals and allocates discounts/tax on unfulfilled open receipts using exact integer arithmetic. No bank transfers or real charges are performed by local verification.
