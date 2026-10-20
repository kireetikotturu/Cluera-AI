# Cluera account and Google sign-in

Updated October 20, 2026. This guide applies only to [Cluera staging](https://cluera-ai-staging.vercel.app/account) and Supabase project `yhnqlfcgrmckhyjdxegg`. SMTP, Supabase app keys/URLs and the existing Admin/MFA enrollment are already configured. Do not repeat them.

## Account flow

| Task | Expected behavior |
| --- | --- |
| Sign in | Email/password, Create account and Forgot password. Help stays collapsed. Google appears only when the provider is enabled. |
| Create account | Submit once, then see Check your email, a masked recipient and an explicit resend timer. Open the newest verification link in the requesting browser. |
| Existing account | An explicit provider duplicate response returns to sign-in with “An account already exists with this email.” Supabase may instead deliberately return a neutral success; the app does not infer account existence from that response. |
| Unverified sign-in | An explicit provider `email_not_confirmed` response offers the verification form with the email retained. It does not send another email automatically. |
| Forgot password | Request a reset link, open the newest link in the same browser, complete an existing authenticator check if required, then choose a new password. Successful update signs this browser out and asks for a new sign-in. |
| Already verified email | Use Sign in or Forgot password. Signup verification is not password recovery, and requesting verification for an already verified account may send no email. |
| Account authorization | The server validates the current identity and live session. Recovery cannot open the workspace or Admin. Admin requires its protected role plus MFA; an email address or browser metadata never grants that role. |

The email timer prevents accidental repeat requests; it cannot prove inbox delivery. Real signup/reset delivery and new-password sign-in require private owner acceptance. Use [authentication acceptance](CLUERA_AUTHENTICATION_ACCEPTANCE.md), without repeating completed setup.

## Remaining private Google setup

1. Open [Google Auth Platform clients](https://console.cloud.google.com/auth/clients) in the intended Google Cloud project. Reuse the correct **Web application** client if it exists. Configure:

   | Field | Exact value |
   | --- | --- |
   | Authorized JavaScript origin | `https://cluera-ai-staging.vercel.app` |
   | Authorized redirect URI | `https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/callback` |

2. In Google Auth Platform, complete Branding with the Cluera name, support contact and actual privacy/terms details. In Audience, keep the intended staging/testing audience and add the Google accounts that will test consent. Request only `openid`, email and profile. Publishing the consent app or expanding its audience is a separate owner decision.

3. Open [Supabase Google provider](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/providers?provider=Google). Privately save that client's ID and secret and enable Google. Do not paste the secret into chat, source files, browser code or Vercel variables. Keep the provider's nonce validation enabled.

4. The existing [Supabase Auth URL configuration](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/url-configuration) should already contain these values. Verify only if a redirect fails:

   | Field | Value |
   | --- | --- |
   | Site URL | `https://cluera-ai-staging.vercel.app` |
   | Web return | `https://cluera-ai-staging.vercel.app/api/account/callback` |
   | Desktop return pattern | `http://127.0.0.1:43822/cluera/callback\?state=*` |

   Google returns to Supabase; Supabase then returns to Cluera. The Cluera web and loopback URLs belong in Supabase's allowlist, not Google's authorized redirect URI. Do not broaden the web allowlist to a wildcard.

5. Reload [Account](https://cluera-ai-staging.vercel.app/account). **Continue with Google** appears when the live capability check reports enabled; no separate Cluera feature flag is needed. Accept one real consent/sign-in, reload, sign out and test cancellation. If entering from a selected plan, check the return destination without purchasing. For an existing verified email, confirm the same customer UUID and original once-only trial; do not manually merge accounts or grant another trial to make a test pass.

6. Accept Windows Google return/sign-out/account switching on a tested build containing the current source. The retained immutable 1.0.7 installer predates later desktop fixes and has not been rebuilt by this web follow-up.

If Google reports `redirect_uri_mismatch`, compare the Google redirect with the exact Supabase callback above. If access is limited, check the consent audience and test users. If the button stays hidden after enablement, check the provider saved successfully and reload; `/api/account/auth-options` must return `{"google":"enabled"}`. Do not expose credentials while diagnosing.

## Verification and remaining limits

Automated tests use synthetic identities and intercepted provider requests. They cover the installed Supabase SDK's Google PKCE authorization, S256 challenge, callback exchange, sealed session restoration, wrong/duplicate redirect rejection, password recovery, MFA and account isolation. These tests do not complete private Google consent or prove email delivery.

Google remains disabled until the private setup above is completed. The existing Supabase leaked-password-protection warning also remains an owner security/plan decision; do not purchase a plan implicitly. Commercial launch, financial/provider activation and public Windows distribution retain their separate gates in [the final launch checklist](CLUERA_FINAL_LAUNCH_CHECKLIST.md).

Provider references: [Google integration](https://supabase.com/docs/guides/auth/social-login/auth-google), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [signup behavior](https://supabase.com/docs/reference/javascript/auth-signup).
