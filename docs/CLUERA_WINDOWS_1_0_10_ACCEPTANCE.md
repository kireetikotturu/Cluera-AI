# Windows 1.0.10: session repair and private acceptance

October 24, 2026. **Local unsigned TEST candidate built and verified; public release and real AI end-to-end acceptance remain pending.** No website/relay deployment, provider secret, payment, grant, catalog, purchaser list or Live flag was changed by this desktop repair. Existing features and the original 15-minute trial policy are retained.

**Later provider setup follow-up, 06:06 UTC:** the owner authorized central Gemini/Deepgram setup. A dedicated keyring is now provisioned on the existing Vercel/Render services, with an encrypted Windows recovery copy; the hosted envelope check and signed relay `admin-vault` observation passed. Do not generate or install another keyring. Owner API key entry, model approval and real device acceptance remain necessary. Follow [the current Admin-to-desktop steps](CLUERA_AI_ENABLEMENT.md), which supersede the infrastructure steps below. The 1.0.10 EXE is unchanged.

## Installer

| Item | Value |
| --- | --- |
| EXE | `desktop/release-cluera-staging/1.0.10/ClueraAITestSetup-1.0.10.exe` |
| Size | 122,144,878 bytes |
| SHA-256 | `3d50fee02abc0995833fa6fe52b31e91dee64fb424f3ef83ba0bb9406587068f` |
| Blockmap | 129,565 bytes; SHA-256 `adcb05e72a662d39beb9dc3fbe4e7f0792eb6325ef312fe0b2085a902210fcfb` |
| Signature | Authenticode NotSigned; TEST only |
| Dependencies | Electron 44.9.1; Zod 4.6.6; locked desktop audit reports zero vulnerabilities |

The retained 1.0.8 installer was rehashed unchanged. Version 1.0.9 failed while downloading Electron checksum metadata with `ECONNRESET`; its directory is retained and it is not a release. Version 1.0.10 verifies the archive using checksums supplied by the lockfile-pinned Electron package. Checksum verification remains enabled. No installer was run or installed by the agent.

## What was fixed

- Create Session now immediately displays **Checking…**, prevents duplicate entry clicks and shows a progress message.
- Failed setup checks focus and scroll the error into view. An empty model catalog explains that the administrator must configure providers. An unavailable transcription model is rejected before opening the workspace.
- The read-only setup check settles after ten seconds. A late response cannot navigate or overwrite the catalog after that timeout. No AI request is automatically retried.
- The session footer now accurately states that saving opens a workspace whose audio device check uses account time. The existing automatic audio device check and explicit AI Start controls are preserved.

The trial is **900 seconds of shared, cumulative server-metered usage per account**, not 15 minutes per new session or installation. Two devices share that allowance. Paid allowances retain their existing policy. An open audio device check can consume time even before AI interaction is enabled; end the session to close its provider connections. No trial, balance or paid record was reset.

## Verified evidence and limits

- Full desktop suite: **430 passed / one opt-in skip**. The four new regressions failed before the repair and passed afterward. Final focused rerun after version/configuration changes: 11 passed (overlaps the full suite).
- Server synthetic suites: **81 shared usage/relay tests**, **57 provider vault/usage tests**, and **7 Test/Live bank tests** passed. These include exhaustion across sessions, no regenerated trial, provider cancellation, and mode isolation. Three packaging contract tests passed.
- Typechecks and release code build passed. Package verification compared **97 compiled files and three trust resources**, examined **2,387 ASAR entries**, and verified six Electron fuses.
- The EXE was extracted without executing it. **123 payload files** matched the verified unpacked build. Its embedded ASAR header hash, **2,054 file hashes and 2,057 block hashes** passed.
- Built-renderer browser checks passed **26 assertions** across login, session entry, validation, one synthetic save and blocked synthetic provider startup. The footer fits 420×360, 800×600, 1000×600 and 1280×800. Zero page errors, zero external provider calls and only loopback GETs. All account/desktop bridges were synthetic.
- Final source scan: 859 files, zero findings. Build artifact scan: 98 files, passed. All **275 existing desktop source entries** were compared with accepted source `646a3a32d24cc90527f2d8ccd5204ced75fcbfd9`: nine reviewed paths changed, 266 retained. One regression test and the browser script changes supplement that comparison. These changes are local; this is not a new hosted CI or deployment claim.

## Why real session creation is still blocked

Read-only observations at **05:34:44 and 05:59:26 UTC** found **zero provider records, zero enabled providers and zero enabled models**. Gemini and Deepgram catalog rows were disabled/unverified. Vault-disabled/auth-only and missing-keyring observations from the desktop repair are now superseded by the hosted bootstrap above. The owner confirms both provider keys are available for private entry; infrastructure readiness does not create those provider credentials or approve models.

An EXE update cannot supply missing server credentials. The repaired client reports this condition instead of appearing inert. Successful mocks do not establish a real Gemini response, Deepgram audio, physical-device capture or real usage settlement.

## Remaining private steps

1. **Keyring provisioning is complete.** Preserve the existing dedicated keyring and save its independent encrypted recovery copy using [the recovery instructions](CLUERA_AI_ENABLEMENT.md#owner-steps-recovery-copy). The local DPAPI copy requires the original Windows account and is not portable disaster recovery. Do not generate another keyring or reapply the existing schema.
2. **Vault mode and telemetry configuration are complete in the later provider follow-up.** The application encryption round-trip and authenticated relay mode check passed. Keep Live payment flags off. Verify Admin vault metadata before entering provider keys; the exact current deployment evidence belongs in [the enablement record](CLUERA_AI_ENABLEMENT.md#verification-record).
3. In [Cluera Admin](https://cluera-ai-staging.vercel.app/account/admin) → **AI Providers & Models**, select **Refresh vault**, then **Load existing authenticators**. For Google Gemini and Deepgram Flux, use **Add / replace key (disables provider)** with private key entry and fresh MFA. Then use **Test metadata access / discover models**. Select only a verified, runtime-compatible model. The account model catalog must independently approve/enable the corresponding models. Do not fabricate a model ID when discovery fails.
4. Render provider telemetry is now configured. Before actual provider activation, set suitable provider-side usage alerts/limits for the first trial, then explicitly enable Gemini and Deepgram and approve the existing matching model rows. Metadata discovery alone does not establish working audio/text or spending acceptance. Use [the current enablement steps](CLUERA_AI_ENABLEMENT.md).
5. Privately install the exact candidate after checking its hash. Restart/sign in, verify the existing balance, create one session with all required context, and exercise text, screenshot, both audio channels, cancellation, end-session settlement and the shared trial limit. Do not purchase another pack to repair an AI setup failure. Verify logout/account isolation and an update from the retained installer on the owner's Windows device.
6. Only after that acceptance, approve immutable artifact hosting and the exact Admin release record. Automatic update delivery and public download remain pending. Do not overwrite 1.0.8, reuse 1.0.9, reset balances or enable Live sales as part of these checks.
