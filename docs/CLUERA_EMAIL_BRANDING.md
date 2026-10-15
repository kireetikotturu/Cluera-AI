# Cluera email and Auth branding

Updated October 15, 2026. **Complete local template bundle; hosted installation and real delivery remain unaccepted.** No shared Supabase Auth/SMTP setting, callback, Site URL, rate limit or notification switch was changed, and no email was sent.

## Prepared templates

[The six self-contained HTML files and subject/field manifest](../emails/auth/README.md) cover:

| Supabase Auth template | Local file | Subject |
| --- | --- | --- |
| Confirm sign up | `emails/auth/confirm-signup.html` | Confirm your Cluera AI email |
| Reset password | `emails/auth/recovery.html` | Reset your Cluera AI password |
| Magic link | `emails/auth/magic-link.html` | Your Cluera AI sign-in link |
| Invite user | `emails/auth/invite.html` | Your Cluera AI invitation |
| Change email address | `emails/auth/email-change.html` | Confirm your Cluera AI email change |
| Reauthentication | `emails/auth/reauthentication.html` | Your Cluera AI verification code |

The dark, single-column design uses inline styles, readable contrast, descriptive actions and a text brand mark. It needs no hosted image/font, tracking pixel, script or form. Support is **clueraaisupport@gmail.com**, not the old support address. No verified sender address/domain is invented; the future sender display is **Cluera AI**, retaining the currently verified SMTP address unless separately reviewed.

Five link templates retain the complete provider-generated `{{ .ConfirmationURL }}`. Reauthentication uses `{{ .Token }}` in the body, not the subject. There is no hand-built token URL, SiteURL substitution, user-metadata brand decision or email-address interpolation. Signup/recovery copy preserves latest-link/same-browser PKCE guidance; email-change copy does not override any two-address confirmation policy. The installed Auth handler, encrypted flow cookie, exact callback, live-session authorization and recovery fencing are untouched. [Supabase template variables](https://supabase.com/docs/guides/auth/auth-email-templates).

Providing an invitation/magic-link/email-change template does not enable that application feature, send invitations, assign roles or grant time. Existing security-notification bodies and enabled states remain unchanged; this bundle is not a reason to disable them.

## Shared-project boundary and installation readiness

Templates belong to retained project **dwqltsqumiwsxtkzdoaa**, not to an individual Vercel deployment. Installing them would rebrand future messages for Cluera and temporary old Account clients using that same Auth project. It would not migrate customers or change passwords, balances or payment rows, but it is a shared Auth presentation change. This is why publication/deployment of these files deliberately does not install them. Existing old redirects, native callbacks, SMTP identity and transport behavior must remain operational. No License project is targeted.

Actual hosted template bodies/subjects, SMTP transport, verified sender and template-edit eligibility were not retrieved or certified. Current Supabase documentation says new Free projects on default SMTP cannot customize templates after June 3, 2026; grandfathered, paid or custom-SMTP cases differ. Do not assume this retained project's eligibility or purchase an upgrade. [Official change](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier).

Supabase's default SMTP is intended for limited testing, not customer delivery. A verified custom SMTP provider, actual sending limits, domain authentication and delivery/bounce monitoring require a separate deployment-readiness check. Keep email confirmation enabled. Do not disable confirmation, invent an address/domain, increase limits or import SMTP credentials to work around a failed send. Link tracking can rewrite Auth URLs and should not wrap these actions. [SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp), [link-tracking warning](https://supabase.com/docs/guides/auth/auth-email-templates#email-tracking).

## Future exact controlled installation and rollback

**No manual installation is requested while the security Support case is pending.** Admin login/MFA, infrastructure saving and legacy API-key disabling are already complete and must not be repeated.

When incident containment and shared-template change scope are accepted:

1. Privately retain the current six subjects/bodies and current verified sender configuration for rollback. Do not copy SMTP credentials, real links/codes or customer emails into the repository or chat. Confirm edit eligibility without changing plans or transport.
2. In this retained project's **Authentication -> Email -> Templates**, replace only the matching subject and HTML body from `emails/auth/manifest.json`, one template at a time. Do not edit Site URL, redirect allowlist, OAuth clients, secure-email-change policy, expiry, notifications or any other setting. If eligibility blocks a save, stop; do not broaden the operation to SMTP or a paid plan.
3. Only with explicitly authorized test-email acceptance, use a controlled inbox and normal private browser: signup/latest verification, password recovery/sign-out, old callback compatibility and expected wrong-browser/expired-link denial. Test other flows only if already exposed/authorized by the application. Never send codes, links or passwords to the agent. A template save alone is not delivery/Auth acceptance.
4. If wording/rendering causes a confirmed regression, restore only the saved subject/body for that template. If delivery fails, stop further sends and diagnose transport; never bypass Auth or change callback trust as a formatting rollback. Retain sending/provider error categories without bodies or credentials.

The Cluera callback remains `https://cluera-ai-staging.vercel.app/api/account/callback`; temporary old/native callbacks remain as currently configured. Templates must neither force the Cluera hostname into a provider URL nor add wildcard redirects. [Redirect handling](https://supabase.com/docs/guides/auth/redirect-urls).

## Verification scope

`web/tests/clueraEmailTemplates.test.ts` checks all six manifest mappings, minimal placeholders, action-specific copy, semantic structure, fluid layout constraints and no active/remote content. Synthetic provider links preserve both Cluera and temporary old Account callbacks, including an existing `sb_flow_id`, byte-for-byte after HTML decoding. Reauthentication verifies the synthetic body code without a subject/URL leak.

Fresh local focused verification: **25/25 passed**, one file, October 15 at approximately **22:19:49 IST**. An initial suite stopped before executing tests because jsdom/Vite rewrote a file-URL fixture path; resolving the fixture through Node's path APIs fixed the harness. No assertion, deadline or security setting was relaxed.

These tests perform no HTTP request, Auth mutation, email send or database write. They are not a Go-template engine run, a real-email rendering certification, inbox delivery, signup, recovery, MFA or production SMTP acceptance. Pending/skipped checks are not passes.
