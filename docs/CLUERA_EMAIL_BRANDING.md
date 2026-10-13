# Email and Auth branding handoff

Prepared only; no shared Supabase Auth/SMTP/template settings or email sends changed.

Use sender display **Cluera AI**, but retain the currently verified SMTP sender address/domain. Do not invent a cluera.ai mailbox/domain or replace a Google client. The retained backend is shared with the old Account rollback client: global email-brand edits affect both and need deliberate owner review.

For confirmation and password recovery, retain Supabase's signed ConfirmationURL and permitted RedirectTo behavior. Do not embed a service secret, token value, old default SiteURL override or a client-generated confirmation URL. Add the exact new website/native redirects without removing old entries. Confirm native state-query matching under Supabase's redirect rules.

Suggested reusable body (choose the action-specific heading in the correct Supabase template):

```html
<div style="font-family:Arial,sans-serif;background:#101522;color:#edf1fc;padding:32px;border-radius:16px">
  <p style="color:#b8a7ef;font-weight:bold">Cluera AI</p>
  <h1>Continue to your interview workspace</h1>
  <p>Use the secure action below to confirm the request you initiated.</p>
  <a href="{{ .ConfirmationURL }}" style="background:#b8a7ef;color:#101522;padding:12px 20px;border-radius:8px;display:inline-block">Continue securely</a>
  <p>If you did not request this, do not open the link.</p>
  <p>Support: sigmaroundsupport@gmail.com. Never send passwords, tokens or payment details.</p>
</div>
```

Keep action-specific expiry and security wording from the existing approved templates. Templates/SMTP delivery, actual signup verification and password recovery remain owner/authenticated acceptance; this file does not claim they were deployed or tested with real email.
