import {expect,it} from 'vitest';
import {authFailure,publicSessionSchema,safeGoogleRedirect} from '../lib/accounts/publicAuth';
const url='https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/authorize?provider=google&redirect_to='+encodeURIComponent('https://cluera-ai-staging.vercel.app/api/account/callback?sb_flow_id=synthetic');
it('accepts only a bounded fixed Supabase Google redirect to the Cluera callback',()=>{
 expect(safeGoogleRedirect({redirectUrl:url})).toBe(url);
 for(const redirectUrl of ['javascript:alert(1)',url.replace('yhnqlfcgrmckhyjdxegg','foreign'),url.replace('provider=google','provider=github'),url.replace('cluera-ai-staging','evil'),url+'#fragment'])expect(()=>safeGoogleRedirect({redirectUrl})).toThrow();
 expect(()=>safeGoogleRedirect({redirectUrl:url,access_token:'synthetic'})).toThrow();
});
it('rejects secret-bearing, wrong-product and malformed session DTOs',()=>{
 const account={userId:'00000000-0000-4000-8000-000000000001',email:'fixture@example.invalid',trialSecondsGranted:900,remoteDesktop:false};
 expect(publicSessionSchema.safeParse({account,passwordRecovery:false}).success).toBe(true);
 for(const value of [{account:{...account,access_token:'synthetic'},passwordRecovery:false},{account:{...account,remoteDesktop:true},passwordRecovery:false},{account:{...account,trialSecondsGranted:999},passwordRecovery:false},{account,passwordRecovery:'true'}])expect(publicSessionSchema.safeParse(value).success).toBe(false);
 expect(authFailure(503)).toBe('Account service is unavailable.');expect(authFailure(429)).toContain('wait');
});
