import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {googleAccountLogin,NATIVE_GOOGLE_CALLBACK} from '../src/main/accounts/GoogleAccountLogin';
import {AccountApi} from '../src/main/accounts/AccountApi';
import {AccountSessionManager} from '../src/main/accounts/AccountSessionManager';
it('binds a browser callback to main-only PKCE/state; rejects foreign and malformed callbacks',async()=>{
 const exchange=vi.fn(async()=>({accessToken:'synthetic-access',refreshToken:'synthetic-refresh',userId:'synthetic-user',validForMilliseconds:3600000}));
 let challenge='';
 const result=await googleAccountLogin(async target=>{
  const url=new URL(target);expect(url.origin).toBe('https://yhnqlfcgrmckhyjdxegg.supabase.co');expect(url.pathname).toBe('/auth/v1/authorize');
  expect(url.searchParams.get('provider')).toBe('google');expect(url.searchParams.get('code_challenge_method')).toBe('s256');challenge=url.searchParams.get('code_challenge')!;
  expect((await fetch(`${NATIVE_GOOGLE_CALLBACK}?state=${'x'.repeat(64)}&code=bad`)).status).toBe(400);
  expect((await fetch(`${NATIVE_GOOGLE_CALLBACK}?state=${encodeURIComponent('é'.repeat(64))}&code=bad`)).status).toBe(400);
  const callback=new URL(url.searchParams.get('redirect_to')!);callback.searchParams.set('code','synthetic-one-use-code');
  expect((await fetch(callback,{headers:{origin:'https://untrusted.invalid'}})).status).toBe(400);
  const response=await fetch(callback);expect(response.status).toBe(200);expect(await response.text()).not.toContain('synthetic-one-use-code');
 },new AbortController().signal,{oauthExchange:exchange} as never);
 expect(result.accessToken).toBe('synthetic-access');expect(exchange).toHaveBeenCalledOnce();
 const [code,verifier]=exchange.mock.calls[0] as unknown as [string,string];expect(code).toBe('synthetic-one-use-code');
 expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
});
it('cancellation closes the listener and does not exchange or restore late credentials',async()=>{
 const owner=new AbortController(),exchange=vi.fn();
 await expect(googleAccountLogin(async()=>{owner.abort();},owner.signal,{oauthExchange:exchange} as never)).rejects.toThrow();
 expect(exchange).not.toHaveBeenCalled();
});
it('a browser callback completes desktop login through the real API parser with an opaque refresh token',async()=>{
 const userId='00000000-0000-4000-8000-000000000001';let saved:unknown=null;
 let challenge='';
 const request=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
  if(String(url).endsWith('/oauth-exchange')){
   const body=JSON.parse(String(init?.body));expect(body.code).toBe('synthetic-one-use-code');
   expect(createHash('sha256').update(body.verifier).digest('base64url')).toBe(challenge);
   return new Response(JSON.stringify({userId,accessToken:'synthetic-access-token-only',refreshToken:'abcdefghijkl',validForMilliseconds:3600000}));
  }
  expect(String(url)).toBe('https://cluera-ai-staging.vercel.app/api/account/native/session');
  return new Response(JSON.stringify({account:{userId,email:'google@example.invalid'},usage:{code:'ACTIVE',availableMilliseconds:900000,reservedMilliseconds:0,spentMilliseconds:0}}));
 });
 const api=new AccountApi(request as typeof fetch);
 const manager=new AccountSessionManager({read:async()=>saved,write:async value=>{saved=value;},clear:async()=>{saved=null;}},api);
 try{
  const view=await manager.loginExternal(signal=>googleAccountLogin(async target=>{
   const authorize=new URL(target);challenge=authorize.searchParams.get('code_challenge')!;
   const callback=new URL(authorize.searchParams.get('redirect_to')!);callback.searchParams.set('code','synthetic-one-use-code');
   const response=await fetch(callback);expect(response.status).toBe(200);
   expect(await response.text()).toContain('Return to Cluera');
  },signal,api));
  expect(view).toMatchObject({state:'active',userId});expect(saved).toEqual({version:1,userId,refreshToken:'abcdefghijkl'});
  expect(JSON.stringify(view)).not.toMatch(/abcdefghijkl|synthetic-access|synthetic-one-use-code/);
  expect(request).toHaveBeenCalledTimes(2);
 }finally{manager.dispose();}
});
