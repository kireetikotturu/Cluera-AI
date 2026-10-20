'use client';

/** Support links carry no account fields, callback URLs, tokens or credentials.
 * Checking status is an explicit session read; this component sends no email. */
export function AccountAuthHelp({signedIn,recovery,busy,checking,onCheckStatus,onVerifyEmail}:{signedIn:boolean;recovery:boolean;busy:boolean;checking:boolean;onCheckStatus:()=>void;onVerifyEmail?:()=>void}){
 return <aside className="account-auth-help" aria-label="Account access help">
  <details><summary>Need help?</summary>
   <p>Check your inbox and spam folder. Open the latest email link in the browser where you requested it.</p>
   {!signedIn?<><p>Already have an account? Sign in or use Forgot password. Signup verification is only for an unverified account.</p>
    {onVerifyEmail?<button type="button" disabled={busy} onClick={onVerifyEmail}>Verify signup email</button>:null}</>:null}
   {recovery?<p>An expired reset link needs a new recovery request. If prompted, use your existing authenticator app’s code.</p>
    :signedIn?<p>Use Account security to change your password.</p>:null}
   <button className="button secondary" type="button" disabled={busy} onClick={onCheckStatus}>{checking?'Checking sign-in status…':'Check sign-in status'}</button>
   <p>Contact <a href="mailto:clueraaisupport@gmail.com">Cluera support</a> if you’re stuck. Never share passwords, codes or email links.</p>
  </details>
 </aside>;
}
