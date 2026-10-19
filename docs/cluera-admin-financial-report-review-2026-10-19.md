# Cluera staging Admin financial report review

The read-only report is backed by tracked migration [`20261019095719_cluera_admin_financial_report_read.sql`](../supabase/migrations/20261019095719_cluera_admin_financial_report_read.sql). The applied migration contains the exact reviewed proposal: two indexes and one `STABLE`, service-only `SELECT` RPC. It creates no financial writer, trigger, table, provider call or manual invoice.

The coordinating root agent recorded the successful staging application on 2026-10-19, enabled the plain read-only `CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED` capability, and verified:

- Migration SHA-256: `a53ee8915093aec706861ba6cecabff250d6d08e1dedcdc01f33c30bc5592776`.
- Function body MD5: `21e6d94bdc1dcf675f8956cf436caa13`.
- All 88 pre-existing function definitions retained digest `3ca28fdff6c75aa7b4838e5b6670f0a7`; financial counts remained unchanged.
- New function is `STABLE`, `SECURITY DEFINER`, with empty search path, UTC and a five-second statement timeout. Browser roles cannot execute it; `service_role` can. An unauthorized/null actor receives `FORBIDDEN`.

The BFF separately validates Auth, the sealed same-user/session identity, recovery restriction, current Admin allowlist and token/database AAL2. A purpose-bound opaque viewer and signed cursor preserve the same Admin session, selected customer and original date window. A cursor expires after 15 minutes. Cross-site requests, unknown/duplicate parameters, raw provider fields, numeric-string amounts and inconsistent totals fail closed.

Each explicit refresh reads at most 50 records plus one lookahead, with keyset pagination. Date filters mean **checkout request creation time**, including later renewal invoices associated with that request. Totals cover only validated local `VERIFIED` and `REFUNDED` payment rows on the current page. An unresolved request has no cleared amount. Later reconciliation/refunds may change subsequent reads. This is not a payment-date revenue statement, payout/settlement proof, tax invoice or all-time aggregate.

Validation: 16 actual clean-PGlite/full BFF tests and 11 UI tests passed, plus web typecheck. Tests cover original function/ACL preservation, live Auth/session/Admin/AAL2 denial, recovery, identity substitution, merchant/epoch isolation, signed cursor binding, tied timestamps and multiple invoices per intent, malformed money and business-row conservation. No hosted Auth action or provider request was used. The tracked migration and applied body hashes are asserted by the SQL suite.

The UI starts no automatic read. Admin navigation retains its existing session/assurance fence; an explicit refresh clears old data before a new read, and cancellation/denial/unavailability suppresses stale results. Its display and totals do not authorize payment, refund, cancellation, reconciliation or credit mutation.
