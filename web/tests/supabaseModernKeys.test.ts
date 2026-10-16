import {afterEach,expect,it,vi} from 'vitest';
import {accountConfig} from '../lib/accounts/config';
import {accountClients} from '../lib/accounts/clients';
afterEach(()=>vi.unstubAllGlobals());

it('supports modern keys in actual per-request clients without confusing application keys and user JWTs',async()=>{
 const publishable='sb_publishable_'+'p'.repeat(40),secret='sb_secret_'+'s'.repeat(40);
 const url='https://yhnqlfcgrmckhyjdxegg.supabase.co',userId='00000000-0000-4000-8000-000000000001',factorId='00000000-0000-4000-8000-000000000003';
 const expiresAt=Math.floor(Date.now()/1000)+3600;
 const accessToken=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),
  Buffer.from(JSON.stringify({sub:userId,session_id:'00000000-0000-4000-8000-000000000002',aud:'authenticated',role:'authenticated',aal:'aal2',exp:expiresAt})).toString('base64url'),
  Buffer.from('sb_secret_synthetic-signature-not-valid-on-any-server').toString('base64url')].join('.');
 const user={id:userId,aud:'authenticated',email:'fixture@example.invalid',factors:[{id:factorId,factor_type:'totp',status:'verified'}]};
 const calls:Array<{path:string;method:string;key:'public'|'server';userJwt:boolean}>=[];
 const request=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const target=new URL(input instanceof Request?input.url:String(input));expect(target.origin).toBe(url);expect(init?.signal).toBeInstanceOf(AbortSignal);
  const headers=new Headers(init?.headers),method=init?.method??(input instanceof Request?input.method:'GET');
  const publicRequest=target.pathname==='/auth/v1/token'||target.pathname==='/auth/v1/user',userRequest=target.pathname==='/auth/v1/user';
  expect(headers.get('apikey')).toBe(publicRequest?publishable:secret);
  expect(headers.get('authorization')).toBe(`Bearer ${userRequest?accessToken:publicRequest?publishable:secret}`);
  calls.push({path:target.pathname,method,key:publicRequest?'public':'server',userJwt:userRequest});
  if(target.pathname==='/auth/v1/token'){
   expect(method).toBe('POST');expect(['password','refresh_token']).toContain(target.searchParams.get('grant_type'));
   return Response.json({access_token:accessToken,refresh_token:'synthetic-refresh',expires_in:3600,expires_at:expiresAt,token_type:'bearer',user});
  }
  if(target.pathname==='/auth/v1/user'){expect(method).toBe('GET');return Response.json(user);}
  if(target.pathname==='/auth/v1/admin/users'){
   expect(method).toBe('GET');expect(target.searchParams.get('page')).toBe('1');expect(target.searchParams.get('per_page')).toBe('1');
   return Response.json({users:[],aud:'authenticated',next_page:null,last_page:1,total:0});
  }
  if(target.pathname==='/rest/v1/customer_accounts'){expect(method).toBe('GET');return Response.json([]);}
  throw Error('Unexpected synthetic SDK route; real fetch is never called.');
 });
 // Install the sole transport before either client. No real auth/write request.
 vi.stubGlobal('fetch',request);
 const clients=accountClients(accountConfig({NODE_ENV:'production',SIGMAROUND_ACCOUNTS_ENABLED:'true',
  SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:publishable,SUPABASE_SERVICE_ROLE_KEY:secret,
  SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,1).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,2).toString('base64')}));
 try{
  expect((await clients.auth.auth.signInWithPassword({email:user.email,password:'synthetic-password-not-real'})).error).toBeNull();
  expect((await clients.auth.auth.refreshSession({refresh_token:'synthetic-refresh'})).error).toBeNull();
  expect((await clients.auth.auth.getUser(accessToken)).error).toBeNull();
  const factors=await clients.auth.auth.mfa.listFactors();expect(factors.error).toBeNull();expect(factors.data?.totp).toHaveLength(1);
  expect((await clients.service.auth.admin.listUsers({page:1,perPage:1})).error).toBeNull();
  expect((await clients.service.from('customer_accounts').select('user_id').limit(1)).error).toBeNull();
  expect(calls).toEqual([
   {path:'/auth/v1/token',method:'POST',key:'public',userJwt:false},{path:'/auth/v1/token',method:'POST',key:'public',userJwt:false},
   {path:'/auth/v1/user',method:'GET',key:'public',userJwt:true},{path:'/auth/v1/user',method:'GET',key:'public',userJwt:true},
   {path:'/auth/v1/admin/users',method:'GET',key:'server',userJwt:false},{path:'/rest/v1/customer_accounts',method:'GET',key:'server',userJwt:false}]);
  expect(request).toHaveBeenCalledTimes(6);expect(JSON.stringify(clients.flow())).not.toContain('synthetic-refresh');
 }finally{await clients.auth.auth.stopAutoRefresh();await clients.service.auth.stopAutoRefresh();}
});
