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
export const signupNotice='Verification email sent! Please check your inbox and click the verification link to activate your Cluera AI account.';
export const emailDeliveryNotice='Email delivery could not be confirmed. Check your inbox before using resend, or contact Cluera AI support.';
export function authFailure(status:number,action?:string,code?:unknown){
 if(status===400&&code==='WEAK_PASSWORD'&&['signup','reset-password'].includes(action??''))return weakPasswordNotice;
 if(status===503&&code==='EMAIL_DELIVERY_FAILED'&&['signup','resend-verification','forgot-password'].includes(action??''))return emailDeliveryNotice;
 if(status===401)return 'Sign in with a verified email to continue.';
 if(status===403)return 'This account request is not permitted.';
 if(status===429)return 'Too many requests. Please wait before trying again.';
 if(status===400)return ['signup','reset-password'].includes(action??'')?`Check your email and password. ${passwordRequirement}`:'Check the email and password requirements before continuing.';
 return 'Account service is unavailable.';
}
export function safeGoogleRedirect(raw:unknown){
 const data=z.object({redirectUrl:z.string().max(4096)}).strict().parse(raw);
 const target=new URL(data.redirectUrl);
 const callback=target.searchParams.get('redirect_to');
 if(target.origin!==CLUERA_SUPABASE_URL||target.pathname!=='/auth/v1/authorize'
  ||target.username||target.password||target.hash||target.searchParams.get('provider')!=='google'||!callback)throw new Error('Invalid redirect.');
 const next=new URL(callback);
 if(next.origin!==CLUERA_SITE_ORIGIN||next.pathname!=='/api/account/callback'
  ||next.username||next.password||next.hash||[...next.searchParams.keys()].some(k=>k!=='sb_flow_id'))throw new Error('Invalid redirect.');
 return target.href;
}
