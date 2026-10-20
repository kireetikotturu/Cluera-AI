'use client';

/** Support links carry no account fields, callback URLs, tokens or credentials.
 * Checking status is an explicit session read; this component sends no email. */
export function AccountAuthHelp({signedIn,recovery,busy,checking,onCheckStatus}:{signedIn:boolean;recovery:boolean;busy:boolean;checking:boolean;onCheckStatus:()=>void}){
 return <aside className="account-auth-help" aria-label="Account access help">
  <h3>Need help with your account?</h3>
  <button className="button secondary" type="button" disabled={busy} onClick={onCheckStatus}>{checking?'Checking sign-in status…':'Check sign-in status'}</button>
  <details><summary>Verification and password-reset email help</summary>
   <p>Check your inbox and spam folder. Use the latest link in the same browser where you requested it. An older link, a different browser or an expired request may not work.</p>
   <p>No email is resent automatically. Wait for the request timer, then deliberately request a new link if needed. Signup verification is for an unverified signup; an already verified account may receive no verification email. Sign in or use Forgot password to request a password-reset link instead.</p>
   <p>If your account uses an authenticator, password updates can also require its current six-digit code. That authenticator code is separate from an emailed reauthentication code. A password-reset email does not remove two-factor protection.</p>
   {recovery?<p>If the recovery request expired, sign out of this browser and explicitly request a new password-reset email.</p>
    :signedIn?<p>Use Account security to change your password. To request a forgotten-password link instead, sign out of this browser first.</p>:null}
  </details>
  <p>Still need help? Contact <a href="mailto:clueraaisupport@gmail.com">Cluera support</a> with the page and the fixed message shown here. Never send passwords, verification codes, email links or payment details.</p>
 </aside>;
}
