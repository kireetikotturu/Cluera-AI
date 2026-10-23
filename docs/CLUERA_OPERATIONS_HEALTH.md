# Cluera operations health reader

This is fixed-target, private operations evidence. It does not dispatch or wake a worker, reconcile a receipt, retry checkout, settle usage, call an AI provider, send notifications or change credits.

## Separate Live reader, October 21

Migration `20261021075249_cluera_live_infrastructure_disabled` adds service-only STABLE `cluera_live_billing_operations_health()` and supporting partial indexes. It reads the isolated Live inbox/commands plus shared unsettled usage. Run `node scripts/check-cluera-live-operations.cjs` with `CLUERA_LIVE_OPERATIONS_READ_ENABLED=true` in the same trusted private environment described below. It uses a fixed RPC target, the same six-second/4-KiB bounds and no arbitrary URL or write capability. Keep the original Test monitor running independently.

Live output adds active bank and database intake/checkout/native gates, cancellation/native-command counts and oldest timestamps. Pending commands older than five minutes alert; UNCERTAIN/REVIEW commands alert immediately. Counts cap at 1,001 per source. Missing merchant/admission is expected only while Live intake/checkout are disabled and Test is selected; that empty observation is explicitly `DISABLED`, exit 0. Backlogs, quarantine, unsettled usage and command problems still alert in disabled state. A Live bank with intake off alerts. None of these observations proves processing or payment success.

A renewed SELECT-only read at 02:02:22 UTC October 23 confirms Test selected, Live gates off and no backlog, quarantine, uncertainty, pending commands or unsettled usage in either monitor. Test admission at 02:02:01 UTC establishes only admission, not fulfillment or uptime.

The first read at 07:53 UTC October 21 confirmed Test selected, empty Live financial state, no merchant profile and all Live gates off. No scheduler, alert destination or paid capacity was provisioned. Follow [the current payment handoff](CLUERA_PRODUCTION_PAYMENT_HANDOFF.md) for host/alert acceptance and later Live activation. The October 19 evidence below describes the separate Test reader.

The SELECT-only migration `20261019095014_cluera_operations_health.sql` was applied at 09:50 UTC October 19, 2026. SHA-256: `89a2b201d7091dc15bc6fda5a09e828a1540516199e1f796c3dfeb462c38c6cf`. All 87 prior function definitions retain aggregate digest `76f7d6d36ba283c1e3af9e8be93e26a2`; checked business counts are unchanged. Live RPC body, service-only ACL, STABLE/empty search path/UTC/timeouts pass. Its first read shows fresh current-epoch admission, no pending/quarantined receipts, no uncertain requests and no expired unsettled reservations. This does not establish long-term reliability or financial acceptance. Existing security-advisor findings are unchanged.

## What is implemented

`scripts/check-cluera-operations.cjs` performs one authenticated POST containing `{}` to the SELECT-only `cluera_operations_health` RPC in project `yhnqlfcgrmckhyjdxegg`. It rejects other projects, missing opt-in, redirects, non-JSON/oversized responses, unknown fields, numeric strings, invalid/stale dates and inconsistent counts. Fetch and body reads share a six-second deadline, with no retry or unbounded cancellation wait. Output contains fixed categories and aggregate timestamps/counts, never credentials, customer IDs, receipt IDs or provider payloads.

The SQL proposal adds seven supporting indexes and one STABLE SECURITY DEFINER SELECT function, with an empty search path, UTC, two-second lock timeout and five-second statement timeout. Only service_role can execute it; no direct table privileges are added. It reads existing durable receipts, uncertain intents, admitted nonces and unsettled usage windows. It creates no table or financial writer.

Counts stop at 1,001 and declare a 1,000-record limit. Values above the limit produce COUNT_LIMIT_REACHED. The oldest pending/uncertain timestamp is selected before the cap. This bounds returned counts, not every scan: finding expired unsettled windows can examine historical settled windows too. The SQL deadline fails closed as UNAVAILABLE; it must never be replaced by a preliminary window limit that could hide unsettled rows. An overloaded/timed-out query is UNAVAILABLE, never a zero backlog. Measure this query at expected retained volume before commercial scheduling.

## Categories and meaning

| Category | Condition |
| --- | --- |
| PROCESSING_OWNER_UNAVAILABLE | Current owner is not Cluera or its merchant binding is absent |
| WORKER_ADMISSION_STALE | No nonce admitted for the current epoch within five minutes |
| CLUERA_RECEIPT_BACKLOG / RETAINED_RECEIPT_BACKLOG | Oldest pending receipt is older than five minutes |
| EXPIRED_RECEIPT_LEASE | A selected pending receipt has an expired lease |
| QUARANTINED_RECEIPT | A retained/new receipt is quarantined |
| UNCERTAIN_CHECKOUT | A CREATING/UNCERTAIN intent is older than five minutes |
| EXPIRED_USAGE_RESERVATION | A usage window expired over two minutes ago without its settlement |
| COUNT_LIMIT_REACHED | A bounded count exceeded 1,000 |

A fresh nonce proves **admission only**. It does not prove reconciliation success, a payment, a grant or operating capacity. The reader always declares creditEffect=NOT_INFERRED and productionReady=false. A BOUND order awaiting its purchaser is not treated as permission to retry.

## Run and operate

After the reviewed migration is applied, run only in an existing trusted private server/operator environment with its current Cluera NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Do not copy that credential into GitHub Actions, chat, browser code, logs or a new service.

Explicitly opt in with CLUERA_OPERATIONS_READ_ENABLED=true and invoke `npm run verify:operations`. No other CLI arguments are accepted. Exit 0 means an observation without the listed conditions; exit 1 means ATTENTION; exit 2 means unavailable, disabled or invalid. A monitoring host must treat both nonzero exits as a failed observation and retain reports securely according to accepted retention policy.

A reliable independent schedule, notification destination, on-call owner, retention policy and escalation/restore drill are still required. None is silently created or purchased here. A sleeping free Render service can legitimately trigger stale-admission alerts; weakening the threshold does not make it reliable. Choose capacity only after an explicit owner decision and measured catch-up/load testing.

Respond by inspecting the same durable records and authoritative provider state. Never let the monitor automatically capture/refund, replace/replay a payment, invent a receipt, grant time, rotate secrets or delete records. Keep uncertain financial operations fenced.

## Verification

Seven offline Node security/transport tests pass, including hung fetch/body deadlines. Five tests execute the exact clean foundation plus proposal in isolated PGlite: service-only privilege denial, STABLE/config restrictions, aggregate redaction, epoch isolation, exact oldest/capped counts and preservation of uncertain/usage records. These tests use synthetic data only. Hosted application and scheduling acceptance are recorded in the consolidated final checklist.
