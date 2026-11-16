# ADR 0014: Discrete funded visits and frozen membership periods

Status: accepted for packages and memberships. Opt-in automatic bank mandates are integrated separately from the visit-value ledger; see [membership operations](../passes.md).

A pass purchase creates an immutable, server-priced receipt and frozen contract. Settlement activates discrete visit units whose gross/tax allocations sum exactly to the paid period. A checkout redemption references its original unit, period, service line and payment. Refunding a redemption restores that unit; refunding the purchase reserves/retire unused units. An ambiguous bank return keeps those units held. Late excess captures never recreate previously returned visits.

All visit mutations lock contract then period, after the commerce checkout lock. Stable ownership, serial consumption and whole-unit purchase refunds prevent cross-checkout overspending and penny duplication. Membership periods derive directly from the original local billing anchor instead of chaining clamped dates. Manual renewal creates at most one future or pending period and never silently changes agreed prices or initiates a bank charge.

Receipts retain nominal service tender. Accounting recognizes funded allocation rather than nominal face value and excludes prepaid tender from newly collected cash. Commission return adjustments distinguish prepaid service lines from independently paid lines. This preserves receipts, avoids counting purchase and redemption twice and makes returns reversible without rewriting history.
