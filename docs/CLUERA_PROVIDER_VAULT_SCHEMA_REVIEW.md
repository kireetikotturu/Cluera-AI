# Provider-vault schema review — unapplied proposal

October 13, 2026. [Exact SQL](proposals/cluera-provider-vault.sql). **No migration applied, credential imported or root key provisioned.**

## Every object and access policy

Creates schema **cluera_private** with PUBLIC/anon/authenticated/service_role schema privileges revoked; no exposure through a new browser API.

| Table | Contents | Policy |
| --- | --- | --- |
| cluera_private.ai_providers | Four allowlisted provider IDs, revision, credential UUID, AES-GCM envelope ciphertext, enabled/default model, bounded discovery result and timestamps | RLS enabled; **zero permissive RLS policies**; direct SELECT/INSERT/UPDATE/DELETE denied to PUBLIC, anon, authenticated and service_role |
| cluera_private.ai_provider_audit | Operation UUID, verified Admin/session IDs, provider/action, keyed input digest, before/after metadata and timestamp | Same RLS/direct-CRUD denial; ALWAYS BEFORE UPDATE/DELETE/TRUNCATE statement trigger rejects changes |

Indexes are only the primary-key indexes on provider ID and operation UUID. No customer, usage or billing index is changed. Tables start empty; no seed/automatic key migration.

Private functions: **ai_provider_metadata(row)** is immutable SECURITY INVOKER with empty search path, produces metadata only; **ai_provider_audit_immutable()** is SECURITY INVOKER/empty search path and enforces the ALWAYS trigger. Direct execution is revoked for browser/service roles.

Public functions, all SECURITY DEFINER/empty search path, default PUBLIC/browser EXECUTE revoked and **service_role EXECUTE only**:

- **cluera_provider_admin_read(actor, session, operation?)**: existing live SQL Admin + AAL2 check; metadata list or original same-Admin operation result; 5-second statement bound. Never returns envelopes or plaintext.
- **cluera_provider_read(provider)**: allowlisted encrypted current row for server retrieval; 5-second bound. It returns ciphertext to privileged servers, not a browser endpoint. It does not assert customer authorization; only reviewed servers may call it.
- **cluera_provider_mutate(actor, session, operation, provider, action, revision, digest, reauthenticated_at, input)**: existing live Admin/AAL2 plus server-attested fresh TOTP step-up (2 minutes, 5-second future skew), provider advisory/row locks, 2-second lock/5-second statement bounds, expected revision and UUID/digest replay fences. REPLACE disables/invalidate approvals; TEST stores sanitized discovery metadata; CONFIGURE enables only fresh complete compatible Gemini/Deepgram approval. OpenAI/Claude enablement is denied. Audit insertion and provider change are atomic; insertion failure rolls back both.

Recent proposal review added explicit NULL provider/action checks and requires non-null probe time before enablement. Local synthetic PostgreSQL/WASM tests cover privileges, AAL1/non-Admin/stale-step-up denial, operation replay/conflict, revision fences, unsupported-provider enablement, unchanged rows on invalid input, immutable audit and rollback. They do not establish real hosted multi-connection contention. No existing function is replaced.

## Preservation evidence and limits

The SQL creates only the objects above and performs no writes to existing Auth, customer, trial, usage, Paddle, Razorpay or release tables. It calls the existing Admin authorization predicate rather than granting a role or enrolling MFA. Historical Account migrations remain unchanged and must not be replayed.

Read-only shared-project baseline and final comparisons are recorded in [implementation results](CLUERA_IMPLEMENTATION_MIGRATION.md): complete-row digests for Account/trial/Paddle intents/recovery audits/legacy receipts/jobs/Razorpay intents, plus grants/packs/terms/release/event/application/diagnostic counts. This turn is a before/after engineering preservation check, **not an applied-migration acceptance or evidence that a compromised credential was never abused**. Repeat identical fresh reads immediately before and after any separately authorized application.

## Encryption bootstrap — separate from schema permission

Resolve the [exposed shared credential](CLUERA_SHARED_CREDENTIAL_ROTATION.md) first. Generate a new dedicated cryptographically random 32-byte key-encryption key privately, with a non-secret key ID. The owner retains an encrypted offline recovery copy separately from database backups. Use the canonical keyring format in [vault architecture](CLUERA_AI_PROVIDER_VAULT.md), save the same protected keyring only in new Cluera Vercel/Render server environments as **CLUERA_PROVIDER_VAULT_KEYRING_BASE64**, never NEXT_PUBLIC/Git/browser responses/logs/installer. Do not reuse Supabase, cookie, rate, signing or AI-provider keys.

Keep **CLUERA_PROVIDER_VAULT_ENABLED=false/absent** and Render **auth-only** while checking keyring format/custody and ciphertext round-trip using synthetic credentials. Do not auto-import existing provider environment keys. After schema and separate bootstrap/activation approval, allow one existing authorized Admin to save a disabled credential through TLS/private MFA, test metadata and approve a compatible model. Actual generation/audio acceptance and ledger settlement remain separate, metered owner-approved journeys. Rewrap/restore drills and external KMS custody remain unimplemented production gates; environment-held staging keys are not external KMS.

## Specific schema approval required

Frozen proposal SHA-256: **72e1fdf4b02924ffc35af19fe3392749b024e9d948e5d00c7ca13f104f294cf9**. Byte-reviewed Git blob **2cd2d6415ccd79fc9bf02bf7c72c0be24b5531d0**, included in reviewed Cluera implementation acc6357 and unchanged in final abe7b8b. Existing data/identity read-back and runtime verification are in the latest implementation results. No hosted migration acceptance is claimed.

Approve **only the frozen provider-vault proposal** for **dwqltsqumiwsxtkzdoaa**, creating the two tables, five functions, primary indexes, immutable trigger and grants above via a new CLI-generated additive migration after fresh preservation checks. This approval must explicitly exclude key import/rotation, provider activation, grants/payments, the separate unapplied Cluera release registry and changes to old services. The final handoff records the exact proposal SHA-256. Any source change after approval needs renewed review; failed validation stops application. No rollback drops/data deletion are authorized.
