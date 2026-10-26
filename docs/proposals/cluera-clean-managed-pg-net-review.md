# Cluera managed pg_net hardening review

**Current October17 update:** the owner selected a secure external Render alternative. Its default-disabled implementation is reviewed, CI-passed and deployed as9f17bc7; native hardening/Support is no longer on the critical path or the next owner action. [Current scheduler design and handoff](../CLUERA_RENDER_BILLING_SCHEDULER.md), [verified execution status](../CLUERA_EXECUTION_STATUS.md). All native probe facts/frozen SQL below remain unchanged historical evidence. Do not submit another Support request merely to continue this alternative or run native SQL.

October 17, 2026. Operator review only: no executable SQL or permission to change infrastructure. Target only `yhnqlfcgrmckhyjdxegg / cluera-ai-production`. License Edition is outside scope.

## What the approved probe established

The exact rollback-only proposal SHA-256 `838f9cabbd54aa904aab210854b60cf1dfec44c013cf38b6e62f58430fbab167` ran once at **11:42:15–11:42:17 UTC**. The bounded 11:42:10–11:42:25 UTC log window contains one complete fixed metadata report and one expected `P0001 / CLUERA_PG_NET_COMPAT_ROLLBACK_ONLY` error. A separate statement-log occurrence is not a second execution.

| Native metadata inside the aborted transaction | Observed result |
| --- | --- |
| Version / namespace | 0.20.4 / extensions, non-relocatable |
| net functions / relations | 12 / 6 |
| net schema / exact POST owner | supabase_admin / supabase_admin |
| POST identity | net.http_post(text,jsonb,jsonb,jsonb,integer) |
| POST mode / return / language | Invoker, not definer / bigint / PLpgSQL |
| Arguments / extension membership / set-returning | Expected count and names / member / false |
| POST configuration / body length / MD5 | Empty / 1370 characters / 249e2190ab91f8313d4deec6d6e687be |
| Inherited membership in schema / POST / queue owner | false / false / false |
| Aggregate application net access / queue contents | Access present / both empty |

The POST owner is the observed difference from the original failed `postgres` owner pin; all other fields in that combined predicate match. This is not a Razorpay defect. The aggregate access boolean means at least one checked application role had schema or routine access during the temporary installation, not every privilege on every object.

Membership=false does not establish the complete grant-option/grantor graph. The probe did not capture every native object's owner, ACL, argument mode, configuration or body. Do not invent those facts or assume either that customer-role REVOKE works or that every supported delegated mechanism is impossible.

## Independently verified rollback

Fresh **11:42:19 UTC** security/history reads and **11:42:41 UTC** detailed metadata reads establish: pg_net/pg_cron and net/cron schemas absent; exactly original migrations `20261016014532 / 20261016015041`; original no-op definition, owner, configuration and ACL; disabled/null/never-sent worker; validated passive CHECK; unchanged `590a02220f8d4eca28d2b9a2434851cf` passive-state checksum; Cluera/epoch1/unbound owner. All 47 identical-input business snapshots match **11:41:58.964948–11:42:20.374720 UTC**, excluding ordinary request counters/Auth metadata. Log declarations alone were not accepted as rollback proof.

The frozen proposal calls no HTTP, worker, wake/restart or Vault function and performs no application DML. Native CREATE can initialize platform infrastructure; this was transient DDL, not a read-only query or persistent installation acceptance. No credentials, raw provider records or private SQL bodies were logged.

## Supported native path

Keep both original passive proposals and the executed probe unchanged. Do not simply broaden the owner check and retry. Obtain Supabase's supported owner/delegated hardening mechanism first. [PostgreSQL REVOKE](https://www.postgresql.org/docs/17/sql-revoke.html) can warn without removing all rights and depends on the grantor chain; [Supabase's postgres role is not superuser](https://supabase.com/docs/guides/database/postgres/roles-superuser). The three inherited-membership checks alone settle neither complete authority nor impossibility.

No SET ROLE, ownership reassignment, elevated membership, custom-hook manipulation, blanket CASCADE or platform bypass is proposed. Default native application access must not substitute for the reviewed denial policy.

Any later persistent proposal needs complete native owner/ACL/manifest provenance, a supported executor, fresh exact-target/passive/history/security/data checks, independent review and separate approval of exact bytes. Require atomic final denial of PUBLIC/anon/authenticated/service_role schema, routine, table, sequence and named-type rights and relevant grant options, preserving managed ownership, application functions/data, passive CHECK, disabled/null worker and unbound merchant. No cron, worker secret, HTTP or financial processing is included by that hardening scope.

The eventual postgres SECURITY INVOKER dispatcher also needs only the explicitly reviewed native POST call-chain rights (including the necessary schema/type, queue/sequence and helper access), not managed-owner membership or blanket native administration. A managed-owner-only ACL could leave that dispatcher unable to function. Establish and test this least-privilege path separately; no grants or dispatch were attempted by the current probe.

## Next owner action: request guidance, not a change

Open Supabase Support for **cluera-ai-production / yhnqlfcgrmckhyjdxegg** and submit the text below. This is a new managed-extension question, not a repeat of the old project's credential incident. Do not use the SQL editor or enable an extension. No credential, screenshot, permission change or installation is requested.

> Project yhnqlfcgrmckhyjdxegg (cluera-ai-production): please identify the supported way to install pg_net0.20.4 and harden its net schema, routines, tables, sequence and named types while retaining managed ownership. A separately approved rollback-only native probe observed schema and net.http_post owned by supabase_admin, POST SECURITY INVOKER and the expected bigint/PLpgSQL/argument signature. The postgres role's inherited membership in schema/POST/queue owner was false; complete ACL grant options were not captured. An aggregate check found application net access. Deliberate abort and independent catalog/history/data checks confirm nothing persisted. We need PUBLIC/anon/authenticated/service_role denied the reviewed native privileges without SET ROLE, elevated membership, ownership reassignment or platform bypass. Can customer postgres perform owner-grant hardening through a supported mechanism, or is a Supabase-operated exact transaction required? Please document the executor and final ACL verification, including custom-script effects. This request authorizes no installation, privilege change, outbound HTTP, worker/Vault call, schedule, secret or application-data change. Do not request or return credentials.

Share only the ticket reference or non-secret technical reply. This request has been prepared, not submitted by the agent. Payment activation and any revised persistent schema remain separately gated; no repeated Admin/MFA/key setup is required.

## Scheduler alternative, not implemented or selected

A default-disabled Cluera GET adapter could authenticate a dedicated cron secret, resolve the current merchant/epoch and invoke the existing fixed POST/HMAC worker in-process. No self-HTTP, new dependency, native extension, or change to current financial verification would be needed for the adapter. It is not possible simply to point Vercel Cron at the current worker: Cron sends GET/Bearer while the worker requires POST/HMAC and rejects Authorization. [Vercel Cron operations](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

An eventual design must deduplicate delivery durably (for example a server-derived nonce per merchant/epoch/UTC minute), preserve lease/idempotency checks and handle crash/retry/catch-up. A minute nonce is not a strict rolling50-second lock, and the existing one-event-per-tick implementation is not measured production capacity. The native no-op/passive CHECK could remain unchanged under a separately approved external transport; that is not permission to bypass current disabled worker/financial gates.

Minute-level Vercel Cron requires Pro/Enterprise; Hobby is once per day with coarse timing. Cron can miss or duplicate delivery and does not automatically retry failed runs. [Limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [operations](https://vercel.com/docs/cron-jobs/manage-cron-jobs). Pro's published platform fee is currently $20/month plus applicable usage/seats/taxes, not an actual quote for this workspace. [Pricing](https://vercel.com/docs/plans/pro-plan). The available team read did not return plan/quote entitlement. A team-wide upgrade could affect shared workspace billing; no upgrade, transfer, paid service, secrets, route, schedule or activation was performed. Obtain exact scope/cost and separate approval before selecting or purchasing this alternative.
