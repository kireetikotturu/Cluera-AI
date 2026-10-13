import {z} from 'zod';

// Browser-only DTOs. No tokens, server configuration or raw upstream errors.
export const publicAccountSchema=z.object({userId:z.uuid(),email:z.email().max(254),
 trialSecondsGranted:z.literal(900),remoteDesktop:z.literal(false)}).strict();
export type PublicAccount=z.infer<typeof publicAccountSchema>;
export const publicSessionSchema=z.object({account:publicAccountSchema,passwordRecovery:z.boolean()}).strict();
export const publicLoginSchema=z.object({account:publicAccountSchema}).strict();
export const emailNotice='If this request is eligible, check your email. Open the link in this browser.';
export function authFailure(status:number){
 if(status===401)return 'Sign in with a verified email to continue.';
 if(status===403)return 'This account request is not permitted.';
 if(status===429)return 'Too many requests. Please wait before trying again.';
 if(status===400)return 'Check the email and password requirements before continuing.';
 return 'Account service is unavailable.';
}
export function safeGoogleRedirect(raw:unknown){
 const data=z.object({redirectUrl:z.string().max(4096)}).strict().parse(raw);
 const target=new URL(data.redirectUrl);
 const callback=target.searchParams.get('redirect_to');
 if(target.origin!=='https://dwqltsqumiwsxtkzdoaa.supabase.co'||target.pathname!=='/auth/v1/authorize'
  ||target.username||target.password||target.hash||target.searchParams.get('provider')!=='google'||!callback)throw new Error('Invalid redirect.');
 const next=new URL(callback);
 if(next.origin!=='https://cluera-ai-staging.vercel.app'||next.pathname!=='/api/account/callback'
  ||next.username||next.password||next.hash||[...next.searchParams.keys()].some(k=>k!=='sb_flow_id'))throw new Error('Invalid redirect.');
 return target.href;
}
