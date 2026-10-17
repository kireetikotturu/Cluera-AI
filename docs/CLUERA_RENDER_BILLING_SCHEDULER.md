# Cluera authenticated Render billing transport

October 17, 2026. New Cluera project only: `yhnqlfcgrmckhyjdxegg`. Implementation is default-disabled. This is not payment activation, a new database scheduler, or production acceptance.

## Selected engineering path

Reuse the existing Cluera Render relay, without creating a service or purchasing a plan. A small transport sends a fixed, authenticated POST to the Cluera website. The website resolves the configured Test merchant and current ownership epoch, then invokes the existing POST/HMAC billing worker **in process**. It does not send HTTP to itself. Existing durable nonce claims, receipt leases, independent provider verification, transactional grant uniqueness, refund tombstones and recurring lifecycle policy remain authoritative.

The dispatcher requires both the new external-transport gate and the existing exact-target intake/financial gates. Browser callbacks cannot produce a receipt or credits. The transport has no provider credentials or database client. Native pg_net/pg_cron, managed ownership and the original passive CHECK/no-op remain unchanged. No Supabase Support response is needed to develop or deploy this disabled alternative.

## Authentication and bounded execution

- Dedicated `SIGMAROUND_BILLING_WORKER_SECRET`, never a Supabase/provider/cookie/rate/signing key. The same fresh value belongs only in Cluera Vercel Production Secret and Cluera Render server settings. It must not be public, sent in chat, logged or committed.
- Domain-separated DISPATCH, WAKE and STATUS proofs bind POST, one literal URL, timestamp, keyed per-UTC-minute UUID and SHA-256 of the exact `{}` body. A proof for one purpose cannot authorize another. Timestamp skew, replay shape, raw path, content type, body size and read deadline are checked before protected work.
- No cookies, browser Origin, Authorization, query target, redirect following or arbitrary endpoint. Invalid or disabled requests fail closed. Worker nonce consumption remains durable in the existing database; a keyed minute nonce is not represented as a rolling 50-second mutex.
- Single in-flight Render dispatch, startup kick and next-minute timer. Ten-second bounded dispatch, bounded response and fixed-category logging; no immediate retry after an unknown result. Shutdown stops the timer and aborts the in-flight transport before existing relay shutdown completes.
- Only a genuinely verified, durably **STORED** webhook receipt schedules a post-response wake of Render. Duplicates, rejected signatures and storage failures do not. A bounded wake failure cannot erase or change the already durable receipt acknowledgement. No fabricated signed event was used against staging.
- Authenticated STATUS can establish matching server configuration while the processing gate is false. It makes no database/provider call, starts no timer and grants nothing.

## Free-service limitations

This is a useful Test transport, not an always-on production scheduler. Render free web services sleep after 15 minutes without inbound traffic and can take about a minute to wake. A signed stored receipt can cause an inbound wake; work remains durable if that bounded wake times out. Startup can dispatch after waking. However idle renewal/grace/reconciliation sweeps can remain delayed without an independent reliable wake. No self-keepalive, uptime guarantee, new worker, paid upgrade or secret-dependent CI is introduced. Shared free-hour, outbound and build quotas still apply. [Render free limitations](https://render.com/docs/free), [service types](https://render.com/docs/service-types), [deployment lifecycle](https://render.com/docs/deploys).

Before commercial recurring billing, independently measure cold start, backlog/catch-up, failure recovery, sustained capacity and renewal/grace timing, then approve an appropriate always-on transport and its actual quoted cost. One existing event per tick is not measured commercial throughput. A paid infrastructure or team-wide upgrade remains unapproved.

## Disabled rollout and activation sequence

1. Publish reviewed source, pass CI, deploy the complete pinned website and verify Render revision, stable alias and denied endpoints. Keep all existing financial/provider flags unchanged. No schema is needed for this transport.
2. Privately provision the fresh shared transport secret. Keep `CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED=false` in both services. This is secret provisioning only, not receiver, worker, merchant or payment activation. Reload pinned source only after the private save, then verify STATUS and positive/negative transport proof without dispatch.
3. Complete a fresh bounded provider-authoritative obligations and destination audit. The preceding accepted inventory has one attempted INR549 order, seven authorized/two failed payments, no accepted captured/refunded payment, and a non-numeric paid-amount warning. It is **not financial clearance**. Never retry, capture, refund, replay or grant against those rows automatically. Live/Paddle and the historical destination remain unresolved until actually verified.
4. Separately approve the exact audited clean merchant pin/ownership, Test receiver, required subscription event set, old-destination continuity/rollback and transport activation. Current ownership helper can accept an unbound database merchant; configured-key authentication alone must not be misreported as a durable merchant pin. Do not simply switch the old URL or activate against an unverified destination.
5. Only after those prerequisites, approve one owner-initiated INR549 Test purchase. The agent must not create an order, open checkout or pay on the owner's behalf. Independently accept captured payment + paid owned order + genuine signed receipt + one attributable non-expiring 10,800-second pack + preserved trial/shared balance + installed Windows Credits & Usage. Stop on failed/uncertain outcome without another order or manual grant.
6. Accept each monthly plan and renewal/failure/grace/cancellation/refund lifecycle separately: INR5,499/40h, INR9,599/100h and INR19,549/200h monthly. Synthetic policy/SQL tests do not establish actual Razorpay plan enablement, supported methods, subscription creation, invoice delivery or customer controls.

## Next essential private action, after verified disabled rollout

In a trusted password manager, generate and retain one new random 64-character alphanumeric secret. Privately save that same value as `SIGMAROUND_BILLING_WORKER_SECRET` in **only** Vercel `cluera-ai-staging` (Production-only Secret/Sensitive) and Render `cluera-ai-relay-staging`. Set the new `CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED=false` in both. Change no existing flag, credential, destination, catalog, owner or schedule, and do not click Deploy/Redeploy. Confirm only **Cluera scheduler secret saved privately**; never send its value.

The optional offline preparer requires a genuine ignored/untracked Git worktree. It deliberately refuses the current non-Git local export; no private scheduler file has been generated. Do not initialize Git or bypass its guard. Direct private hosted saving above does not depend on that helper.

Windows candidate 1.0.3 is unsigned TEST, not a commercial/publicly approved download. Owner-installed secure-store/login/restart/session/audio/provider/balance/update acceptance, immutable hosted bytes and independent downloaded hash, private-MFA release approval and commercial signing remain separate. No existing EXE or License Edition feature is changed by this transport.
