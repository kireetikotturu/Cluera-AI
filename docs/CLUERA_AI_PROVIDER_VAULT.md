# Cluera Admin AI provider vault — staged implementation

October 13, 2026. Cluera only. Source/test-covered, **not operational or production accepted**.

## Architecture and authority

Admin → existing Auth-verified user/session + SQL allowlist + token/live AAL2 → fresh existing TOTP challenge per change → ciphertext-only service RPC → new Cluera-private provider registry and immutable metadata audit.

Render → fixed retained Supabase over TLS, service-role authenticated ciphertext RPC → server-memory envelope decryption → existing Gemini/Flux adapters → existing server-authoritative reservation/settlement ledger. No credential API proxy, plaintext database column, browser read-back or customer BYOK. Provider configuration cannot change customer grants, prices, usage balances or payment switches.

New UI: Account Admin → AI Providers & Models. Reads and model discovery are explicit; no idle polling. Keys/codes are transient deliberate entry controls and cleared immediately on submit; no saved secret retrieval, React secret state, local/session storage, URL, console or retained retry body. **A browser necessarily handles a key while its authorized owner enters it**; write-only does not claim secrets never exist in browser memory. Do not use shared/untrusted browsers or extensions. Use TLS and private Admin sessions. A future server-side sealed-file provisioning option can avoid browser key entry if required.

The endpoint returns strict metadata only, never saved secrets, encrypted envelopes, provider bodies, Auth tokens or raw errors. Mutation UUID/revision fences prevent duplicate/concurrent writes. Unknown writes lock the console; verification is a metadata-only GET of the original operation, not key resubmission. Existing MFA factors only; no enrollment/role changes in this feature.

## Credential protection

AES-256-GCM envelope encryption: random per-record data key and nonces; wrapped data key authenticated by a dedicated 32-byte key-encryption key. Product/provider/credential UUID/version domain binding prevents ciphertext substitution. The SQL registry contains ciphertext only. Each replacement deliberately disables the provider and invalidates the old model/probe approval. Audits store before/after **metadata**, not plaintext or encrypted historical credentials.

One-time infrastructure secret `CLUERA_PROVIDER_VAULT_KEYRING_BASE64` is canonical base64 of JSON `{ "active": "<key-id>", "keys": { "<key-id>": "<canonical base64 of 32 cryptographically random bytes>" } }`. Place the same dedicated keyring privately in **new** Cluera Vercel/Render only, never NEXT_PUBLIC. IDs are non-secret; values are secrets. No actual keyring was generated, installed or read in this turn. Cookie/rate key reuse and duplicate keys are rejected; no fallback/key generation exists. The maximum ring is three explicitly retained keys.

Protect the root key separately from database backups, with controlled owner access and encrypted offline recovery escrow. Rotation requires explicit approval, a new active ID, retained old decrypt keys, a reviewed rewrap job and independent read-back before retiring the old key; the rewrap job is **not implemented or authorized** here. Never rotate/delete keys merely to fix startup. Environment-keyring staging is not a claim of external KMS custody. External KMS/HSM integration, access reviews, rotation/restore drills and compromise recovery remain commercial gates.

## Provider/model policy

Explicit Test/discovery sends bounded fixed-host metadata **GETs only**, no generation/audio, retries, redirects or arbitrary Admin URL. Server code sanitizes model IDs and withholds raw bodies. Metadata access is not actual streaming acceptance, key ownership proof, permission-to-generate or invoice verification. Partial listings cannot approve enablement. The existing tested Gemini model and Flux model are the initial runtime-compatible set; other discoveries are listed but not auto-approved. The existing model registry independently remains authoritative.

OpenAI and Anthropic credentials may be explicitly entered/tested by the owner after bootstrap, but their generation adapters and enablement are **unavailable**. No OpenAI/Claude request was made with real credentials. No automatic fallback exists (`NONE` only), particularly after emitted output, unknown outcomes or metered work. Adding a provider/model requires reviewed compatible transport, cancellation, accounting, data-handling and acceptance tests—not an arbitrary endpoint field.

Reference contracts: [Gemini models](https://ai.google.dev/api/models), [Deepgram metadata](https://developers.deepgram.com/reference/manage/models/list), [OpenAI model list](https://developers.openai.com/api/reference/resources/models/methods/list), [Claude model list](https://platform.claude.com/docs/en/api/models/list). Discovery does not establish pricing/capabilities beyond what the reviewed adapter independently supports.

Runtime shares single-flight reads with a maximum ten-second cache and no stale-on-error fallback. Active streams re-read every ten seconds; the existing seven-second transport timeout bounds disable/rotation/outage detection to approximately seventeen seconds plus scheduling, not instantaneous revocation. Streams close rather than changing provider/key midway. No provider key update requires redeployment once this vault mode is operational. Infrastructure/root-key changes still require deliberate server configuration/deployment.

## Approval-required bootstrap

1. Owner still **Not ready yet**: privately save retained `SUPABASE_SERVICE_ROLE_KEY` in new Vercel as Sensitive/Production-only; save it plus the same new Cluera rate secret in new Render. Set new Render health path `/healthz`. Four saved Vercel cookie/rate/signing entries and callback additions need not repeat. No connector can privately transfer a local/old secret without materializing it in tool arguments; no old settings were decrypted/copied.
2. After reviewed source deployment, explicitly select new Render `CLUERA_AI_BOOTSTRAP_MODE=auth-only`. Real infrastructure and exact origin/database gates remain mandatory. Provider requests and their reservation START are denied; there are no dummy keys. Default legacy-environment behavior remains fail-closed/compatible, not silently changed. No legacy credential is migrated automatically.
3. Review [the proposed schema](proposals/cluera-provider-vault.sql), then obtain **separate explicit schema approval**. Only then create a CLI-named additive migration, freeze/test it and apply to the exact retained project with fresh before/after financial preservation and security checks. No proposal was applied remotely. It creates only `cluera_private.ai_providers`, `ai_provider_audit` and bounded service-only RPCs/ALWAYS immutable trigger, not customer/financial/schema rewrites.
4. Privately provision/verify the dedicated keyring and protected backup. After separate credential/bootstrap approval, enable `CLUERA_PROVIDER_VAULT_ENABLED=true` in new Vercel and `CLUERA_AI_BOOTSTRAP_MODE=admin-vault` in new Render; reload complete reviewed source. No old-service change or provider credential import. Roll back to auth-only if any bootstrap check fails; never to an unverified provider or plaintext store.
5. Existing authorized Admin privately completes fresh MFA, saves a **disabled** key, explicitly tests metadata, selects a runtime-compatible default and deliberately enables one provider. Independently accept a real authorized Gemini text/image and both Flux channels, cancellation, disable/rotation and exact shared usage settlement. Test plans/trials cannot be reset or manually invented for this step.

## Still missing / do not claim complete

Hosted Auth/native/Google recovery and full resend acceptance; hosted vault/MFA/key save/test/enable/disable; actual provider streaming and ciphertext-cache revocation; external KMS/rotation/restore; durable provider telemetry with authoritative cost reconciliation; OpenAI/Claude generation; controlled fallback; true multi-connection SQL acceptance. The console explicitly labels usage/cost telemetry unavailable, rather than inventing zeros or prices. The existing time ledger is unchanged and is not an AI token-cost ledger.

All Cluera payment gates remain disabled. Old Account/Razorpay/Paddle history, original License product, original main/migration, installers and updater remain protected.
