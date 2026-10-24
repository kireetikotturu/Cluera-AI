# Enable Gemini and Deepgram for Cluera desktop

October 24, 2026. **The shared server vault and repaired Admin screen are deployed on the existing Cluera staging services.** Provider keys must be entered privately by the owner in Admin. Live payments remain disabled. A pending ₹549 payment is a separate billing issue; do not purchase again to repair AI configuration.

## What is connected

Admin saves provider keys as encrypted envelopes. The Render relay decrypts them only in server memory and uses the existing Gemini and Deepgram adapters. Desktop signs in with its Cluera account and receives approved model metadata, never provider keys. All active accounts use this central setup subject to their existing balance. The free trial remains **900 seconds total per account**, shared across sessions and devices; this is not unlimited provider usage.

The dedicated keyring `cluera-20261024-01` was generated with a cryptographic random source, protected with the owner's Windows DPAPI, and verified using the application's real envelope encryption/decryption code, including rejection of a different provider identity. The same value was saved to Vercel as Sensitive/Production for the **existing staging project** and to the existing Render service. Vercel vault enablement and Render `admin-vault` mode/usage telemetry were configured. Preview remains off. No schema reinstall is required. Deployment verification is recorded below.

The Admin repair gives immediate progress and action-specific results, distinguishes rejected authentication from unknown outcomes, and bounds a stalled request/body to 15 seconds. A late response cannot unlock an uncertain change. The code and key clear deliberately for privacy; read the result message. The provider cards now show the separate model approval requirement and link to the existing model registry. No model or credential is automatically enabled by saving a key.

## Owner steps: keys and model approval

1. Open [Cluera Admin](https://cluera-ai-staging.vercel.app/account/admin), complete your existing Admin MFA, and select **Providers → AI Providers & Models**. Click **Refresh vault**, then **Load existing authenticators**. A successful refresh permits private key entry. If it reports bootstrap unavailable, stop and report only that message.
2. On **Google Gemini**, choose **Add / replace key (disables provider)**. Enter your Gemini key in the password field, select your existing authenticator, enter its current six-digit code, and click **Confirm audited change** once. Wait for **Encrypted key saved**. Repeat for **Deepgram Flux** with its own key and a fresh code. Never enter keys in desktop Settings or send them in chat.
3. For each saved provider, choose **Test metadata access / discover models**, enter a fresh code and confirm. Require `VERIFIED`, a complete listing and a compatible model. The implemented defaults are Gemini `gemini-3.5-flash` and Deepgram `flux-general-en`. If either is absent, do not invent an ID or substitute a different model: report the metadata status and compatible model names only. Discovery performs metadata GETs; it does not establish generation/audio permission, quota or successful billing. [Gemini model API](https://ai.google.dev/api/models), [Deepgram model API](https://developers.deepgram.com/reference/manage/models/list).
4. Use your provider dashboards to set suitable usage alerts/limits for this first trial. Then choose **Save enablement / default model**, select the verified compatible default, tick **Enable this provider**, enter a fresh code and confirm for each provider. These are shared owner-funded keys: real Gemini responses and Deepgram audio may incur provider charges. Replacement later disables the provider again until retested.
5. Open **Models → AI model registry**. Select the existing Gemini row, keep its ID, enable it, make it Default, retain text and screenshot/image support, enter an audit reason and save. Do the same for the existing Deepgram `flux-general-en` row with internal audio support. Keep **Declared health = UNVERIFIED** until real device acceptance succeeds; this label is not a live test. Use the existing rows rather than creating duplicates. These controls already use authenticated, audited Admin changes.
6. Return to Providers and refresh. Each card must show enabled provider and approved model settings. A snapshot is not proof of a successful AI request. If a change says **result unknown**, use **Verify pending change**; never re-enter the key simply because the code field cleared. A definitive authentication rejection permits a new manual attempt with a fresh code.

## Owner steps: recovery copy

An encrypted local recovery file is at `.local-secrets/provider-vault-owner/keyring.dpapi`. It is protected for the original Windows account, excluded from source publication, and **is not portable disaster recovery**. Save an independent copy in your encrypted password manager before relying on the vault:

From the `products/cluera-ai` folder, in your own private PowerShell window, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\copy-cluera-vault-recovery.ps1
```

This copies the existing keyring to the clipboard without printing it, generating a replacement or contacting a server. Paste it directly into your encrypted password manager, then run `Set-Clipboard -Value ""`. Keep clipboard history/cloud synchronization off during this private operation. Do not paste it into chat, screenshots or a repository file. Never generate another keyring to fix an error: saved provider credentials need the original decrypt key. No provider API key is stored in this recovery file.

## Desktop acceptance

Use the verified [Windows 1.0.10 TEST candidate](CLUERA_WINDOWS_1_0_10_ACCEPTANCE.md), restart the app to clear its model cache, and sign in with an existing active account that has remaining trial or accepted paid time. No desktop API key entry or new installer is needed for provider configuration changes.

Create one session with the required title, company, role, resume, job description and supporting context. Confirm the workspace opens. Its existing automatic audio device check opens provider connections and consumes account time; use **End session** when finished. Verify one text reply, one screenshot question, microphone and system audio transcription, cancellation, End session, then website/desktop balance refresh. Confirm time is shared with a second device, stops at exhaustion and is not recreated by a new session or reinstall. A used-up trial must remain used up.

The support account's retained ₹549 order stays pending reconciliation. It must not be retried or manually credited as part of AI setup. The alternate existing account may use its own remaining trial; changing accounts does not transfer that order or reset either trial.

Real provider responses, both physical audio channels and usage settlement must be accepted before calling this end to end complete or approving public installer distribution. Live payment activation is outside this work.

## Verification record

| Evidence | Result |
| --- | --- |
| Reviewed source | [`29576c430a7083c991bdefe4130a0e575fd89f82`](https://github.com/kireetikotturu/Cluera-AI/commit/29576c430a7083c991bdefe4130a0e575fd89f82), tree `17b1e63cd31cd048131de18b6977c6ad61f0825c`: 851 source blobs; three existing paths changed, two scripts added, 846 prior blobs retained unchanged, no deletions. Local desktop 1.0.10 changes were not published by this follow-up. |
| Full hosted CI | [40068794479](https://github.com/kireetikotturu/Cluera-AI/actions/runs/40068794479), success for the exact source: web/relay and desktop jobs, preparation checks, source scan, typechecks, builds and dependency audits all pass. |
| Website | `dpl_8mJQFw7dTVADhiuNMY8Nzu77rhHG`, READY, exact source; canonical `cluera-ai-staging.vercel.app` assigned after full CI and independently read back. The bounded 100 build events contained no error-level entries. |
| Relay | `dep-dbe4l561egvs73fflri0`, LIVE, exact source. Error-level log query for 06:03:00–06:06:30 UTC returned no entries; this is a bounded observation, not continuous-uptime acceptance. |
| Hosted bootstrap | Protected diagnostic `dpl_4ArDB3uiyriWV8SqQgWrrzw66YA1`, **06:06:28.314 UTC**: configured keyring validates, synthetic envelope round-trip passes, wrong-provider identity is refused, authenticated relay mode is `admin-vault`. Zero provider calls or financial mutations. It deliberately exits with code 2 and produces no site artifact or alias; its diagnostic build error is expected and separate from passing site/CI builds. |
| Local checks | 55 vault/Admin/model, 91 relay/usage/Admin and 63 shared-ledger/navigation/database tests passed (distinct selections); web typecheck passed. The existing encrypted Windows recovery copy was decrypted and compared in memory, and the recovery helper parses successfully without touching the clipboard. |
| Browser | Built-source synthetic browser flow saves/tests/configures both providers with six intercepted POSTs, checks independent model approval, and clears private entry fields. Desktop 1440px and mobile 390px layouts have no overflow or page errors. Zero real mutations or provider calls. The first fixture mixed two React installations and failed; it was corrected to use the web application's React and styles before passing. |
| Public boundaries | Final canonical checks: **16/16** public GET boundaries at 06:11:44 UTC; **10/10** Live-disabled routes at 06:11:50 UTC; **3/3** provider boundaries at 06:12:13 UTC, including anonymous denial of vault/factor reads and strict public-only desktop model metadata. All are read-only checks. |
| Preserved financial boundary | At **06:10:44 UTC**, SELECT-only readback shows Test spending bank and Live intake, checkout and native gates false. Provider usage start/finish counts are both zero. No payment, grant, purchaser list, price, trial or installer was changed. |

At that same 06:10:44 UTC observation, the vault has **zero provider records** and both model rows are still disabled. Infrastructure readiness does not claim owner key entry, real Gemini replies, Deepgram audio or physical-device settlement. Those remain the private acceptance steps above. The real encryption test used a synthetic payload and did not save a provider credential. The unsigned 1.0.10 installer and its hash remain unchanged; it is still a local TEST candidate.

A documentation-only follow-up may advance staging/Render while retaining every runtime and dependency blob from the reviewed source. The canonical website and successful full CI remain pinned to `29576c430a7083c991bdefe4130a0e575fd89f82`.
