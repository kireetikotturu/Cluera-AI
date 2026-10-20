import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {handleAccount} from '../lib/accounts/handler';
import {accountConfig} from '../lib/accounts/config';
import {unseal} from '../lib/accounts/cookies';

const origin='https://cluera-ai-staging.vercel.app',authOrigin='https://yhnqlfcgrmckhyjdxegg.supabase.co';
const uid='00000000-0000-4000-8000-000000000931',sid='00000000-0000-4000-8000-000000000932',factor='00000000-0000-4000-8000-000000000933';
const token=(aal:string,lifetime=3600)=>Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({
 sub:uid,session_id:sid,iss:authOrigin+'/auth/v1',aud:'authenticated',role:'authenticated',aal,exp:Math.floor(Date.now()/1000)+lifetime,
})).toString('base64url')+'.c3ludGhldGlj';
const user={id:uid,email:'sdk-recovery@example.invalid',aud:'authenticated',email_confirmed_at:'2026-10-01T00:00:00Z',
 factors:[{id:factor,factor_type:'totp',status:'verified'}]};
const credentials=(aal:string,lifetime=3600)=>({access_token:token(aal,lifetime),refresh_token:aal==='aal2'?'synthetic-rotated-refresh':'synthetic-recovery-refresh',expires_in:lifetime,token_type:'bearer',user});
let jar:Map<string,string>,calls:{path:string;method:string;aal?:string}[],initialLifetime:number;
beforeEach(()=>{
 for(const [key,value]of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,NEXT_PUBLIC_SUPABASE_URL:authOrigin,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_private_test_double',
  SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
 jar=new Map();calls=[];initialLifetime=3600;
 vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input));expect(url.origin).toBe(authOrigin);const method=init?.method??'GET';
  const authorization=new Headers(init?.headers).get('authorization')??'';
  let aal:string|undefined;try{aal=JSON.parse(Buffer.from(authorization.split('.')[1],'base64url').toString()).aal;}catch{}
  calls.push({path:url.pathname,method,aal});
  if(url.pathname==='/auth/v1/settings')return Response.json({external:{google:true}});
  if(url.pathname==='/rest/v1/rpc/customer_auth_rate_limit')return Response.json(true);
  if(url.pathname==='/rest/v1/rpc/customer_authorize')return Response.json({code:'ACTIVE',userId:uid,trialSecondsGranted:900,remoteDesktop:false});
  if(url.pathname==='/auth/v1/recover')return Response.json({});
  if(url.pathname==='/auth/v1/token'){
   if(url.searchParams.get('grant_type')==='refresh_token')return Response.json({...credentials('aal1'),refresh_token:'synthetic-proactive-rotation'});
   expect(url.searchParams.get('grant_type')).toBe('pkce');return Response.json(credentials('aal1',initialLifetime));
  }
  if(url.pathname==='/auth/v1/user'&&method==='GET')return Response.json(user);
  if(url.pathname==='/auth/v1/user'&&method==='PUT')return aal==='aal2'?Response.json(user)
   :Response.json({code:'insufficient_aal',msg:'PRIVATE_AUTH_REASON'},{status:401,headers:{'x-supabase-api-version':'2024-01-01'}});
  if(url.pathname===`/auth/v1/factors/${factor}/challenge`)return Response.json({id:'00000000-0000-4000-8000-000000000934',type:'totp',expires_at:Math.floor(Date.now()/1000)+300});
  if(url.pathname===`/auth/v1/factors/${factor}/verify`)return Response.json(credentials('aal2'));
  if(url.pathname==='/auth/v1/logout'){expect(url.searchParams.get('scope')).toBe('global');expect(aal).toBe('aal2');return new Response(null,{status:204});}
  throw Error('Unexpected synthetic SDK endpoint');
 }));
});
it('uses real SDK Google PKCE and binds its callback to an ordinary verified session without email or password writes',async()=>{
 const started=await request('google');expect(started.status).toBe(200);
 const redirect=new URL((await started.json()).redirectUrl);
 expect(redirect.origin).toBe(authOrigin);expect(redirect.searchParams.get('provider')).toBe('google');
 expect(redirect.searchParams.get('redirect_to')).toBe(origin+'/api/account/callback');
 expect(redirect.searchParams.get('code_challenge_method')).toBe('s256');
 expect(redirect.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
 expect(jar.has('__Host-sr-account-access')).toBe(false);
 const callback=await request('callback',{},'GET','?code=synthetic-google-code');expect(callback.status).toBe(303);
 const session=await request('session',{},'GET');expect(session.status).toBe(200);
 expect(await session.json()).toMatchObject({account:{userId:uid,email:user.email},passwordRecovery:false});
 expect(calls.filter(x=>x.path==='/auth/v1/token')).toHaveLength(1);
 expect(calls.some(x=>x.path==='/auth/v1/recover'||x.method==='PUT'||x.path.includes('/factors/'))).toBe(false);
 expect(jar.get('__Host-sr-account-flow')).toBe('');
});
it('persists a proactive SDK refresh during a read-only factor preflight without sending a password',async()=>{
 initialLifetime=60;
 expect((await request('forgot-password',{email:user.email})).status).toBe(200);
 expect((await request('callback',{},'GET','?code=synthetic-short-lived-code')).status).toBe(303);
 const before=unseal(jar.get('__Host-sr-account-recovery-lock'),'recovery-lock',accountConfig());
 const security=await request('password-security',{},'GET',`?expectedAccountId=${uid}`);
 expect(security.status).toBe(200);
 expect(unseal(jar.get('__Host-sr-account-refresh'),'refresh',accountConfig())).toBe('synthetic-proactive-rotation');
 expect(unseal(jar.get('__Host-sr-account-recovery-lock'),'recovery-lock',accountConfig())).toEqual(before);
 expect(calls.filter(x=>x.path==='/auth/v1/user'&&x.method==='PUT')).toHaveLength(0);
});
it('preserves SDK rotation when the password write returns MFA_REQUIRED without replaying that write',async()=>{
 initialLifetime=60;
 expect((await request('forgot-password',{email:user.email})).status).toBe(200);
 expect((await request('callback',{},'GET','?code=synthetic-near-expiry-password-code')).status).toBe(303);
 const before=unseal(jar.get('__Host-sr-account-recovery-lock'),'recovery-lock',accountConfig());
 const failed=await request('reset-password',{expectedAccountId:uid,password:'synthetic-new-passphrase'});
 expect(failed.status).toBe(403);expect((await failed.json()).code).toBe('MFA_REQUIRED');
 expect(unseal(jar.get('__Host-sr-account-refresh'),'refresh',accountConfig())).toBe('synthetic-proactive-rotation');
 expect(unseal(jar.get('__Host-sr-account-recovery-lock'),'recovery-lock',accountConfig())).toEqual(before);
 expect(calls.filter(x=>x.path==='/auth/v1/user'&&x.method==='PUT')).toHaveLength(1);
 expect(calls.filter(x=>x.path.endsWith('/challenge')||x.path==='/auth/v1/logout')).toHaveLength(0);
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
async function request(action:string,input:object={},method='POST',query=''){
 const response=await handleAccount(new Request(origin+'/api/account/'+action+query,{method,headers:{origin,'Content-Type':'application/json',
  cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; ')},...(method==='POST'?{body:JSON.stringify(input)}:{})}),action);
 for(const cookie of response.headers.getSetCookie()){
  const pair=cookie.split(';')[0],at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));
 }
 return response;
}
it('real installed SDK recovery → MFA requirement → explicit authenticator → explicit password update preserves the same recovery identity',async()=>{
 expect((await request('forgot-password',{email:user.email})).status).toBe(200);
 expect((await request('callback',{},'GET','?code=synthetic-recovery-code')).status).toBe(303);
 const session=await request('session',{},'GET');expect(session.status).toBe(200);expect((await session.json()).passwordRecovery).toBe(true);
 const before=unseal(jar.get('__Host-sr-account-recovery-lock'),'recovery-lock',accountConfig());
 const failed=await request('reset-password',{expectedAccountId:uid,password:'synthetic-new-passphrase'});
 expect(failed.status).toBe(403);expect((await failed.json()).code).toBe('MFA_REQUIRED');
 const security=await request('password-security',{},'GET',`?expectedAccountId=${uid}`);
 expect(security.status).toBe(200);expect(await security.json()).toEqual({accountId:uid,passwordRecovery:true,recoveryExpired:false,needsMfa:true,factors:[{id:factor,type:'totp'}]});
 expect(calls.filter(x=>x.path.endsWith('/challenge'))).toHaveLength(0);
 const verified=await request('password-mfa',{expectedAccountId:uid,factorId:factor,code:'123456'});
 expect(verified.status).toBe(200);expect(await verified.json()).toEqual({ok:true});
 expect(unseal(jar.get('__Host-sr-account-recovery-lock'),'recovery-lock',accountConfig())).toEqual(before);
 const stillRecovering=await request('session',{},'GET');expect((await stillRecovering.json()).passwordRecovery).toBe(true);
 const ready=await request('password-security',{},'GET',`?expectedAccountId=${uid}`);
 expect(ready.status).toBe(200);expect(await ready.json()).toMatchObject({passwordRecovery:true,recoveryExpired:false,needsMfa:false});
 expect(calls.filter(x=>x.path==='/auth/v1/user'&&x.method==='PUT')).toHaveLength(1);
 const finished=await request('reset-password',{expectedAccountId:uid,password:'synthetic-new-passphrase'});
 expect(finished.status).toBe(200);expect((await finished.json()).sessionsRevoked).toBe(true);
 expect(calls.filter(x=>x.path==='/auth/v1/user'&&x.method==='PUT').map(x=>x.aal)).toEqual(['aal1','aal2']);
 expect(calls.filter(x=>x.path.endsWith('/challenge'))).toHaveLength(1);expect(calls.filter(x=>x.path.endsWith('/verify'))).toHaveLength(1);
 expect(calls.filter(x=>x.path==='/auth/v1/logout')).toHaveLength(1);expect(jar.get('__Host-sr-account-access')).toBe('');
});
