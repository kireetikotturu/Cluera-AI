# Cluera AI authentication email bundle

October17 current: owner reports signup email received and the new-project support identity is independently verified. Do not repeat signup/SMTP/template/key/URL saves. The signup feedback repair is deployed; source minimum8 and owner's Supabase save agree by report. Hosted sender headers/HTML and the remaining five templates are not independently accepted. Next is new-project Admin MFA only: [current execution/action](../../docs/CLUERA_EXECUTION_STATUS.md). Older pre-signup instructions below are historical. No template body or email-send behavior is changed by this result record.

October 16 clean setup: both `manifest.json` and `manifest.cluera-production.json` target only **yhnqlfcgrmckhyjdxegg**. They reuse the six exact HTML bodies. Owner reports only **Confirm sign up** saved; the remaining five are prepared, not accepted installed. Follow [clean Auth/provider setup](../../docs/CLUERA_CLEAN_AUTH_PROVIDER_SETUP.md), not historical shared-project installation instructions. No old SMTP/OAuth secret, Auth setting, identity or role is transferred.

Prepared source only. These files are not imported by the web/desktop/relay, and publishing or deploying Cluera does not install Supabase email templates or send email.

Use [manifest.json](manifest.json) for the exact template, subject and Auth configuration field mapping. The five link templates preserve Supabase's complete `{{ .ConfirmationURL }}`. Reauthentication deliberately displays `{{ .Token }}` instead; it is not an MFA enrollment template. No actual link, code or recipient is stored here.

The self-contained HTML uses a fluid single-column layout, inline styles, descriptive action text and a plain-text brand mark. It requests no images, fonts, tracking pixels, scripts, forms or external stylesheets. The only links are the provider-generated action and `mailto:clueraaisupport@gmail.com`. There is no marketing or payment link.

These are presentation assets, not new application features. Including magic-link/invite/email-change/reauthentication templates does not add corresponding customer UI, enable provider settings, grant Admin access or bypass existing Auth/MFA checks.

Only new independent **yhnqlfcgrmckhyjdxegg** is in current scope; shared-project instructions are superseded. New keys/Auth URLs, App Password/SMTP and Confirm sign up template saving are completed owner-reported steps; no credential belongs in these files or chat. Temporary support/From is **clueraaisupport@gmail.com**, exact display **Cluera AI**. Saved signup subject **Confirm your Cluera AI email**, exact raw [confirm-signup.html](confirm-signup.html) with **{{ .ConfirmationURL }}** retained by instruction. No hosted-body read-back or actual delivery is claimed. Next is one private same-browser signup on the now-verified canonical staging site: [complete handoff/stop conditions](../../docs/CLUERA_TEMPORARY_GMAIL_SMTP.md). Leave other templates/settings unchanged; no agent send/resend. A deployment does not install this bundle. Preserve callbacks, verification, notifications, old projects, License Edition and features.

Local synthetic verification:

```powershell
Set-Location web
npm.cmd test -- tests/clueraEmailTemplates.test.ts
```

The tests parse inert HTML with synthetic links/codes and check field mappings, action semantics, request-local callback preservation, mobile-friendly structure and absence of active/remote content. They do not send messages, run Go templates, prove real inbox delivery or certify every email client's rendering.
