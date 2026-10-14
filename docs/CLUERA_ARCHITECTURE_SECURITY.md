# Architecture and security

## Current scope - premium Cluera engineering and retirement preparation

The new request authorizes safe Cluera-only staging implementation and **retirement preparation**, accepting an end to old Account desktop support if necessary. It supersedes the prior old-relay retention/key-saving handoff. No service shutdown, legacy revocation, financial activation, webhook/scheduler/owner change or unapplied schema is authorized. Exactly two products remain: preserved License Edition and Cluera AI.

Premium pricing/checkout cards, clear gated Buy Now/Subscribe Now labels, accessible status/account/history, responsive layout and Admin section navigation/help are implemented. Actual rollout stays disabled; presentation links only view availability. The 12,752-byte checkout denial/refresh/effect/buy/SDK/callback body is byte-identical, SHA-256 e763b2a94eb92e53a8d36f892fee66185cce54872d9a38b7923b85094c896abc. No desktop functionality or installer byte is changed.

A reviewed machine-only relay infrastructure probe now tests its **own** configured database key: domain-separated 30-second HMAC, nonce replay rejection, single-flight/12 accepted per minute, fixed GET-only Auth pagination,5-second/64KiB bounds and signed fixed-boolean response. No customer token, identity output, provider call, usage writer or financial mutation. Unit evidence passes; actual protected hosted proof is recorded only after deployment. Web/backend/desktop typechecks and web/backend code builds pass; current full/production audits report zero advisories. Initial local test/harness failures remain dated, never hidden.

**Single next approval after verified Cluera rollout:** reversible suspension of **only sigmaround-account-relay-staging /srv-db1402u0tbcc739dc5m0**, accepting loss of old Account desktop AI/audio connections, after an immediate no-active-usage check. No deletion, old website stop, key/env/payment/License change or revocation. Do not suspend yet. The old website must retain the active scheduler, signed financial intake and preserved pending bindings. Detailed impact and rollback safeguards are in the retirement plan. Phase A remains conditional/unapplied on incident containment; providers auth-only, payments false and commercial launch NO-GO. This supersedes older retention/saving or completed-launch handoffs below.


## October 14 navigation/security boundary

Plan navigation is a hint, never a server price/revision/identity/permission. Four allowlisted Cluera codes and an optional desktop UUID survive into fixed local account/checkout links. Duplicate/invalid hints, hostile return URLs and unexpected stored fields cannot enable checkout. Same-browser state expires after30 minutes; logout/reset clear it and recovery cannot continue. No password/token/provider resource is stored; no automatic SDK/order/payment. Server live-session/owner/tester/catalog and raw-signature/provider-evidence checks remain authoritative.

Owner confirms suspected legacy service-role JWT format, not dummy/retired status. Five supplied attachments contained no unique candidate; no authorization check was attempted. Conditional Phase A cannot expand privileged billing APIs before containment. Replacement keys, disabled buttons, RLS and unchanged digests are not retirement proof. [Execution/approval map](CLUERA_EXECUTION_STATUS.md). No old service, License, key trust, financial row or frozen SQL was changed.

Cluera web/browser → dedicated Vercel BFF → retained Supabase Auth/live sessions/RLS/service-only RPCs.
Cluera Electron renderer → narrow preload → main-memory access credentials + OS-encrypted refresh state → dedicated Render WSS → same retained server usage reservations → server-only Gemini and Flux.
Local history/files stay in the new UUID-isolated profile; selected extracted cloud context uses the retained backend. No automatic original-file backup or cross-product token transfer.

The browser never authorizes balance, capture or paid fulfillment. START/CHECKPOINT/STOP and financial adjustments retain Account-first locks, bounded reservations and idempotent settlement. No per-second DB writes. New payment routes and workers fail closed behind the independent rollout flag; no second scheduler is provisioned.

Release approval uses a new Cluera registry/RPC/product lock and existing explicit MFA Admin authorization/immutable audit. The old Account registry is never read as a fallback. Cluera feed requires the distinct pinned Ed25519 key, product/audience/channel/version/hash/size/origin; old products reject it.

NEXT_PUBLIC key validation rejects service-role/secret keys before bundling. Provider metadata is HMAC-bound to X-Cluera proof headers/nonces and a dedicated scope. Logs retain categorical operation/stage/status, never credentials or provider payloads. Production secrets belong only in the selected new service/project; private local preparation and binaries are ignored.

Compatibility exceptions: account/customer/billing SQL/API names and SIGMAROUND_* configuration names are intentional, separately scoped in new resources. Historical SigmaPro/SigmaEnterprise prices/provider IDs remain untouched; new Cluera v2 revisions do not alias them. Historical migrations/audits and old source/profile/EXE names stay unchanged. Cluera support is clueraaisupport@gmail.com; old product support is not redirected by this work. Some isolated audio preference keys retain their old prefix solely inside the new profile. AppConfig's internal licensing property describes release trust only, not License authorization.

Do not run historical migrations, SQL grants, release publication, role/MFA changes, customer/provider spend or payment recovery as a smoke test. New native callback uses43822 rather than old43821. All-device logout affects all clients of the same retained Auth identity by design. Keep old callbacks and rollback clients.

Dependency findings, skipped tests, bounded scans and synthetic/native/hosted evidence must be reported separately. Free Render capacity/sleep and unresolved normal-close propagation are not production availability guarantees.

