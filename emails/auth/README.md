# Cluera AI authentication email bundle

Prepared source only. These files are not imported by the web/desktop/relay, and publishing or deploying Cluera does not install Supabase email templates or send email.

Use [manifest.json](manifest.json) for the exact template, subject and Auth configuration field mapping. The five link templates preserve Supabase's complete `{{ .ConfirmationURL }}`. Reauthentication deliberately displays `{{ .Token }}` instead; it is not an MFA enrollment template. No actual link, code or recipient is stored here.

The self-contained HTML uses a fluid single-column layout, inline styles, descriptive action text and a plain-text brand mark. It requests no images, fonts, tracking pixels, scripts, forms or external stylesheets. The only links are the provider-generated action and `mailto:clueraaisupport@gmail.com`. There is no marketing or payment link.

These are presentation assets, not new application features. Including magic-link/invite/email-change/reauthentication templates does not add corresponding customer UI, enable provider settings, grant Admin access or bypass existing Auth/MFA checks.

The shared backend also serves temporary old Account clients. Do not install this bundle, change SMTP, alter Site URL/redirects or enable notification settings by running a Cluera deployment. Follow the exact shared-project review and future installation/rollback boundary in [the email handoff](../../docs/CLUERA_EMAIL_BRANDING.md).

Local synthetic verification:

```powershell
Set-Location web
npm.cmd test -- tests/clueraEmailTemplates.test.ts
```

The tests parse inert HTML with synthetic links/codes and check field mappings, action semantics, request-local callback preservation, mobile-friendly structure and absence of active/remote content. They do not send messages, run Go templates, prove real inbox delivery or certify every email client's rendering.
