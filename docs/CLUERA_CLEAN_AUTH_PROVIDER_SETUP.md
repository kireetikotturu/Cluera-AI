# Clean Cluera Auth, Admin, email and provider setup

October 16, 2026. **Clean destination only: yhnqlfcgrmckhyjdxegg / cluera-ai-production.** The owner explicitly chose a fresh start and does not require old Cluera users or dummy trial balances. This supersedes the earlier customer/Auth migration prerequisites in `CLUERA_AUTH_MIGRATION.md`; do not import old users, password hashes, identities, sessions, MFA factors, roles, trial rows or private credentials.

This is not permission to reconcile or erase any real provider/payment obligation. Razorpay/Paddle ownership, pending provider state and financial cutover remain independently gated. SigmaRoundAI License Edition, old services and retained EXE files are not changed by this setup. A database named production does not establish production readiness.

## Applied schema, not activation

Root execution reports the new-project foundation applied as **20261016014532**, exact SHA-256 **ae0f1eeef39e9d988386c1c36b3150cee8b10895b38e7d270d373f4b9009379e**, followed by unchanged vault **20261016015041**, SHA-256 **72e1fdf4b02924ffc35af19fe3392749b024e9d948e5d00c7ca13f104f294cf9**. Read-back matches all 85 selected function bodies/configurations/ACLs to tested local PGlite; 48 application tables have RLS/no permissive policies/no direct CRUD for browser/service roles. Auth, Admin, credential, financial, grant and release rows remain empty; no schema application activates a provider or payment. Exact remote evidence and bounds are maintained in the execution status.

## Schema composition and dependencies

The clean foundation contains the local customer/session authorization, once-ever 900-second trial, usage ledger, workspace/models/catalog/Admin controls and Cluera-only release registry needed by the application. Its compatibility billing tables start empty; old rows/jobs/cron bearers are not copied. New checkout catalog entries remain disabled. Root execution records the exact generated foundation hash and actual remote result separately.

The unchanged provider-vault proposal `docs/proposals/cluera-provider-vault.sql`, SHA-256 **72e1fdf4b02924ffc35af19fe3392749b024e9d948e5d00c7ca13f104f294cf9**, can be reviewed separately after that foundation. It references **public.account_admin_check(uuid,uuid,boolean)**, not a project hostname or an old identity. Its authorization must operate on this destination's live verified Auth user/session and explicit Admin profile.

The vault creates only:

- Private RLS/no-policy tables `cluera_private.ai_providers` and `ai_provider_audit`, with browser/service-role direct table access denied.
- Three service-only, empty-search-path public RPCs: `cluera_provider_admin_read`, `cluera_provider_read` and `cluera_provider_mutate`; two private helper functions with direct execution denied.
- The ALWAYS UPDATE/DELETE/TRUNCATE-blocking audit trigger, primary indexes, revision/UUID/digest replay fences, fixed provider allowlist, bounded timeouts and atomic metadata audit.

There is no Admin, credential, model, enabled-provider or financial seed. Separate application of the unchanged vault proposal permits independent empty-table/ACL/trigger verification. Schema creation is not vault activation or provider acceptance. Service credentials still have privileged server semantics; private tables/RLS do not make them suitable for a browser. [Supabase key guidance](https://supabase.com/docs/guides/getting-started/api-keys), [function security](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker).

Cluera release SQL `supabase/migrations/20261013021137_cluera_release_distribution.sql` depends on the clean `account_admin_profiles`, `account_admin_audit` and `account_admin_check`. The registry starts empty, has RLS/direct CRUD denial and service-only release functions. It does not publish an EXE, create a release draft, approve bytes or authorize replacing any embedded updater trust. It rejects old product filenames and requires live Admin AAL2 plus explicit verified hosted hash/size for publication. No installer upload or release publication is part of schema setup.

## Fresh infrastructure and application switch boundary

Non-secret target: **https://yhnqlfcgrmckhyjdxegg.supabase.co**. Use only this project's modern publishable key and separately named modern secret keys for Cluera web and relay. Do not copy old JWT/API/signing/encryption authority. Secret values remain server-only, never NEXT_PUBLIC, chat, Git, API DTOs or installers.

Web and relay must share a new dedicated rate-proof secret. The web needs a new cookie-encryption key; old session cookies are not evidence of new-project login. Keep the relay in `CLUERA_AI_BOOTSTRAP_MODE=auth-only`; provider START must fail before reservation/writer access. Keep `CLUERA_PROVIDER_VAULT_ENABLED=false/absent` and every payment/checkout/intake/rollout gate false. New schema availability must not imply feature activation.

Do not save a partly switched web/relay configuration over the existing public runtime. Use the root-reviewed acceptance deployment/switch procedure only after the exact destination schema, environment tuple, modern-key positive checks, old-token denial, empty financial state and protected Auth/Admin boundaries pass. Preserve BFF routes, callbacks, local history and Windows features. There is no fallback to old Auth after a destination denial.

## Exact Auth and Google configuration requirements

These are **non-secret configuration requirements**, not a claim that hosted settings were read or changed:

| Setting | Required reviewed value/behavior |
| --- | --- |
| Destination Auth project | `yhnqlfcgrmckhyjdxegg` only |
| Account email/password | Enabled with email verification; do not auto-confirm signups |
| Site URL | Reviewed Cluera application origin; current canonical origin is `https://cluera-ai-staging.vercel.app`. Do not use an unreviewed preview origin or change old project settings. |
| Web return | `https://cluera-ai-staging.vercel.app/api/account/callback`; current SDK uses this bare callback, while optional `sb_flow_id` is accepted defensively with sealed PKCE verifier behavior |
| Native return | Generated `http://127.0.0.1:43822/cluera/callback?state=<64hex>`; explicit narrow Redirect URL pattern `http://127.0.0.1:43822/cluera/callback\?state=*` preserves the fixed host/port/path, per-attempt state, PKCE S256 and one-shot loopback validation |
| Google Cloud authorized redirect URI | `https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/callback` — not the application's loopback URL |
| Google credentials | Privately configured for this destination; no old secret import through tools or chat |
| Redirect scope | No wildcard origins or unrestricted preview hosts; verify actual hosted matching with the complete generated callback query |
| MFA | TOTP for explicitly authorized destination Admins; no imported old factor, AAL2 claim or session |

Supabase's provider callback and the application's final redirect are distinct. Current upstream redirect validation includes query-aware allowlist matching and special loopback handling; that does not certify this hosted project's exact behavior. Keep strict app-side state/PKCE checks and accept a real destination Google journey before claiming it works. [Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google), [redirect rules](https://supabase.com/docs/guides/auth/redirect-urls), [primary validator](https://github.com/supabase/auth/blob/master/internal/utilities/request.go).

## New owner identity and Admin workflow

No old UUID/role is authoritative in a clean project. After configured destination email delivery and the reviewed application tuple are ready, the owner signs up privately using the designated owner inbox and verifies the latest link in that browser. A normal new user receives only the ordinary once-ever 900-second trial; registration never grants Admin.

Only then may the existing reviewed owner-authorized bootstrap workflow pin the **new** unique, email-verified, active, non-anonymous identity, insert its explicit Admin profile and atomic truthful operator audit. It must target the new project and must not reuse an old actor UUID or impersonate an authenticated grantor. Do not create an Admin from arbitrary metadata or an unverified matching email.

The owner then completes new-project authenticator enrollment/verification privately. This is a different trust domain, not a request to repeat the already accepted old-project setup. Do not ask for it before the clean identity exists. Current-session AAL2 plus live SQL authorization remains mandatory for the protected Admin workspace and sensitive mutations. Wrong/expired/revoked/AAL1 sessions remain denied. [MFA assurance](https://supabase.com/docs/guides/auth/auth-mfa/totp).

## Cluera email branding and SMTP

Use `emails/auth/manifest.json` and the six prepared HTML bodies/subjects **only on the new project**. The HTML retains provider-generated `ConfirmationURL`; reauthentication displays `Token` only in its body. It includes no tracking/remote images, hand-built token URLs or customer metadata interpolation. Support is **clueraaisupport@gmail.com**. Sender display is **Cluera AI**, but the verified sender address/domain is not invented.

Keep email confirmation, secure-email-change behavior, real expiry and anti-enumeration safeguards. Configure verified custom SMTP with privately saved transport credentials, authenticated sender/domain, bounded sending limits and delivery/bounce monitoring. A Gmail support inbox alone is not a verified custom sending domain. Default Supabase SMTP is not production customer delivery; a new Free/default-SMTP project may also be unable to customize templates. Do not buy a plan, disable verification or broaden redirects to bypass that gate. [SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp), [template variables](https://supabase.com/docs/guides/auth/auth-email-templates), [Free-project change](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier).

The current MCP catalog has no Auth/SMTP configuration write operation or private secret-transfer facility. Source publication does not install these hosted settings or send email. When this becomes the essential owner step, provide only the exact new-project dashboard configuration action, never ask for a password, SMTP secret, code or link in chat. Install the matching six subject/body pairs without changing old-project templates. [Template bundle details](CLUERA_EMAIL_BRANDING.md).

## Fresh provider encryption bootstrap and acceptance

Provision a **new**, dedicated cryptographically random 32-byte key-encryption key privately. Use a non-secret ID and canonical base64 keyring JSON: `{ "active": "<key-id>", "keys": { "<key-id>": "<base64 of 32 random bytes>" } }`, itself base64-encoded into **CLUERA_PROVIDER_VAULT_KEYRING_BASE64**. The same new keyring belongs only in Cluera web/relay server settings. Do not reuse Supabase, rate/cookie, release-signing, provider or old vault keys. Protect encrypted offline recovery escrow separately from database backups.

While auth-only/disabled, validate keyring format and a synthetic AES-GCM seal/open round-trip with correct product/provider/credential-UUID binding, including UUID read-back normalization. Verify ciphertext substitution/wrong-key rejection and no secret-bearing DTO/log/artifact. The database contains encrypted envelopes only; browser metadata reads do not return ciphertext or saved keys. Authorized write-only key entry necessarily touches the owner's browser memory; never claim otherwise.

Only after schema, fresh Admin/MFA, encryption custody, modern-key isolation and reviewed mode-switch prerequisites pass may web vault mode and relay admin-vault mode be deliberately selected. Revert to auth-only on failure, never to dummy keys or plaintext/old-key fallback. An Admin saves a **disabled** Gemini credential, performs explicit bounded metadata discovery, chooses a compatible model and enables it under fresh step-up. Repeat for Deepgram. OpenAI/Claude generation, automatic fallback and customer BYOK stay unavailable. No credential is imported or provider called by this guide.

Real authorized acceptance must cover Gemini text/image, both Flux audio channels, cancellation, failures, disable/replacement cache revocation and exact server-authoritative trial/reservation/settlement behavior. Provider metadata discovery is not generation permission, merchant billing evidence or accepted streaming. Environment-held keyrings are not external KMS/HSM custody; managed custody, rewrap/restore drills, authoritative cost telemetry and operational alerts remain production gaps.

## Verification evidence and remaining boundary

The frozen clean vault/release integration plus email selection passes **37/37**, including exact connector-aligned foundation/vault migration-copy checks. This is synthetic PGlite/inert HTML only: no Supabase Auth user, provider call, real key, payment, EXE run or hosted setting is used. Existing Admin bootstrap fixtures also retain their independent guards; local repeated WASM startup timing failures and the final isolated rerun are recorded separately, never relabelled as security acceptance. Pending checks are not passes.

No current owner-only action is issued by this guide. Root execution status identifies the single essential private infrastructure/Auth action after the automatically safe schema checks finish. Do not reconfigure old Admin/MFA, recover old users, disable old keys again, activate payments, grant credits or send provider credentials prematurely.
