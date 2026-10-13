# Cluera staging private setup
Only new Cluera resources. Do not modify old Account or License services.

## October 13 current owner boundary — infrastructure not ready

Complete reviewed source **473ef8d373f30f2354763524136828531a5fa7cd** is deployed as **READY dpl_EJyo5Fg9Tm6EBM7kxenph3YQSfDP**, stable Cluera alias/exact new project verified. New Render same-SHA auto-build still fails configuration validation. No environment setting was changed in this phase. Vault mode is not operational; do not submit provider keys until its separate bootstrap/schema approval is complete.

The owner saved the four Cluera cookie/rate/signing settings and added callbacks, but explicitly answered **Not ready yet** for the missing infrastructure settings. Fresh Vercel metadata still lacks `SUPABASE_SERVICE_ROLE_KEY`; current Auth/Admin/credits/release 503 responses fail at that actual configuration boundary. Do not repeat the four completed values or callbacks, decrypt old-service settings, or use dummy keys.

The new [Admin provider vault](CLUERA_AI_PROVIDER_VAULT.md) is source/test-covered only; its [schema proposal](proposals/cluera-provider-vault.sql) is unapplied and requires separate explicit approval. No credential migration, root keyring provisioning or feature enablement has occurred. Keep `CLUERA_PROVIDER_VAULT_ENABLED` absent/false until approved bootstrap. No Live/OpenAI/Claude/fallback activation.

**Next owner action:** privately save retained `SUPABASE_SERVICE_ROLE_KEY` in **new** Cluera Vercel as Sensitive/Production-only, and save it plus the **same new Cluera rate secret** in **new** Render; set `/healthz`. After reviewed source deployment, select `CLUERA_AI_BOOTSTRAP_MODE=auth-only` in this new relay and redeploy. This mode validates real infrastructure, denies AI/provider START without inventing credentials, and does not require Gemini/Deepgram environment keys. Say only **Cluera infrastructure saved privately**. Do not pay or send keys.

This supersedes the legacy Gemini/Deepgram environment-key instruction below for the requested new vault workflow. Existing explicit `legacy-environment` source remains compatible; no old-service key/settings change is authorized. The earlier instruction to apply the Cluera release registry automatically is also superseded: **any schema application now needs separate approval**, including the unapplied release registry.

## Vercel
Project **prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B / cluera-ai-staging**, team team_AksnPXhi2VBXI5UsY2xBIakc, private kireetikotturu/Cluera-AI. Complete repository; web root; Node24; npm ci; npm run build; source outside root allowed within this repository. No files-only diagnostic/redeployment source. Production means ONLY this new staging project's named environment.

Config: SIGMAROUND_ACCOUNTS_ENABLED=true; SIGMAROUND_ACCOUNT_ORIGIN=https://cluera-ai-staging.vercel.app; NEXT_PUBLIC_SUPABASE_URL=https://dwqltsqumiwsxtkzdoaa.supabase.co; enabled publishable public key in NEXT_PUBLIC_SUPABASE_ANON_KEY (never service_role); RELEASE_DOWNLOAD_ORIGINS=https://github.com.
Keep CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED=false; SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED=false; SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED=false; SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED=false. Do not add payment secrets, tester overrides, workers or cron.

Owner privately saves existing retained project's SUPABASE_SERVICE_ROLE_KEY as Sensitive Production-only (no secret rotation), plus all four entries from ignored **.local-secrets/cluera-vercel-settings.private.txt**. The public signing entry is DER/SPKI base64, not PEM base64. This is the current prepared copy; the earlier unused cluera-owner-settings.private.txt is obsolete and must not be used. Keep both private files/backups protected; no values in chat/Git/installer.
Cookie/rate settings are NEW Cluera-only32-byte values; do not reuse old cookie secrets. New signing private key matches the installer public pin. No NEXT_PUBLIC server secret.

## Render
Created **srv-db6r6som7kps73b1r4g0 / cluera-ai-relay-staging**, [dashboard](https://dashboard.render.com/web/srv-db6r6som7kps73b1r4g0). Owner approved only My Workspace tea-cvht5mdrie7s73eafmb0, free Singapore. Private repository staging branch, Dockerfile backend/Dockerfile, repository-root context, port10000,0.0.0.0. No database/worker/cron/disk or paid upgrade. Set this new service health-check path to /healthz. Current Docker build passes but startup fails closed pending private values.

Config SIGMAROUND_ACCOUNT_RELAY_ENABLED=true; SIGMAROUND_ACCOUNTS_ENABLED=true; same fixed new website origin/retained Supabase URL.
Privately save SUPABASE_SERVICE_ROLE_KEY and existing intended staging SIGMAROUND_MANAGED_GEMINI_API_KEY / SIGMAROUND_MANAGED_DEEPGRAM_API_KEY. Copy the SAME new SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64 used in new Vercel; no old relay modification. Missing private configuration deliberately prevents relay startup; do not substitute demo or unauthenticated streaming.

## Retained Supabase Auth
Add only https://cluera-ai-staging.vercel.app/api/account/callback and the native http://127.0.0.1:43822/cluera/callback return (preserve its state query as required by Supabase's matching rules). Preserve all existing callback entries and Site URL. Existing Google provider/Cloud client setup need not be repeated. No admin role grant/MFA change is authorized.

Prepare reviewed Cluera email display/template branding, preserve anti-enumeration, use the supplied RedirectTo/confirmation URL rather than forcing old SiteURL. SMTP/provider consent/configuration remains owner-only; no remote template edit has occurred.

Tell the agent only: **Cluera private staging settings and callback additions saved**. It will inspect metadata/private categorical checks, re-deploy complete reviewed source, verify hosted boundaries/relay and apply only the additive Cluera release registry after fresh preservation checks. Do not sign in/pay merely to bypass an engineering failure. No release upload/approval or Test payment now.

