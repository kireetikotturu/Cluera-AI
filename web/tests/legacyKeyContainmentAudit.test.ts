import {createRequire} from 'node:module';
import {expect,it,vi} from 'vitest';
const {run,SETTINGS,EMPTY_READ}=createRequire(import.meta.url)('../../scripts/security/audit-legacy-key-containment.cjs');
const jwt=(role='anon',ref='dwqltsqumiwsxtkzdoaa')=>Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role,ref})).toString('base64url')+'.c3ludGhldGlj';
const input={legacyPublicKey:jwt(),modernPublicKey:'sb_publishable_'+'x'.repeat(32)};
function fixture(mode='validated'){
 return vi.fn(async(url:string,init:RequestInit)=>{
  const h=new Headers(init.headers),bearer=h.get('authorization');
  if(url===SETTINGS)return h.get('apikey')===input.legacyPublicKey
   ?Response.json({message:'private-upstream-marker'},{status:401})
   :Response.json({external:{google:true},private:'private-upstream-marker'});
  if(url!==EMPTY_READ)throw Error('Unexpected target');
  if(bearer&&bearer!=='Bearer '+input.legacyPublicKey)return Response.json({code:'PGRST301',message:'private-upstream-marker'},{status:401});
  if(bearer&&mode==='rejected')return Response.json({code:'PGRST303'},{status:401});
  if(mode==='inconclusive')return Response.json({code:'PGRST202'},{status:404});
  return Response.json({code:'42501',message:'private-upstream-marker'},{status:401});
 });
}
it.each(['validated','rejected','inconclusive'])('reports public bearer evidence but never privileged clearance (%s)',async mode=>{
 const f=fixture(mode),r=await run(input,f);
 expect(r).toMatchObject({configurationAccepted:true,legacyApiKeyRejected:true,modernPublishableAccepted:true,legacyPublicBearerPath:mode,privilegedBearerContainment:'unverified',readOnlyRequests:5,mutations:0});
 expect(JSON.stringify(r)).not.toMatch(/private-upstream-marker|sb_publishable_|Bearer |eyJ/);
 expect(JSON.stringify(r)).not.toContain(input.legacyPublicKey);
 expect(JSON.stringify(r)).not.toContain(input.modernPublicKey);
 for(const [url,init] of f.mock.calls){expect([SETTINGS,EMPTY_READ]).toContain(url);
  expect(init).toMatchObject({method:'GET',redirect:'manual',credentials:'omit',cache:'no-store'});
  expect(init.body).toBeUndefined();expect(new Headers(init.headers).has('cookie')).toBe(false);}
 const auth=f.mock.calls.slice(2).map(([,i])=>new Headers(i.headers).get('authorization'));
 expect(auth[0]).toBeNull();expect(auth[1]).toBe('Bearer '+input.legacyPublicKey);
 expect(auth[2]).not.toBe(auth[1]);expect(auth[2]!.split('.')[2].slice(1)).toBe(input.legacyPublicKey.split('.')[2].slice(1));
});
it('does not infer JWT validation when the endpoint ignores the invalid bearer control',async()=>{
 const normal=fixture(),f=vi.fn(async(url:string,init:RequestInit)=>url===EMPTY_READ
  ?Response.json({code:'42501'},{status:401}):normal(url,init));
 const r=await run(input,f);expect(r.legacyPublicBearerPath).toBe('inconclusive');
 expect(r.privilegedBearerContainment).toBe('unverified');
});
it('does not report API-key disable when the legacy settings request still succeeds',async()=>{
 const normal=fixture(),f=vi.fn(async(url:string,init:RequestInit)=>url===SETTINGS
  ?Response.json({external:{}}):normal(url,init));
 const r=await run(input,f);expect(r.legacyApiKeyRejected).toBe(false);
 expect(r.privilegedBearerContainment).toBe('unverified');
});
it.each([{...input,legacyPublicKey:jwt('service_role')},{...input,legacyPublicKey:jwt('anon','aaaaaaaaaaaaaaaaaaaa')},
 {...input,modernPublicKey:'sb_secret_'+'s'.repeat(32)},{...input,legacyPublicKey:'malformed'},
 {...input,target:'https://foreign.invalid'}])('rejects privileged, foreign, malformed or target-changing input before network',async value=>{
 const f=fixture(),r=await run(value,f);expect(r.configurationAccepted).toBe(false);
 expect(r.readOnlyRequests).toBe(0);expect(f).not.toHaveBeenCalled();expect(r.privilegedBearerContainment).toBe('unverified');
});
it.each(['redirect','oversized','html','malformed','transport'])('fails closed without reflecting upstream data (%s)',async mode=>{
 const f=vi.fn(async()=>{
  if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.invalid'}});
  if(mode==='oversized')return Response.json({external:{},private:'x'.repeat(65537)});
  if(mode==='html')return new Response('private-upstream-marker');
  if(mode==='malformed')return new Response('private-upstream-marker',{headers:{'content-type':'application/json'}});
  throw Error('private-upstream-marker');
 });
 const r=await run(input,f);expect(r.modernPublishableAccepted).toBe(false);
 expect(r.legacyPublicBearerPath).toBe('inconclusive');expect(r.privilegedBearerContainment).toBe('unverified');
 expect(JSON.stringify(r)).not.toMatch(/private-upstream-marker|foreign.invalid|sb_publishable_|eyJ/);expect(f).toHaveBeenCalledTimes(2);
});
