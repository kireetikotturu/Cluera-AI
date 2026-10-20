import {expect,it} from 'vitest';
import {authFailure,publicSessionSchema,safeGoogleRedirect,signupNotice,emailDeliveryNotice} from '../lib/accounts/publicAuth';
import {MIN_PASSWORD_LENGTH,MAX_PASSWORD_LENGTH,weakPasswordNotice} from '../lib/accounts/passwordPolicy';
const url='https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/authorize?provider=google&redirect_to='+encodeURIComponent('https://cluera-ai-staging.vercel.app/api/account/callback?sb_flow_id=synthetic');
it('accepts only a bounded fixed Supabase Google redirect to the Cluera callback',()=>{
 expect(safeGoogleRedirect({redirectUrl:url})).toBe(url);
 for(const redirectUrl of ['javascript:alert(1)',url.replace('yhnqlfcgrmckhyjdxegg','foreign'),url.replace('provider=google','provider=github'),url.replace('cluera-ai-staging','evil'),url+'#fragment'])expect(()=>safeGoogleRedirect({redirectUrl})).toThrow();
 expect(()=>safeGoogleRedirect({redirectUrl:url,access_token:'synthetic'})).toThrow();
 for(const redirectUrl of [url+'&provider=github',url+'&redirect_to=https%3A%2F%2Fevil.invalid',url.replace('sb_flow_id%3Dsynthetic','sb_flow_id%3Dsynthetic%26sb_flow_id%3Dother'),url.replace('sb_flow_id%3Dsynthetic','sb_flow_id%3D')])expect(()=>safeGoogleRedirect({redirectUrl})).toThrow();
});
it('rejects secret-bearing, wrong-product and malformed session DTOs',()=>{
 const account={userId:'00000000-0000-4000-8000-000000000001',email:'fixture@example.invalid',trialSecondsGranted:900,remoteDesktop:false};
 expect(publicSessionSchema.safeParse({account,passwordRecovery:false}).success).toBe(true);
 for(const value of [{account:{...account,access_token:'synthetic'},passwordRecovery:false},{account:{...account,remoteDesktop:true},passwordRecovery:false},{account:{...account,trialSecondsGranted:999},passwordRecovery:false},{account,passwordRecovery:'true'}])expect(publicSessionSchema.safeParse(value).success).toBe(false);
 expect(authFailure(503)).toBe('Account service is unavailable.');expect(authFailure(429)).toContain('wait');
});
it('shares the eight-to-128-character policy and displays only allowlisted contextual failure codes',()=>{
 expect([MIN_PASSWORD_LENGTH,MAX_PASSWORD_LENGTH]).toEqual([8,128]);
 expect(signupNotice).toBe('Check your email for the next step. If you already have an account, sign in instead.');
 expect(authFailure(400,'signup','WEAK_PASSWORD')).toBe(weakPasswordNotice);
 expect(authFailure(503,'signup','EMAIL_DELIVERY_FAILED')).toBe(emailDeliveryNotice);
 expect(authFailure(503,'login','EMAIL_DELIVERY_FAILED')).toBe('Account service is unavailable.');
 expect(authFailure(400,'signup','PRIVATE_UPSTREAM_DETAIL')).not.toContain('PRIVATE_UPSTREAM_DETAIL');
 expect(authFailure(400,'reset-password')).toContain('8 to 128');
 expect(authFailure(409,'signup','ACCOUNT_EXISTS')).toContain('already exists');
 expect(authFailure(403,'login','EMAIL_NOT_VERIFIED')).toContain('Verify your email');
 expect(authFailure(409,'forgot-password','ACCOUNT_EXISTS')).not.toContain('already exists');
});
