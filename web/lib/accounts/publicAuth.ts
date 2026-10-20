import {z} from 'zod';
import {CLUERA_SUPABASE_URL,CLUERA_SITE_ORIGIN} from '../supabase/target';
import {passwordRequirement,weakPasswordNotice} from './passwordPolicy';

// Browser-only DTOs. No tokens, server configuration or raw upstream errors.
export const publicAccountSchema=z.object({userId:z.uuid(),email:z.email().max(254),
 trialSecondsGranted:z.literal(900),remoteDesktop:z.literal(false)}).strict();
export type PublicAccount=z.infer<typeof publicAccountSchema>;
export const publicSessionSchema=z.object({account:publicAccountSchema,passwordRecovery:z.boolean()}).strict();
export const publicLoginSchema=z.object({account:publicAccountSchema}).strict();
export const emailNotice='If this request is eligible, check your email. Open the link in this browser.';
export const signupNotice='Check your email for the next step. If you already have an account, sign in instead.';
export const resendNotice='If your signup needs verification, you’ll receive a new link.';
export const emailDeliveryNotice='Email delivery could not be confirmed. Check your inbox before using resend, or contact Cluera AI support.';
const recoveryAuthenticationNotice='This password-recovery session is no longer valid. Sign out and restart recovery with a new password-reset email, or sign in if your password was already changed.';
export function authFailure(status:number,action?:string,code?:unknown){
 if(action==='signup'&&status===409&&code==='ACCOUNT_EXISTS')return 'An account already exists with this email. Sign in or reset your password.';
 if(action==='login'&&status===403&&code==='EMAIL_NOT_VERIFIED')return 'Verify your email to finish signing in.';
 if(action==='google'&&status===503&&code==='GOOGLE_UNAVAILABLE')return 'Google sign-in is currently unavailable. Sign in with email instead.';
 const passwordAction=['reset-password','change-password','reauthenticate','password-mfa'].includes(action??'');
 if(status===401&&action==='reset-password')return recoveryAuthenticationNotice;
 if(status===400&&code==='WEAK_PASSWORD'&&['signup','reset-password','change-password'].includes(action??''))return weakPasswordNotice;
 if(passwordAction){
  const messages:Record<string,string>={REAUTHENTICATION_REQUIRED:'Request a verification code, then enter the code from your email.',
   INVALID_SECURITY_FIELDS:'Check the current password and verification fields.',
   INVALID_REAUTHENTICATION:'The verification code is invalid or expired. Request a new code only when needed.',
   CURRENT_PASSWORD_REQUIRED:'Enter your current password.',CURRENT_PASSWORD_MISMATCH:'Your current password was not accepted.',
   SAME_PASSWORD:'Choose a new password different from your current password.',
   PASSWORD_UPDATE_REJECTED:'The password update was not accepted. Check the security fields and try again.',
   PASSWORD_UPDATE_UNCERTAIN:'The password-update outcome is unconfirmed. Do not submit again automatically; sign in or use password recovery.',
   AUTHENTICATION_REQUIRED:action==='reset-password'?(status===401?recoveryAuthenticationNotice
     :'The recovery session could not be checked. Check sign-in status before retrying; no password update is confirmed.'):'Verify your session again before changing account security settings.',
   RECOVERY_SESSION_REQUIRED:'Open the latest password-reset email in this browser before resetting your password. If that recovery window expired, sign out and restart recovery explicitly.',
   MFA_REQUIRED:'Verify your existing authenticator below, then enter and submit your password update explicitly.',
   MFA_CODE_INVALID:'That authenticator code was not accepted. Enter the current six-digit code from your authenticator app.',
   MFA_UNAVAILABLE:'Authenticator verification is unavailable. Check password security before trying again.',
   PASSWORD_RECOVERY_ACTIVE:'Finish the password-reset flow before changing ordinary account settings.',
   REAUTHENTICATION_UNAVAILABLE:'A verification code could not be sent. Try again later.'};
  if(typeof code==='string'&&Object.hasOwn(messages,code))return messages[code];
 }
 if(status===503&&code==='EMAIL_DELIVERY_FAILED'&&['signup','resend-verification','forgot-password'].includes(action??''))return emailDeliveryNotice;
 if(status===401)return action==='login'?'Incorrect email or password. Try again or reset your password.':'Sign in with a verified email to continue.';
 if(status===403)return 'This account request is not permitted.';
 if(status===429)return 'Too many requests. Please wait before trying again.';
 if(status===400&&['change-password','reauthenticate'].includes(action??''))return 'Check the account security fields and try again.';
 if(status===400&&['forgot-password','resend-verification'].includes(action??''))return 'Check the email address and request a new link only when needed.';
 if(status===400)return ['signup','reset-password'].includes(action??'')?`Check your email and password. ${passwordRequirement}`:'Check the email and password requirements before continuing.';
 return 'Account service is unavailable.';
}
export function safeGoogleRedirect(raw:unknown){
 const data=z.object({redirectUrl:z.string().max(4096)}).strict().parse(raw);
 const target=new URL(data.redirectUrl);
 const callback=target.searchParams.get('redirect_to');
 if(target.origin!==CLUERA_SUPABASE_URL||target.pathname!=='/auth/v1/authorize'
  ||target.username||target.password||target.hash||target.searchParams.get('provider')!=='google'||!callback
  ||new Set(target.searchParams.keys()).size!==[...target.searchParams.keys()].length)throw new Error('Invalid redirect.');
 const next=new URL(callback);
 if(next.origin!==CLUERA_SITE_ORIGIN||next.pathname!=='/api/account/callback'
  ||next.username||next.password||next.hash||[...next.searchParams.keys()].some(k=>k!=='sb_flow_id')
  ||next.searchParams.getAll('sb_flow_id').length>1
  ||next.searchParams.has('sb_flow_id')&&(!next.searchParams.get('sb_flow_id')||next.searchParams.get('sb_flow_id')!.length>200))throw new Error('Invalid redirect.');
 return target.href;
}
